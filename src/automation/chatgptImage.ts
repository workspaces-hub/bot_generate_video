import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatGptBrowserContext,
} from "./chatgptBrowser";
import {
  assistantMessageLocator,
  fileUploadInputLocator,
  promptTextareaCandidates,
  regenerateErrorButtonCandidates,
  sendButtonCandidates,
  signInIndicatorCandidates,
  stopGeneratingButtonCandidates,
} from "./chatgptSelectors";
import { firstVisible } from "./selectors";
// captureSnapshot/captureErrorSnapshot đã tổng quát (chỉ cần Page + jobId),
// dùng lại nguyên bản thay vì viết trùng cho chatgpt.com (cùng cách chatgpt.ts đã làm).
import { captureErrorSnapshot, captureSnapshot } from "./hailuo";

export class ChatGptImageError extends Error {}

/**
 * Xoá sạch nội dung ô nhập rồi gõ lại "text" qua page.keyboard.insertText()
 * — KHÔNG dùng textarea.fill() (xem lý do chi tiết ở insertPromptText trong
 * chatgpt.ts, job 463abed5: fill() không đồng bộ được state nội bộ của
 * ProseMirror, khiến nút Send không bao giờ hiện dù DOM đã có đúng text).
 */
async function insertPromptText(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

/**
 * Ảnh GPT tạo ra hiện trong tin nhắn trả lời — DOM thật xác nhận (job
 * 24b9cf53): KHÔNG phải domain oaiusercontent.com như phỏng đoán ban đầu, mà
 * ảnh được phục vụ qua chính domain chatgpt.com, URL đã ký sẵn dạng
 * `https://chatgpt.com/backend-api/estuary/content?id=...&sig=...` (CÙNG
 * endpoint /backend-api/estuary/content đã dùng cho file đính kèm ở
 * chatgptSelectors.ts) — kèm alt text thật luôn có tiền tố "Generated image:".
 * Giữ `img[alt]` chung chung làm fallback phòng khi GPT không kèm tiền tố đó.
 */
const generatedImageLocator = (message: Locator): Locator =>
  message.locator(
    'img[src*="/backend-api/estuary/content"], img[alt^="Generated image"], img[alt]',
  );

/**
 * Khối placeholder "đang tạo ảnh" (khung mờ + hiệu ứng chấm động) — DOM thật
 * xác nhận (job 7fb6c915): `<div aria-label="Generating image..."
 * data-testid="image-gen-loading-state">`. Dấu hiệu ĐÁNG TIN CẬY HƠN nút Stop
 * để biết ảnh CÒN đang generate: nút Stop (data-testid="stop-button") có thể
 * "chớp tắt" (biến mất rồi hiện lại) giữa chừng dù ảnh chưa xong — nếu chỉ
 * dựa vào việc thiếu nút Stop trong 3s, vòng lặp coi nhầm là ĐÃ XONG ngay lúc
 * placeholder này vẫn còn nguyên trên trang (throw nhầm "không thấy ảnh nào
 * được tạo" dù GPT còn đang render) — xác nhận qua nhiều job thật (7fb6c915,
 * 2f168624). Khối này chỉ biến mất khi ảnh thật đã render xong.
 */
const imageLoadingLocator = (message: Locator): Locator =>
  message.locator('[data-testid="image-gen-loading-state"]');

/**
 * Gõ prompt rồi bấm gửi, chờ GPT tạo ảnh xong — cùng cơ chế với
 * sendMessage trong chatgpt.ts (clipboard paste, chờ nút Stop vắng mặt ổn
 * định), nhưng dấu hiệu "xong thay thế" ở đây là ẢNH đã xuất hiện trong tin
 * nhắn trả lời thay vì file đính kèm — cùng lý do đã xác nhận với file
 * (job 5010d1a3, chatgpt.ts): có phản hồi nút Stop không tự biến mất dù nội
 * dung chính (ảnh) đã sẵn sàng.
 */
async function sendImagePrompt(page: Page, text: string): Promise<void> {
  // Xác nhận qua debug thật (job ae8f1dbf, chatgpt.ts): 1 số phiên/tài khoản
  // chatgpt.com có Permissions-Policy CHẶN HẲN Clipboard API ở tầng trang —
  // grantPermissions() không có tác dụng với trường hợp này. Fallback sang
  // textarea.fill() khi gặp lỗi.
  let clipboardOk = true;
  try {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: config.chatGptBaseUrl,
      });
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  } catch (err) {
    clipboardOk = false;
    console.warn(
      "[chatgptImage] Clipboard API bị chặn (Permissions-Policy), chuyển sang textarea.fill():",
      err instanceof Error ? err.message : err,
    );
  }

  const textarea = await firstVisible(promptTextareaCandidates(page), 20_000);
  await textarea.click();
  if (clipboardOk) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+V");

    // Xác nhận qua thực tế (cùng vấn đề với chatgpt.ts's sendMessage): chạy
    // headed qua Xvfb trên VPS đôi khi Ctrl+V dán nhầm nội dung clipboard
    // OS/X11 cũ dù navigator.clipboard.writeText() không hề báo lỗi — đọc
    // lại nội dung sau khi dán, không khớp thì ép gõ lại bằng insertText()
    // (không dùng fill(), xem insertPromptText). So sánh sau khi chuẩn hoá
    // whitespace (gộp mọi \n/khoảng trắng liên tiếp thành 1 dấu cách) — tránh
    // false positive với prompt nhiều dòng do ProseMirror render xuống dòng
    // khác cách biểu diễn gốc (xem chatgpt.ts).
    const normalizeForCompare = (s: string) => s.replace(/\s+/g, " ").trim();
    const pasted = await textarea.innerText().catch(() => "");
    if (normalizeForCompare(pasted) !== normalizeForCompare(text)) {
      // console.warn(
      //   "[chatgptImage] Nội dung dán vào ô nhập không khớp prompt (nghi clipboard OS/X11 dán nhầm nội dung cũ) — gõ lại bằng insertText().",
      // );
      await insertPromptText(page, text);
    }
  } else {
    await insertPromptText(page, text);
  }

  const sendButton = await firstVisible(sendButtonCandidates(page), 10_000);
  await sendButton.click();

  // Xác nhận qua debug thật (job b39be426): nút Stop (data-testid="stop-button",
  // aria-label "Stop answering") có thể xuất hiện MUỘN hơn 10s chờ ban đầu
  // (proxy/network chậm, hoặc GPT mất thời gian "suy nghĩ" trước khi thật sự
  // bắt đầu render ảnh) — nếu vòng lặp bên dưới coi "chưa thấy nút Stop + chưa
  // có ảnh" trong 3s liền là ĐÃ XONG, sẽ kết thúc NGAY TỪ ĐẦU trước khi GPT
  // kịp bắt đầu generate thật (ảnh placeholder vẫn đang load dở, xem screenshot
  // job trên) — throw nhầm "không thấy ảnh nào được tạo" dù thực ra GPT còn
  // đang chạy. hasSeenGenerating chỉ cho phép coi là "ổn định/xong" SAU KHI đã
  // từng thấy nút Stop xuất hiện thật ít nhất 1 lần (bằng chứng generate đã
  // bắt đầu) — trừ khi ảnh đã xuất hiện thật (hasImageReady) thì không cần chờ.
  let hasSeenGenerating = await firstVisible(
    stopGeneratingButtonCandidates(page),
    10_000,
  )
    .then(() => true)
    .catch(() => false);

  const stableRequiredMs = 3000;
  const pollIntervalMs = 1000;
  // Xác nhận qua debug thật (job d077805e): generate ẢNH đôi khi lỗi THẬT
  // phía ChatGPT ("Something went wrong. Please try again." kèm nút Retry,
  // data-testid="regenerate-thread-error-button") — không phải lỗi selector.
  // Tự bấm Retry (giới hạn số lần) trước khi chịu thua, vì nguyên nhân hay
  // gặp là quá tải server nhất thời, thử lại thường tự qua.
  const maxRetriesOnError = 10;
  let retriesUsed = 0;
  const start = Date.now();
  let stableSince: number | null = null;
  while (Date.now() - start < config.generationTimeoutMs) {
    const retryButton = await firstVisible(
      regenerateErrorButtonCandidates(page),
      500,
    ).catch(() => null);
    if (retryButton) {
      if (retriesUsed >= maxRetriesOnError) {
        throw new ChatGptImageError(
          `GPT báo lỗi khi tạo ảnh ("Something went wrong") — đã Retry ${retriesUsed} lần vẫn lỗi.`,
        );
      }
      await retryButton.click().catch(() => {});
      retriesUsed++;
      stableSince = null;
      await page.waitForTimeout(pollIntervalMs);
      continue;
    }

    const stillGenerating = await firstVisible(
      stopGeneratingButtonCandidates(page),
      500,
    )
      .then(() => true)
      .catch(() => false);
    if (stillGenerating) hasSeenGenerating = true;

    const { hasImageReady, isImageLoading } = await (async () => {
      const messages = assistantMessageLocator(page);
      if ((await messages.count()) === 0)
        return { hasImageReady: false, isImageLoading: false };
      const latest = messages.last();
      return {
        hasImageReady: (await generatedImageLocator(latest).count()) > 0,
        isImageLoading: (await imageLoadingLocator(latest).count()) > 0,
      };
    })();
    if (isImageLoading) hasSeenGenerating = true;

    if (
      (stillGenerating || !hasSeenGenerating || isImageLoading) &&
      !hasImageReady
    ) {
      stableSince = null;
    } else {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableRequiredMs) {
        const hasAnyMessage =
          (await page.locator("[data-message-author-role]").count()) > 0;
        if (!hasAnyMessage) {
          throw new ChatGptImageError(
            "Trang không có tin nhắn nào sau khi chờ phản hồi (có thể đã mất trạng thái giữa chừng) — cần thử lại.",
          );
        }
        return;
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new ChatGptImageError(
    `Hết thời gian chờ GPT tạo ảnh (timeout ${config.generationTimeoutMs}ms)`,
  );
}

/**
 * Upload ảnh tham chiếu (CHARACTER/LOCATION đã generate trước đó) lên
 * composer TRƯỚC khi gõ prompt — dùng cho entry SCENE_SETTING có "ref" (xem
 * generateSceneImagesForFile trong storyboardPipeline.ts): GPT nhìn thấy các
 * ảnh này làm ảnh tham chiếu khi tạo ảnh bối cảnh mới, giữ đúng nhận diện
 * nhân vật/địa điểm đã có.
 *
 * CHƯA có DOM thật xác nhận thời gian xử lý upload — chờ tạm 3s/ảnh trước
 * khi gõ prompt tiếp; cần chỉnh lại nếu qua debug snapshot thấy GPT generate
 * khi ảnh chưa upload xong (vd còn thumbnail "đang tải" trong composer).
 */
async function uploadReferenceImages(
  page: Page,
  refImagePaths: string[],
): Promise<void> {
  await fileUploadInputLocator(page).setInputFiles(refImagePaths);
  await page.waitForTimeout(3000 * refImagePaths.length);
}

/** Đoán đuôi file từ URL ảnh — mặc định "png" nếu không xác định được. */
function guessImageExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : "png";
  } catch {
    return "png";
  }
}

/**
 * Mở chatgpt.com (chat mới), nhờ GPT tạo 1 ảnh theo prompt, chờ xong rồi tải
 * ảnh về destDir/<baseFileName>.<đuôi thật>. Trả về path file đã lưu.
 *
 * refImagePaths (tuỳ chọn): ảnh tham chiếu (CHARACTER/LOCATION đã generate
 * trước đó) upload lên composer TRƯỚC khi gõ prompt — dùng cho entry
 * SCENE_SETTING có "ref" (xem generateSceneImagesForFile trong
 * storyboardPipeline.ts) để GPT giữ đúng nhận diện nhân vật/địa điểm khi vẽ
 * cảnh mới.
 */
export async function generateReferenceImage(
  prompt: string,
  destDir: string,
  baseFileName: string,
  jobId: string,
  refImagePaths?: string[],
): Promise<string> {
  return enqueueImageGeneration(() =>
    generateReferenceImageInternal(prompt, destDir, baseFileName, jobId, refImagePaths),
  );
}

/**
 * Hàng đợi (queue) đảm bảo CHỈ 1 tab chatgpt.com được mở tại 1 thời điểm cho
 * MỌI lời gọi generateReferenceImage — dùng chung cho CẢ 3 loại entry
 * CHARACTER, LOCATION, SCENE_SETTING (đều gọi qua hàm này, xem
 * storyboardPipeline.ts). Dù storyboardPipeline hiện đã gọi tuần tự (for-loop
 * có await) nên về lý thuyết không mở 2 tab cùng lúc, hàng đợi này đảm bảo
 * chắc chắn không xảy ra dù code gọi thay đổi sau này (vd lỡ đổi sang
 * Promise.all) hoặc có thêm nơi khác cùng gọi hàm này — tránh mở nhiều tab
 * Chrome cùng lúc trên CÙNG 1 browser context dùng chung (getChatGptBrowserContext),
 * dễ gây xung đột/crash.
 */
let generateImageQueue: Promise<unknown> = Promise.resolve();

function enqueueImageGeneration<T>(task: () => Promise<T>): Promise<T> {
  const result = generateImageQueue.then(task, task);
  // .catch(() => {}) chỉ để KHÔNG chặn task tiếp theo trong hàng đợi khi 1
  // task lỗi — lỗi thật vẫn được throw lại đầy đủ qua promise "result" trả
  // về cho caller.
  generateImageQueue = result.catch(() => {});
  return result;
}

async function generateReferenceImageInternal(
  prompt: string,
  destDir: string,
  baseFileName: string,
  jobId: string,
  refImagePaths?: string[],
): Promise<string> {
  const context = await getChatGptBrowserContext();
  const page = await context.newPage();
  try {
    // Xác nhận qua log lỗi thật (job 95227a24): thoáng qua mạng/Cloudflare
    // chập chờn khiến 1 lần goto timeout 600s dù các job trước/sau vẫn chạy
    // bình thường — retry thêm 1 lần thay vì fail hẳn cả job ngay lập tức.
    try {
      await page.goto(config.chatGptBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 600_000,
      });
    } catch (err) {
      console.warn(
        "[chatgptImage] page.goto lỗi lần 1, thử lại lần 2:",
        err instanceof Error ? err.message : err,
      );
      await page.goto(config.chatGptBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 600_000,
      });
    }
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new ChatGptImageError(
        "Chưa đăng nhập chatgpt.com hoặc session đã hết hạn. Chạy: npm run login-chatgpt",
      );
    }

    // domcontentloaded fire sớm với SPA — chờ mạng rảnh trước khi tìm ô nhập
    // prompt, cùng lý do đã áp dụng cho hailuoai.video (xem generateVideo).
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    if (refImagePaths && refImagePaths.length > 0) {
      await uploadReferenceImages(page, refImagePaths);
    }

    // Xác nhận qua log lỗi thật (job 75724184): GPT đôi khi trả lời XONG bình
    // thường (không phải lỗi UI "Something went wrong" có nút Retry đã xử lý
    // ở trên) nhưng nội dung chỉ là 1 câu xin lỗi dạng "I wasn't able to
    // generate the image due to an error on my side." — không có ảnh nào,
    // không phải lỗi selector. Coi đây là lỗi TẠM THỜI phía GPT, tự gõ lại
    // NGUYÊN prompt (gọi lại sendImagePrompt) để thử lại vài lần trước khi
    // chịu thua, vì không có nút Retry sẵn cho case này như case kia.
    const maxGptTextFailureRetries = 5;
    let images: Locator;
    let latest: Locator;
    for (let attempt = 0; ; attempt++) {
      await sendImagePrompt(page, `Generate an image: ${prompt}`);
      await captureSnapshot(page, jobId, "result");

      const messages = assistantMessageLocator(page);
      if ((await messages.count()) === 0) {
        throw new ChatGptImageError(
          "Không tìm thấy câu trả lời nào từ ChatGPT trên trang",
        );
      }
      latest = messages.last();
      images = generatedImageLocator(latest);
      if ((await images.count()) > 0) break;

      const latestText = await latest.innerText().catch(() => "");
      const isGptSideFailure = /wasn'?t able to generate|error on (my|our) side/i.test(
        latestText,
      );
      if (isGptSideFailure && attempt < maxGptTextFailureRetries) {
        console.warn(
          `[chatgptImage] GPT báo lỗi phía họ (lần ${attempt + 1}/${maxGptTextFailureRetries}), gõ lại prompt để thử lại: "${latestText.slice(0, 200)}"`,
        );
        continue;
      }

      throw new ChatGptImageError(
        isGptSideFailure
          ? `GPT báo lỗi phía họ khi tạo ảnh (đã thử lại ${attempt} lần vẫn lỗi): "${latestText.slice(0, 200)}"`
          : "GPT trả lời xong nhưng không thấy ảnh nào được tạo",
      );
    }

    const src = await images.first().getAttribute("src");
    if (!src) {
      throw new ChatGptImageError(
        'Không lấy được URL ảnh (thẻ <img> không có "src")',
      );
    }

    // Ảnh do ChatGPT tạo thường phục vụ qua URL đã ký sẵn (pre-signed) —
    // fetch thẳng qua request context (dùng chung cookie/session với page)
    // thay vì phải bấm hover/click UI để kích hoạt sự kiện download.
    //
    // Xác nhận qua log lỗi thật (job e887e23c): mặc định request.get() chỉ
    // chờ 30s — response header đã về 200 OK nhưng ảnh dung lượng lớn tải qua
    // mạng VPS chậm chưa đọc xong body thì đã bị coi là timeout. timeout: 0
    // = tắt hẳn giới hạn thời gian (Playwright chờ tới khi xong hoặc lỗi
    // mạng thật, không tự huỷ giữa chừng).
    const response = await page.context().request.get(src, { timeout: 0 });
    if (!response.ok()) {
      throw new ChatGptImageError(
        `Tải ảnh thất bại: HTTP ${response.status()}`,
      );
    }

    await fs.promises.mkdir(destDir, { recursive: true });
    const destPath = path.join(
      destDir,
      `${baseFileName}.${guessImageExtension(src)}`,
    );
    await fs.promises.writeFile(destPath, await response.body());

    return destPath;
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof ChatGptImageError
      ? err
      : new ChatGptImageError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
