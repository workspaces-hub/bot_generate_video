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
  } else {
    await textarea.fill(text);
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
  const maxRetriesOnError = 2;
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
 */
export async function generateReferenceImage(
  prompt: string,
  destDir: string,
  baseFileName: string,
  jobId: string,
): Promise<string> {
  const context = await getChatGptBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(config.chatGptBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
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

    await sendImagePrompt(page, `Generate an image: ${prompt}`);
    await captureSnapshot(page, jobId, "result");

    const messages = assistantMessageLocator(page);
    if ((await messages.count()) === 0) {
      throw new ChatGptImageError(
        "Không tìm thấy câu trả lời nào từ ChatGPT trên trang",
      );
    }
    const latest = messages.last();
    const images = generatedImageLocator(latest);
    if ((await images.count()) === 0) {
      throw new ChatGptImageError(
        "GPT trả lời xong nhưng không thấy ảnh nào được tạo",
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
    const response = await page.context().request.get(src);
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
