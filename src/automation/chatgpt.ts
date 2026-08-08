import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { dismissCloudflareChallengeIfPresent, getChatGptBrowserContext } from "./chatgptBrowser";
import {
  assistantMessageLocator,
  downloadButtonCandidates,
  downloadFileLinkLocator,
  fileAttachmentLocator,
  fileCardLocator,
  promptTextareaCandidates,
  regenerateErrorButtonCandidates,
  sendButtonCandidates,
  signInIndicatorCandidates,
  stopGeneratingButtonCandidates,
} from "./chatgptSelectors";
import { firstVisible } from "./selectors";
// captureSnapshot/captureErrorSnapshot đã tổng quát (chỉ cần Page + jobId),
// dùng lại nguyên bản thay vì viết trùng cho chatgpt.com.
import { captureErrorSnapshot, captureSnapshot } from "./hailuo";

export class ChatGptError extends Error {}

/**
 * Gõ text vào ô nhập rồi bấm gửi — prompt có thể RẤT dài, ưu tiên dùng
 * clipboard copy/paste (navigator.clipboard.writeText + Ctrl/Cmd+V) thay vì
 * .fill()/gõ từng phím, đáng tin cậy hơn với nội dung dài (đúng cách user
 * thật sẽ làm: copy nội dung rồi dán vào ô chat).
 *
 * Xác nhận qua debug thật (job ae8f1dbf): 1 số phiên/tài khoản chatgpt.com có
 * Permissions-Policy CHẶN HẲN Clipboard API ở tầng trang ("NotAllowedError:
 * ... blocked because of a permissions policy applied to the current
 * document") — khác với việc thiếu quyền (permission prompt), nên
 * grantPermissions() không có tác dụng gì với trường hợp này. Fallback sang
 * textarea.fill() (set thẳng nội dung, không cần clipboard, không gõ từng
 * phím) khi gặp lỗi này.
 */
async function sendMessage(page: Page, text: string): Promise<void> {
  let clipboardOk = true;
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: config.chatGptBaseUrl,
    });
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  } catch (err) {
    clipboardOk = false;
    console.warn(
      "[chatgpt] Clipboard API bị chặn (Permissions-Policy), chuyển sang textarea.fill():",
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

  // Chờ nút "Stop generating" xuất hiện (GPT bắt đầu trả lời) — best-effort,
  // không throw nếu không thấy (có thể trả lời quá nhanh, đã xong trước khi
  // kịp bắt được trạng thái này).
  await firstVisible(stopGeneratingButtonCandidates(page), 10_000).catch(
    () => {},
  );

  // Rồi chờ tới khi nút đó biến mất — GPT đã trả lời xong.
  //
  // Xác nhận qua debug thật (job ebca2517): nút Stop có thể biến mất RỒI
  // XUẤT HIỆN LẠI trong lúc GPT vẫn đang suy luận/trả lời (nhấp nháy giữa các
  // đoạn) — nếu chỉ check 1 lần "không thấy nút Stop" là coi như xong ngay,
  // code sẽ gửi lượt tiếp theo ("yes") trong khi GPT thực tế còn đang generate,
  // khiến ô nhập bị khoá và không tìm thấy nút Send (lỗi
  // "waiting for ... send-button to be visible"). Nên phải yêu cầu nút Stop
  // vắng mặt LIÊN TỤC trong 1 khoảng ổn định (giống pattern settle dùng cho
  // upload ảnh ở hailuo.ts) mới coi là GPT đã trả lời xong thật.
  //
  // Xác nhận qua debug thật (job 5010d1a3): với phản hồi có dùng tool tạo
  // file (Code Interpreter — vd tạo meta.json), nút Stop KHÔNG BAO GIỜ biến
  // mất dù trả lời đã xong thật (text đầy đủ + file đính kèm đã hiện, "Worked
  // for 20s") — chờ dựa hoàn toàn vào nút Stop khiến vòng lặp treo tới hết
  // timeout dù GPT xong từ lâu. Vì vậy: nếu tin nhắn trả lời MỚI NHẤT đã có
  // file đính kèm hiện ra (fileAttachmentLocator), coi đó là dấu hiệu xong
  // THAY THẾ cho việc chờ nút Stop biến mất.
  const stableRequiredMs = 3000;
  const pollIntervalMs = 1000;
  // Xác nhận qua debug thật (job d077805e, chatgptImage.ts): GPT đôi khi báo
  // lỗi THẬT ("Something went wrong. Please try again." kèm nút Retry,
  // data-testid="regenerate-thread-error-button") — không phải lỗi selector.
  // Tự bấm Retry (giới hạn số lần) trước khi chịu thua, vì nguyên nhân hay
  // gặp là quá tải server nhất thời, thử lại thường tự qua.
  const maxRetriesOnError = 2;
  let retriesUsed = 0;

  const start = Date.now();
  let stableSince: number | null = null;
  while (Date.now() - start < config.generationTimeoutMs) {
    const retryButton = await firstVisible(regenerateErrorButtonCandidates(page), 500).catch(
      () => null,
    );
    if (retryButton) {
      if (retriesUsed >= maxRetriesOnError) {
        throw new ChatGptError(
          `GPT báo lỗi ("Something went wrong") — đã Retry ${retriesUsed} lần vẫn lỗi.`,
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

    const hasFileReady = await (async () => {
      const messages = assistantMessageLocator(page);
      if ((await messages.count()) === 0) return false;
      return (await fileAttachmentLocator(messages.last()).count()) > 0;
    })();

    if (stillGenerating && !hasFileReady) {
      stableSince = null;
    } else {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableRequiredMs) {
        // Xác nhận qua debug thật (job 4b50baaa): trang có thể bị đưa về lại
        // màn hình "New chat" trống — mất trắng tin nhắn vừa gửi — mà không
        // hề báo lỗi gì (không còn nút Stop nên vòng lặp vẫn tưởng là "đã
        // xong"). Xác nhận LẠI thực sự đã có tin nhắn trên trang trước khi
        // coi là thành công.
        const hasAnyMessage =
          (await page.locator("[data-message-author-role]").count()) > 0;
        if (!hasAnyMessage) {
          throw new ChatGptError(
            "Trang không có tin nhắn nào sau khi chờ phản hồi (có thể đã mất trạng thái giữa chừng) — cần thử lại.",
          );
        }
        return;
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new ChatGptError(
    `Hết thời gian chờ GPT trả lời (timeout ${config.generationTimeoutMs}ms)`,
  );
}

/**
 * Nếu tin nhắn trả lời có đính kèm file (GPT tạo ra, vd qua code
 * interpreter/canvas) thì tải về config.chatGptResultsDir. Best-effort: bấm
 * vào từng file đính kèm rồi chờ sự kiện download của trình duyệt; nếu bấm
 * vào chỉ mở preview (chưa tải ngay) thì thử bấm tiếp nút "Download" hiện ra
 * sau đó. KHÔNG throw nếu 1 file lỗi — chỉ log cảnh báo và bỏ qua file đó,
 * không chặn cả job vì lỗi tải 1 file đính kèm.
 *
 * Xác nhận qua debug thật (job 6d869584): mỗi file có 2 nút liên quan tới
 * CÙNG 1 file — nút link-text "Download <filename>" (tải thẳng) và thẻ
 * "card" file (mở preview, không chắc tải). Chỉ bấm downloadFileLinkLocator
 * TRƯỚC; nếu không có nút nào (count 0) mới fallback sang fileCardLocator —
 * KHÔNG bấm cả 2 cho cùng 1 file (tránh tải trùng/mở preview thừa không cần
 * thiết khi nút "Download ..." đã đủ để tải thẳng).
 */
async function downloadAttachedFiles(
  page: Page,
  message: Locator,
  jobId: string,
): Promise<string[]> {
  const downloadLinks = downloadFileLinkLocator(message);
  const attachments =
    (await downloadLinks.count()) > 0 ? downloadLinks : fileCardLocator(message);
  const count = await attachments.count();
  const savedPaths: string[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
      await attachments.nth(i).click();
      let download = await downloadPromise.catch(() => null);

      if (!download) {
        const secondaryDownloadPromise = page.waitForEvent("download", { timeout: 10_000 });
        const downloadButton = await firstVisible(downloadButtonCandidates(page), 5000).catch(() => null);
        if (downloadButton) {
          await downloadButton.click();
          download = await secondaryDownloadPromise.catch(() => null);
        }
      }
      if (!download) continue;

      await fs.promises.mkdir(config.chatGptResultsDir, { recursive: true });
      const suggested = download.suggestedFilename() || `attachment-${i}`;
      const filePath = path.join(config.chatGptResultsDir, `${jobId}-${suggested}`);
      await download.saveAs(filePath);
      savedPaths.push(filePath);
    } catch (err) {
      console.warn(`[chatgpt] Không tải được file đính kèm (index ${i}):`, err);
    }
  }

  return savedPaths;
}

/** Lấy file đính kèm (nếu có) của tin nhắn trả lời MỚI NHẤT từ GPT. */
async function readLatestAssistantMessage(
  page: Page,
  jobId: string,
): Promise<{ downloadedFiles: string[] }> {
  const messages = assistantMessageLocator(page);
  const count = await messages.count();
  if (count === 0) {
    throw new ChatGptError(
      "Không tìm thấy câu trả lời nào từ ChatGPT trên trang",
    );
  }
  const latest: Locator = messages.last();

  const downloadedFiles = await downloadAttachedFiles(page, latest, jobId);

  return { downloadedFiles };
}

/**
 * Mở chatgpt.com, gửi prompt 1 LẦN DUY NHẤT, chờ GPT trả lời xong, rồi thử
 * tải file GPT đính kèm (nếu có, xem downloadAttachedFiles) về
 * config.chatGptResultsDir. Không có file đính kèm cũng không coi là lỗi —
 * chỉ trả về mảng rỗng.
 */
export async function askChatGpt(
  prompt: string,
  jobId: string,
): Promise<{ downloadedFiles: string[] }> {
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
      throw new ChatGptError(
        "Chưa đăng nhập chatgpt.com hoặc session đã hết hạn. Chạy: npm run login-chatgpt",
      );
    }

    // domcontentloaded fire sớm với SPA — chờ mạng rảnh trước khi tìm ô nhập
    // prompt, cùng lý do đã áp dụng cho hailuoai.video (xem generateVideo).
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    await sendMessage(page, prompt);
    await captureSnapshot(page, jobId, "result");

    const { downloadedFiles } = await readLatestAssistantMessage(page, jobId);

    return { downloadedFiles };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof ChatGptError
      ? err
      : new ChatGptError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
