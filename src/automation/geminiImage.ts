import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { captureErrorSnapshot, captureSnapshot } from "./aiVideo";
import {
  GeminiError,
  openGeminiPage,
  readSnackbarText,
  sendAndWaitWithRetry,
  uploadFile,
} from "./geminiAI";
import { getGeminiImageBrowserContext } from "./geminiBrowser";
import { geminiResponseContentLocator } from "./geminiSelectors";

/**
 * Theo yêu cầu người dùng: tạo ảnh bằng Gemini web (gemini.google.com — model
 * ảnh "Nano Banana" ngay trong khung chat). Clone generateReferenceImage
 * (chatAIImage.ts, ChatGPT), nhưng ảnh luôn tải về config.downloadDir (tên
 * jobId) như generateImagePollo. Session/Chrome RIÊNG (getGeminiImageBrowserContext,
 * tài khoản Google khác với askGemini — theo yêu cầu người dùng), dùng chung
 * các bước mở trang/upload/gửi/chờ trả lời (geminiAI.ts).
 *
 * LƯU Ý: selector ảnh kết quả (generatedImageLocator) + nút tải ảnh gốc CHƯA
 * xác nhận qua debug DOM thật của dự án — lỗi thì xem snapshot
 * storage/debug/<jobId>.html.
 */

export interface GenerateGeminiImageResult {
  path: string;
  /** Id hội thoại Gemini (phần cuối URL "/app/<id>") — undefined nếu không trích được. */
  sessionId?: string;
}

/** Chờ tối đa ảnh trong câu trả lời tải xong (sau khi Gemini đã trả lời xong). */
const IMAGE_LOAD_TIMEOUT_MS = 90_000;
/** Chu kỳ log + chụp snapshot debug trong lúc chờ tạo ảnh. */
const IMAGE_DEBUG_EVERY_MS = 15_000;

/**
 * Ảnh do Gemini tạo trong 1 lượt trả lời — thẻ <generated-image>/<single-image>
 * bọc <img> (ảnh preview, src googleusercontent). Loại trừ avatar/icon nhỏ.
 */
function generatedImageLocator(response: Locator): Locator {
  // DOM thật: <generated-image> > <single-image> > ... > <img class="image animate loaded" src="blob:...">
  return response.locator("generated-image img.image, single-image img.image, generated-image img");
}

/**
 * Nút "Tải hình ảnh có kích thước đầy đủ xuống" của ĐÚNG ảnh đó — DOM thật
 * (người dùng gửi): data-test-id nằm ở <gem-icon-button> bọc ngoài, <button>
 * thật bên trong có aria-label; cả cụm nằm trong <single-image> của ảnh.
 */
function downloadFullSizeButtonLocator(image: Locator): Locator {
  const container = image.locator("xpath=ancestor::single-image[1]");
  return container
    .locator('[data-test-id="download-generated-image-button"] button')
    .or(container.getByRole("button", { name: /tải hình ảnh.*xuống|download full.?size/i }));
}

function extractGeminiSessionId(url: string): string | undefined {
  return url.match(/\/app\/([a-zA-Z0-9]+)/)?.[1];
}

function imageExtensionFromContentType(contentType: string | undefined): string {
  if (!contentType) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return ".png";
}

/** Chờ ít nhất 1 ảnh kết quả đã load (naturalWidth > 0), trả về locator ảnh đó. */
async function waitForGeneratedImage(
  page: Page,
  response: Locator,
  jobId: string,
): Promise<Locator | null> {
  const start = Date.now();
  const deadline = start + IMAGE_LOAD_TIMEOUT_MS;
  let nextDebugAt = start + IMAGE_DEBUG_EVERY_MS;
  while (Date.now() < deadline) {
    if (Date.now() >= nextDebugAt) {
      nextDebugAt += IMAGE_DEBUG_EVERY_MS;
      const elapsed = Math.round((Date.now() - start) / 1000);
      const total = await generatedImageLocator(response).count().catch(() => 0);
      console.log(
        `[geminiImage] (${jobId}) [debug ${elapsed}s] chờ ảnh tải xong — đã thấy ${total} thẻ ảnh trong câu trả lời.`,
      );
      await captureSnapshot(
        page,
        `${jobId}_gemini-image-load-${elapsed}s`,
        `gemini-image-load-${elapsed}s`,
        { fullPage: false },
      );
    }
    const images = generatedImageLocator(response);
    const count = await images.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const image = images.nth(i);
      const loaded = await image
        .evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 64)
        .catch(() => false);
      if (loaded) return image;
    }
    await page.waitForTimeout(2000);
  }
  return null;
}

/**
 * Lưu ảnh: ưu tiên nút tải ảnh gốc (bắt sự kiện download); không được thì tải
 * thẳng src của <img> bằng request của chính context (có cookie đăng nhập).
 */
async function saveGeneratedImage(
  page: Page,
  image: Locator,
  destDir: string,
  baseFileName: string,
  jobId: string,
): Promise<string> {
  await fs.promises.mkdir(destDir, { recursive: true });

  try {
    // Thanh nút chỉ hiện khi rê chuột lên ảnh — hover trước, vẫn ẩn thì force.
    await image.hover({ timeout: 5000 }).catch(() => {});
    const button = downloadFullSizeButtonLocator(image).first();
    if ((await button.count().catch(() => 0)) > 0) {
      const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
      downloadPromise.catch(() => {});
      await button.click({ force: true, timeout: 10_000 });
      // Nút có kèm <mat-menu> — nếu bấm mở menu chọn kiểu tải thay vì tải
      // ngay, chọn mục đầu tiên.
      await page.waitForTimeout(2000);
      const menuItem = page.locator('.mat-mdc-menu-panel [role="menuitem"]').first();
      if (await menuItem.isVisible().catch(() => false)) {
        await menuItem.click().catch(() => {});
      }
      const download = await downloadPromise;
      const ext = path.extname(download.suggestedFilename()) || ".png";
      const destPath = path.join(destDir, `${baseFileName}${ext}`);
      await download.saveAs(destPath);
      return destPath;
    }
  } catch (err) {
    console.warn(
      `[geminiImage] (${jobId}) tải ảnh gốc qua nút Download lỗi — chuyển sang tải src ảnh:`,
      err instanceof Error ? err.message : err,
    );
  }

  const src = await image.getAttribute("src");
  if (!src) throw new GeminiError("Ảnh Gemini tạo không có src để tải.");
  // DOM thật: src dạng "blob:https://gemini.google.com/<uuid>" — chỉ đọc được
  // TRONG trang (request của context không tải được blob URL). Đây là ảnh
  // preview đang hiển thị, có thể nhỏ hơn bản "kích thước đầy đủ".
  if (src.startsWith("blob:")) {
    const blob = await image.evaluate(async (el) => {
      const response = await fetch((el as HTMLImageElement).src);
      const data = await response.blob();
      const bytes = new Uint8Array(await data.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { type: data.type, base64: btoa(binary) };
    });
    const destPath = path.join(destDir, `${baseFileName}${imageExtensionFromContentType(blob.type)}`);
    await fs.promises.writeFile(destPath, Buffer.from(blob.base64, "base64"));
    console.warn(`[geminiImage] (${jobId}) đã lưu ảnh preview (blob) — không tải được bản kích thước đầy đủ.`);
    return destPath;
  }
  if (src.startsWith("data:")) {
    const [, meta, data] = src.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/) ?? [];
    if (!data) throw new GeminiError("Không đọc được ảnh dạng data URL.");
    const destPath = path.join(destDir, `${baseFileName}${imageExtensionFromContentType(meta)}`);
    await fs.promises.writeFile(destPath, Buffer.from(data, "base64"));
    return destPath;
  }
  const response = await page.context().request.get(src, { timeout: 60_000 });
  if (!response.ok()) {
    throw new GeminiError(`Tải ảnh Gemini thất bại: HTTP ${response.status()}.`);
  }
  const destPath = path.join(
    destDir,
    `${baseFileName}${imageExtensionFromContentType(response.headers()["content-type"])}`,
  );
  await fs.promises.writeFile(destPath, await response.body());
  return destPath;
}

async function attemptGenerateImageGemini(
  prompt: string,
  jobId: string,
  refImagePaths?: string[],
): Promise<GenerateGeminiImageResult> {
  const page = await openGeminiPage(jobId, getGeminiImageBrowserContext);
  try {
    for (const refPath of refImagePaths ?? []) {
      await uploadFile(page, refPath, jobId);
    }
    // Cùng cách bọc prompt với bản ChatGPT (attemptGenerateReferenceImage) —
    // gõ thẳng prompt dễ bị Gemini hiểu là câu hỏi/mô tả, trả lời bằng chữ.
    const refNote =
      refImagePaths && refImagePaths.length > 0
        ? " Dùng các ảnh đính kèm làm tham chiếu (giữ đúng ngoại hình nhân vật/bối cảnh trong ảnh)."
        : "";
    const instruction = `Tạo 1 ảnh minh hoạ theo ĐÚNG NGUYÊN VĂN mô tả sau đây (dùng chính xác mô tả này làm prompt vẽ ảnh, không hỏi lại, không diễn giải lại bằng lời, không thêm bớt nội dung).${refNote}\n\n${prompt}`;

    // Theo yêu cầu người dùng: debug mỗi 15s trong lúc chờ Gemini tạo ảnh.
    const response = await sendAndWaitWithRetry(page, instruction, jobId, {
      attachmentPaths: refImagePaths,
      debugEveryMs: IMAGE_DEBUG_EVERY_MS,
      debugLabel: "gemini-image-wait",
    });
    const image = await waitForGeneratedImage(page, response, jobId);
    if (!image) {
      const text = (
        await geminiResponseContentLocator(response).innerText().catch(() => "")
      )
        .replace(/\s+/g, " ")
        .trim();
      throw new GeminiError(
        `Gemini không tạo ảnh (không thấy ảnh trong câu trả lời).${text ? ` Gemini trả lời: "${text.slice(0, 300)}"` : ""}${await readSnackbarText(page)}`,
      );
    }
    // Theo yêu cầu người dùng: luôn tải về config.downloadDir, tên = jobId (cùng
    // quy ước tên tạm của generateImagePollo) — nơi gọi tự chuyển file vào
    // đúng chỗ (vd storage/generated/<phim>/<id>.png).
    const savedPath = await saveGeneratedImage(page, image, config.downloadDir, jobId, jobId);
    console.log(`[geminiImage] (${jobId}) đã lưu ảnh: ${savedPath}`);
    return { path: savedPath, sessionId: extractGeminiSessionId(page.url()) };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GeminiError
      ? err
      : new GeminiError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
    // Theo yêu cầu người dùng: tạo xong mỗi ảnh thì đóng luôn Chrome tạo ảnh
    // (close() tự lưu session trước khi đóng — xem persistSession).
    await getGeminiImageBrowserContext.close();
  }
}

/** Chỉ 1 lượt tạo ảnh Gemini tại 1 thời điểm — cùng lý do enqueueImageGeneration (chatAIImage.ts). */
let geminiImageQueue: Promise<unknown> = Promise.resolve();
function enqueueGeminiImage<T>(task: () => Promise<T>): Promise<T> {
  const result = geminiImageQueue.then(task, task);
  geminiImageQueue = result.catch(() => {});
  return result;
}

/**
 * Tạo 1 ảnh bằng Gemini theo prompt (+ ảnh tham chiếu tuỳ chọn), tải về
 * config.downloadDir/<jobId>.<đuôi thật> — nơi gọi tự rename/move file vào
 * đúng chỗ (giống generateImagePollo).
 */
export async function generateImageGemini(
  prompt: string,
  jobId: string,
  refImagePaths?: string[],
): Promise<GenerateGeminiImageResult> {
  return enqueueGeminiImage(() =>
    attemptGenerateImageGemini(prompt, jobId, refImagePaths),
  );
}
