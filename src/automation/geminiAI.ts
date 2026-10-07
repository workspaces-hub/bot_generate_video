import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { captureErrorSnapshot, captureSnapshot } from "./aiVideo";
import type { BrowserContextGetter } from "./browser";
import { getGeminiBrowserContext } from "./geminiBrowser";
import {
  geminiAttachmentLoadingLocator,
  geminiAttachmentPreviewLocator,
  geminiCanvasChipLocator,
  geminiCanvasEditorLocator,
  geminiCodeBlockLocator,
  geminiModelMenuButtonCandidates,
  geminiModelOptionLocator,
  geminiPromptInputCandidates,
  geminiResponseContentLocator,
  geminiResponseLocator,
  geminiSendButtonCandidates,
  geminiSignInIndicatorCandidates,
  geminiSnackbarLocator,
  geminiStopButtonLocator,
  geminiUploadFilesMenuItemCandidates,
  geminiUploadMenuButtonCandidates,
} from "./geminiSelectors";
import { describeMergeState, mergeJsonPartAuto, type MergeState } from "./qwenAI";
import { firstVisible } from "./selectors";

/**
 * Bản CLONE của askChatAI/askChatAIAboutReferenceVideo (chatAI.ts) dùng Gemini
 * web (gemini.google.com) qua Playwright — theo yêu cầu người dùng. Khác
 * ChatGPT ở 1 điểm cốt lõi: Gemini web KHÔNG tạo file đính kèm để tải về, chỉ
 * trả lời text/khối code. Nên kết quả lấy theo cơ chế "JSON nhiều phần" giống
 * askChatAIWithInlineContent/askQwen: mỗi lượt Gemini trả 1 khối code JSON
 * (1 phần), bot tự gộp (mergeJsonPartAuto — tự dò array/object) tới khi thấy
 * marker DONE_MARKER rồi tự ghi ra file trong config.chatAIResultsDir.
 *
 * Trả về CÙNG dạng { downloadedFiles } như askChatAI để processChatAIQueue
 * dùng lại nguyên pipeline phía sau.
 */

export class GeminiError extends Error {}

/**
 * Gemini KHÔNG nhận tin vừa gửi: tin bị trả nguyên về ô nhập (thường kèm 1
 * snackbar báo lỗi thoáng qua). Xác nhận qua debug thật (job
 * f002fd08-8abf-47ab-9991-75ce8a0e998a, b5a93ba9): ô nhập trống thoáng qua rồi
 * chữ bị trả lại (file đính kèm thì KHÔNG được trả lại), không có lượt trả
 * lời mới. Lỗi tạm thời phía Gemini — askGemini chờ rồi gửi lại.
 */
export class GeminiSendRejectedError extends GeminiError {}

/** Chờ sau khi Gemini trả tin về ô nhập, trước khi gửi lại. */
const SEND_REJECTED_RETRY_DELAYS_MS = [30_000, 90_000];

const DONE_MARKER = "ĐÃ HOÀN THÀNH";
/**
 * Tin nhắn gửi tiếp khi lượt trả lời chưa có DONE_MARKER — mở đầu đúng "Tiếp
 * tục xử lý" (theo yêu cầu người dùng) + 1 dòng mốc vị trí. SỬA (xác nhận qua
 * debug thật, job 66175e91-2b4a-45d8-bfb8-49b976d56a8a): chỉ gửi trơn "Tiếp
 * tục xử lý" thì Gemini web hay mất ngữ cảnh prompt dài — trả lời "Bạn muốn
 * tiếp tục xử lý phần nào?", nhiều lần chèn luôn câu đó vào GIỮA khối JSON
 * đang viết (khối hỏng); 2/2 lượt gửi tin có mốc vị trí đều ra JSON đúng.
 */
function buildShortContinueMessage(state: MergeState): string {
  return '"Tiếp tục" tiếp theo, tuân thủ đúng quy tắc chuyển thể cốt truyện và thời lượng 4–9 giây cho từng video mới'
  return `Tiếp tục xử lý — gửi tiếp phần JSON kế tiếp của kết quả đang làm ở trên (đặt TOÀN BỘ JSON trong 1 khối code \`\`\`json\`\`\` — KHÔNG dùng Canvas). ${describeMergeState(state).replace(/\n/g, " ")} Chỉ viết "${DONE_MARKER}" khi đã gửi đủ toàn bộ.`;
  return `Tiếp tục xử lý — gửi tiếp phần JSON kế tiếp của kết quả đang làm ở trên (đặt TOÀN BỘ JSON trong 1 khối code \`\`\`json\`\`\` — KHÔNG dùng Canvas; NHIỀU item mới nhất có thể nhưng KHÔNG quá ~${config.geminiMaxCharsPerTurn} ký tự, đúng quy tắc ở tin nhắn đầu). ${describeMergeState(state).replace(/\n/g, " ")} Chỉ viết "${DONE_MARKER}" khi đã gửi đủ toàn bộ.`;
}

/** Chờ tối đa cho 1 lượt trả lời (Gemini xem video dài có thể rất lâu). */
const RESPONSE_TIMEOUT_MS = 60 * 60_000;
/** Không thấy lượt trả lời mới nào xuất hiện sau ngần này thì coi là gửi hỏng. */
const RESPONSE_START_TIMEOUT_MS = 5 * 60_000;
/** Nút Stop phải vắng mặt + text đứng yên liên tục ngần này mới coi là xong. */
const RESPONSE_STABLE_MS = 8_000;
/** Chờ tối đa file đính kèm upload/xử lý xong (video lớn). */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export async function openGeminiPage(
  jobId: string,
  /** Context dùng để mở trang — mặc định tài khoản askGemini; tạo ảnh truyền getGeminiImageBrowserContext. */
  getContext: BrowserContextGetter = getGeminiBrowserContext,
): Promise<Page> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(config.geminiBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Chờ ô nhập prompt thay vì networkidle (Google giữ kết nối nền, networkidle
    // gần như luôn chờ hết timeout).
    const signInIndicator = () =>
      firstVisible(geminiSignInIndicatorCandidates(page), 5000)
        .then(() => true)
        .catch(() => false);
    const inputReady = await firstVisible(geminiPromptInputCandidates(page), 30_000)
      .then(() => true)
      .catch(() => false);
    if (await signInIndicator()) {
      throw new GeminiError(
        "Chưa đăng nhập Gemini hoặc session đã hết hạn. Chạy: npm run login-gemini",
      );
    }
    if (!inputReady) {
      throw new GeminiError(
        "Không tìm thấy ô nhập prompt của Gemini (selector có thể đã lỗi thời — xem debug snapshot).",
      );
    }
    await selectModelIfConfigured(page, jobId);
    return page;
  } catch (err) {
    await captureErrorSnapshot(page, `${jobId}_gemini-open`, err);
    await page.close().catch(() => {});
    throw err;
  }
}

/** Chọn model theo config.geminiModelLabel (best-effort — lỗi chỉ log, giữ model mặc định). */
async function selectModelIfConfigured(page: Page, jobId: string): Promise<void> {
  const label = config.geminiModelLabel.trim();
  console.log("🚀 ~ selectModelIfConfigured ~ label:", label)
  if (!label) return;
  try {
    // So khớp CHÍNH XÁC tên model (không phân biệt hoa thường) — so "chứa
    // chuỗi" không phân biệt được "Flash" với "Flash-Lite".
    const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");
    const wanted = normalize(label);
    const menuButton = await firstVisible(geminiModelMenuButtonCandidates(page), 5000);
    // aria-label dạng "Mở công cụ chọn chế độ, hiện tại là Flash"; không có thì lấy chữ trên nút.
    const ariaLabel = (await menuButton.getAttribute("aria-label").catch(() => null)) ?? "";
    const current =
      ariaLabel.match(/(?:hiện tại là|currently)\s*(.+)$/i)?.[1]?.trim() ||
      (await menuButton.innerText().catch(() => "")).trim();
    if (normalize(current) === wanted) {
      console.log(`[gemini] (${jobId}) model hiện tại "${current}" đã đúng "${label}".`);
      return;
    }
    await menuButton.click();
    const options = geminiModelOptionLocator(page);
    await options.first().waitFor({ state: "visible", timeout: 5000 });
    // Tên model = dòng ĐẦU của mỗi lựa chọn (các dòng sau là mô tả).
    const titles = await options.evaluateAll((els) =>
      els.map((el) => ((el as HTMLElement).innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? ""),
    );
    const index = titles.findIndex((title) => normalize(title) === wanted);
    if (index < 0) {
      throw new Error(`không có lựa chọn model "${label}" (các lựa chọn: ${titles.join(" | ")})`);
    }
    await options.nth(index).click({ timeout: 5000 });
    console.log(`[gemini] (${jobId}) đã chọn model "${titles[index]}" (trước đó: "${current}").`);
  } catch (err) {
    console.warn(
      `[gemini] (${jobId}) không chọn được model "${label}" — giữ model mặc định:`,
      err instanceof Error ? err.message : err,
    );
    await page.keyboard.press("Escape").catch(() => {});
  }
}

/**
 * Đính kèm 1 file vào composer: ưu tiên set thẳng vào input[type=file] (nếu
 * DOM có sẵn), không có thì bấm menu "+" → "Upload files" và bắt filechooser.
 * Chờ thẻ file xuất hiện và hết spinner.
 */
export async function uploadFile(page: Page, filePath: string, jobId: string): Promise<void> {
  const fileName = path.basename(filePath);
  const previewsBefore = await geminiAttachmentPreviewLocator(page).count().catch(() => 0);

  const directInput = page.locator('input[type="file"]');
  if ((await directInput.count().catch(() => 0)) > 0) {
    await directInput.first().setInputFiles(filePath);
  } else {
    const menuButton = await firstVisible(geminiUploadMenuButtonCandidates(page), 10_000);
    await menuButton.click();
    const menuItem = await firstVisible(geminiUploadFilesMenuItemCandidates(page), 10_000);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }),
      menuItem.click(),
    ]);
    await chooser.setFiles(filePath);
  }

  // SỬA (xác nhận qua debug thật, job 38917089-274d-4520-a029-eead0a383026):
  // trước đây chờ thẻ file "best-effort" rồi đi tiếp kể cả khi KHÔNG thấy —
  // video không vào được ô nhập (Gemini từ chối/huỷ upload) thì bot vẫn gõ
  // prompt + bấm Gửi, 5 phút sau mới báo chung chung "Gemini không bắt đầu trả
  // lời". Giờ bắt buộc thấy thẻ file (thẻ preview mới hoặc phần tử có
  // aria-label đúng tên file), không thấy thì báo lỗi rõ kèm thông báo Gemini.
  const namedPreview = page.locator(`[aria-label="${fileName.replace(/"/g, '\\"')}"]`);
  const appearDeadline = Date.now() + 60_000;
  let appeared = false;
  while (Date.now() < appearDeadline) {
    const count = await geminiAttachmentPreviewLocator(page).count().catch(() => 0);
    const named = await namedPreview.count().catch(() => 0);
    if (count > previewsBefore || named > 0) {
      appeared = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!appeared) {
    throw new GeminiError(
      `Gemini không nhận file "${fileName}" — không thấy thẻ file trong ô nhập sau 60s.${await readSnackbarText(page)}`,
    );
  }
  await waitForComposerUploadsDone(page, jobId);
  console.log(`[gemini] (${jobId}) đã đính kèm "${fileName}" (upload xong).`);
}

/** Nội dung snackbar Gemini đang hiện (nếu có) — dùng kèm thông báo lỗi. */
/**
 * Theo yêu cầu người dùng: upload file (video) lên Gemini lỗi thì THỬ LẠI và
 * chờ tới khi upload thành công — tối đa config.geminiUploadMaxAttempts lần,
 * chờ tăng dần 15s → 30s → 60s → 120s (tối đa) giữa các lần. Từ lần thử thứ 3
 * tải lại trang Gemini trước (trang có thể kẹt menu/hộp chọn file) — chỉ dùng
 * ở lượt ĐẦU (chưa có hội thoại nào bị mất khi tải lại).
 */
export async function uploadFileWithRetry(
  page: Page,
  filePath: string,
  jobId: string,
  options: { allowReload?: boolean } = {},
): Promise<void> {
  const maxAttempts = Math.max(1, config.geminiUploadMaxAttempts);
  for (let attempt = 1; ; attempt++) {
    try {
      await uploadFile(page, filePath, jobId);
      if (attempt > 1) {
        console.log(`[gemini] (${jobId}) upload "${path.basename(filePath)}" thành công ở lần thử ${attempt}.`);
      }
      return;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new GeminiError(
          `Upload "${path.basename(filePath)}" lên Gemini thất bại sau ${maxAttempts} lần thử: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delayMs = Math.min(120_000, 15_000 * 2 ** (attempt - 1));
      console.warn(
        `[gemini] (${jobId}) upload "${path.basename(filePath)}" lỗi (lần ${attempt}/${maxAttempts}) — chờ ${delayMs / 1000}s rồi thử lại:`,
        err instanceof Error ? err.message : err,
      );
      await captureSnapshot(page, `${jobId}_gemini-upload-fail-${attempt}`, `gemini-upload-fail-${attempt}`, {
        fullPage: false,
      });
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(delayMs);
      if (options.allowReload && attempt >= 2) {
        console.warn(`[gemini] (${jobId}) tải lại trang Gemini trước khi upload lại.`);
        await page
          .goto(config.geminiBaseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
          .catch(() => {});
        await firstVisible(geminiPromptInputCandidates(page), 30_000).catch(() => {});
      }
    }
  }
}

/**
 * Chờ tới khi KHÔNG còn spinner upload nào đang hiện trong ô nhập (thẻ file
 * upload xong) — phải vắng spinner LIÊN TỤC UPLOAD_SETTLE_MS (spinner có thể
 * hiện trễ vài giây sau khi thẻ file xuất hiện). Theo yêu cầu người dùng —
 * bấm Gửi lúc video chưa upload xong thì "không ăn"/gửi thiếu video (job
 * d84a63fa). Quá UPLOAD_TIMEOUT_MS vẫn còn spinner thì báo lỗi (để
 * uploadFileWithRetry thử lại).
 */
const UPLOAD_SETTLE_MS = 3000;
async function waitForComposerUploadsDone(page: Page, jobId: string): Promise<void> {
  const start = Date.now();
  let idleSince: number | null = null;
  let nextLogAt = start + 30_000;
  while (true) {
    const uploading = await geminiAttachmentLoadingLocator(page)
      .filter({ visible: true })
      .count()
      .catch(() => 0);
    if (uploading === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= UPLOAD_SETTLE_MS) return;
    } else {
      idleSince = null;
      if (Date.now() >= nextLogAt) {
        nextLogAt += 30_000;
        console.log(
          `[gemini] (${jobId}) file đính kèm vẫn đang upload (${Math.round((Date.now() - start) / 1000)}s)...`,
        );
      }
    }
    if (Date.now() - start > UPLOAD_TIMEOUT_MS) {
      throw new GeminiError(
        `File đính kèm vẫn đang upload (còn spinner) sau ${UPLOAD_TIMEOUT_MS / 60_000} phút.`,
      );
    }
    await page.waitForTimeout(1000);
  }
}

export async function readSnackbarText(page: Page): Promise<string> {
  const texts = await geminiSnackbarLocator(page)
    .allInnerTexts()
    .catch(() => [] as string[]);
  const text = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].join(" | ");
  return text ? ` Gemini báo: "${text}"` : "";
}

/** Đã thực sự gửi đi chưa: có lượt trả lời mới, có nút Stop, hoặc ô nhập đã trống. */
async function hasMessageBeenSent(
  page: Page,
  input: Locator,
  countBefore: number,
): Promise<boolean> {
  if ((await geminiResponseLocator(page).count()) > countBefore) return true;
  if (await geminiStopButtonLocator(page).first().isVisible().catch(() => false)) {
    return true;
  }
  const remaining = await input.innerText().catch(() => "");
  return remaining.trim() === "";
}

async function isSendButtonEnabled(button: Locator): Promise<boolean> {
  const ariaDisabled = await button.getAttribute("aria-disabled").catch(() => null);
  if (ariaDisabled === "true") return false;
  return button.isEnabled().catch(() => false);
}

/** Gõ prompt, bấm Gửi, chờ Gemini trả lời XONG. Trả về locator lượt trả lời mới. */
export interface SendAndWaitOptions {
  /**
   * Bật debug: cứ mỗi debugEveryMs ms trong lúc chờ Gemini trả lời thì log
   * trạng thái + chụp snapshot storage/debug/<jobId>_<debugLabel>-<giây>s
   * (theo yêu cầu người dùng — dùng cho tạo ảnh, xem geminiImage.ts).
   */
  debugEveryMs?: number;
  debugLabel?: string;
  /**
   * File đã đính kèm cho lượt này (chỉ lượt đầu) — trước khi bấm Gửi kiểm tra
   * thẻ file còn đủ trong ô nhập, thiếu thì upload lại 1 lần. Xác nhận qua
   * debug thật (job b5a93ba9-c0b5-4e3f-a544-7e207b682e71, 38917089): upload đã
   * thấy thẻ file, nhưng lúc lỗi ô nhập KHÔNG còn thẻ nào và bấm Gửi/Enter
   * đều không gửi được.
   */
  attachmentPaths?: string[];
}

/** Số thẻ file đang đính kèm trong ô nhập. */
async function countComposerAttachments(page: Page): Promise<number> {
  return page
    .locator("uploader-file-preview")
    .count()
    .catch(() => 0);
}

/** Số ảnh do Gemini tạo trong 1 lượt trả lời (tổng / đã tải xong). */
async function countGeneratedImages(response: Locator): Promise<{ total: number; loaded: number }> {
  return response
    .locator("generated-image img")
    .evaluateAll((els) => ({
      total: els.length,
      loaded: els.filter(
        (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 64,
      ).length,
    }))
    .catch(() => ({ total: 0, loaded: 0 }));
}

/**
 * sendAndWait + gửi lại khi Gemini trả tin về ô nhập (GeminiSendRejectedError)
 * — chờ SEND_REJECTED_RETRY_DELAYS_MS rồi gửi lại ĐÚNG tin đó (sendAndWait tự
 * xoá ô nhập, gõ lại, upload lại file đính kèm bị mất nếu có attachmentPaths).
 */
export async function sendAndWaitWithRetry(
  page: Page,
  text: string,
  jobId: string,
  options: SendAndWaitOptions = {},
): Promise<Locator> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendAndWait(page, text, jobId, options);
    } catch (err) {
      const delay = SEND_REJECTED_RETRY_DELAYS_MS[attempt];
      if (!(err instanceof GeminiSendRejectedError) || delay === undefined) throw err;
      console.warn(
        `[gemini] (${jobId}) ${err.message} — chờ ${delay / 1000}s rồi gửi lại (lần ${attempt + 1}/${SEND_REJECTED_RETRY_DELAYS_MS.length}).`,
      );
      await page.waitForTimeout(delay);
    }
  }
}

export async function sendAndWait(
  page: Page,
  text: string,
  jobId: string,
  options: SendAndWaitOptions = {},
): Promise<Locator> {
  const responses = geminiResponseLocator(page);
  const countBefore = await responses.count();

  const input = await firstVisible(geminiPromptInputCandidates(page), 30_000);
  // focus() thay cho click(): UI mới của Gemini đặt thẻ file đính kèm ĐÈ trong
  // vùng ô nhập — click vào giữa ô có thể trúng thẻ/nút xoá thẻ (nghi là
  // nguyên nhân thẻ file biến mất, job b5a93ba9). Ctrl+A trong contenteditable
  // đang focus chỉ chọn chữ trong ô nhập, không đụng tới thẻ file.
  await input.focus().catch(() => input.click());
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);

  const expectedAttachments = options.attachmentPaths?.length ?? 0;
  if (expectedAttachments > 0) {
    const present = await countComposerAttachments(page);
    if (present < expectedAttachments) {
      console.warn(
        `[gemini] (${jobId}) thẻ file đính kèm biến mất khỏi ô nhập (còn ${present}/${expectedAttachments}) — upload lại.`,
      );
      await captureSnapshot(page, `${jobId}_gemini-attachment-missing`, "gemini-attachment-missing", {
        fullPage: false,
      });
      for (const filePath of options.attachmentPaths!.slice(present)) {
        await uploadFileWithRetry(page, filePath, jobId);
      }
    }
  }

  // Nút Gửi bị disable trong lúc file đính kèm (video) còn đang xử lý.
  // Không bấm Gửi khi thẻ file còn spinner upload (xem waitForComposerUploadsDone).
  await waitForComposerUploadsDone(page, jobId);
  const sendButton = await firstVisible(geminiSendButtonCandidates(page), 30_000);
  const enableDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (!(await isSendButtonEnabled(sendButton))) {
    if (Date.now() > enableDeadline) {
      throw new GeminiError("Nút Gửi của Gemini không bật sau khi chờ upload/xử lý file.");
    }
    await page.waitForTimeout(2000);
  }
  await sendButton.click();

  // Xác nhận tin đã THỰC SỰ gửi đi (job 38917089: bấm Gửi xong prompt vẫn
  // nằm nguyên trong ô nhập, bot chờ 5 phút mới báo lỗi). Chưa gửi thì thử
  // nhấn Enter 1 lần, vẫn không được thì báo lỗi ngay kèm thông báo Gemini.
  // Ghi lại MỌI snackbar hiện ra sau khi gửi — snackbar lỗi chỉ hiện vài giây,
  // tới lúc chụp debug snapshot đã tắt mất.
  const snackbarTexts = new Set<string>();
  const collectSnackbar = async (): Promise<void> => {
    const texts = await geminiSnackbarLocator(page)
      .allInnerTexts()
      .catch(() => [] as string[]);
    for (const t of texts) if (t.trim()) snackbarTexts.add(t.trim());
  };
  const snackbarNote = (): string =>
    snackbarTexts.size > 0 ? ` Gemini báo: "${[...snackbarTexts].join(" | ")}"` : "";

  let sent = false;
  if (expectedAttachments > 0) {
    // SỬA (xác nhận qua debug thật, job d84a63fa-b38c-426f-b9ae-c8cef484ee42):
    // lượt có file đính kèm KHÔNG được nhấn Enter dự phòng — bấm Gửi "không ăn"
    // lúc Gemini còn xử lý video (nút trông vẫn bật), nhưng Enter thì GỬI ĐƯỢC
    // và chỉ gửi CHỮ, BỎ video → Gemini đòi video suốt 8 lượt rồi job lỗi.
    // Thay vào đó cứ 5s bấm lại nút Gửi tới khi tin đi (tối đa UPLOAD_TIMEOUT_MS).
    const sentDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
    let nextLogAt = Date.now() + 30_000;
    while (Date.now() < sentDeadline) {
      for (let i = 0; i < 5 && !sent; i++) {
        await collectSnackbar();
        sent = await hasMessageBeenSent(page, input, countBefore);
        if (!sent) await page.waitForTimeout(1000);
      }
      if (sent) break;
      if (Date.now() >= nextLogAt) {
        nextLogAt += 30_000;
        console.log(
          `[gemini] (${jobId}) tin có file đính kèm chưa gửi được (Gemini có thể còn xử lý file) — bấm Gửi lại...`,
        );
      }
      await sendButton.click({ timeout: 10_000 }).catch(() => {});
    }
  } else {
    for (let attempt = 0; attempt < 2 && !sent; attempt++) {
      if (attempt === 1) {
        console.warn(`[gemini] (${jobId}) bấm Gửi nhưng tin chưa đi — thử nhấn Enter.`);
        await input.focus().catch(() => {});
        await page.keyboard.press("Enter");
      }
      const sentDeadline = Date.now() + 20_000;
      while (Date.now() < sentDeadline) {
        await collectSnackbar();
        if (await hasMessageBeenSent(page, input, countBefore)) {
          sent = true;
          break;
        }
        await page.waitForTimeout(1000);
      }
    }
  }
  if (!sent) {
    const attachmentNote =
      expectedAttachments > 0
        ? ` Thẻ file trong ô nhập: ${await countComposerAttachments(page)}/${expectedAttachments}.`
        : "";
    await collectSnackbar();
    throw new GeminiSendRejectedError(
      `Đã bấm Gửi nhưng Gemini không nhận tin nhắn (prompt vẫn còn trong ô nhập).${attachmentNote}${snackbarNote()}`,
    );
  }

  const start = Date.now();
  let lastText = "";
  let stableSince: number | null = null;
  let nextDebugAt = options.debugEveryMs ? start + options.debugEveryMs : Infinity;
  const debug = async (status: string): Promise<void> => {
    if (Date.now() < nextDebugAt) return;
    nextDebugAt += options.debugEveryMs!;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[gemini] (${jobId}) [debug ${elapsed}s] ${status}`);
    await captureSnapshot(
      page,
      `${jobId}_${options.debugLabel ?? "gemini-wait"}-${elapsed}s`,
      `${options.debugLabel ?? "gemini-wait"}-${elapsed}s`,
      { fullPage: false },
    );
  };
  while (true) {
    if (Date.now() - start > RESPONSE_TIMEOUT_MS) {
      throw new GeminiError(
        `Gemini chưa trả lời xong sau ${RESPONSE_TIMEOUT_MS / 60_000} phút.`,
      );
    }
    const count = await responses.count();
    const stopVisible = await geminiStopButtonLocator(page)
      .first()
      .isVisible()
      .catch(() => false);
    if (count <= countBefore) {
      await debug(`chờ Gemini bắt đầu trả lời — nút Stop: ${stopVisible ? "có" : "không"}, số lượt trả lời: ${count}.`);
      await collectSnackbar();
      // Tin bị trả về ô nhập (ô nhập trống thoáng qua rồi có chữ lại), không
      // có lượt trả lời mới, không có nút Stop → Gemini đã từ chối nhận tin.
      // Phát hiện sớm (sau 10s) thay vì chờ hết RESPONSE_START_TIMEOUT_MS.
      const restoredText = (await input.innerText().catch(() => "")).trim();
      if (!stopVisible && restoredText !== "" && Date.now() - start > 10_000) {
        await captureSnapshot(page, `${jobId}_gemini-send-rejected`, "gemini-send-rejected", {
          fullPage: false,
        });
        throw new GeminiSendRejectedError(
          `Gemini trả tin nhắn về lại ô nhập, không trả lời (lỗi tạm thời phía Gemini?).${snackbarNote()}`,
        );
      }
      if (!stopVisible && Date.now() - start > RESPONSE_START_TIMEOUT_MS) {
        throw new GeminiError(
          `Đã bấm Gửi nhưng Gemini không bắt đầu trả lời (không có lượt trả lời mới, không có nút Stop).${snackbarNote()}`,
        );
      }
      await page.waitForTimeout(2000);
      continue;
    }
    const latest = responses.last();
    const responseText = await geminiResponseContentLocator(latest)
      .innerText()
      .catch(() => "");
    // Câu trả lời CHỈ có ảnh (tạo ảnh) thì phần chữ có thể rỗng — tính cả số
    // ảnh đã tải xong vào "nội dung", nếu không vòng chờ sẽ coi là chưa có gì
    // và đợi tới hết RESPONSE_TIMEOUT_MS.
    const images = await countGeneratedImages(latest);
    const text = `${responseText}${images.total > 0 ? `\n[ảnh ${images.loaded}/${images.total}]` : ""}`;
    await debug(
      `đang chờ trả lời xong — nút Stop: ${stopVisible ? "có" : "không"}, chữ: ${responseText.length} ký tự, ảnh: ${images.loaded}/${images.total} đã tải, ổn định: ${stableSince === null ? "chưa" : `${Math.round((Date.now() - stableSince) / 1000)}s`}.`,
    );
    if (
      stopVisible ||
      text !== lastText ||
      (responseText.trim() === "" && images.loaded === 0)
    ) {
      stableSince = null;
      lastText = text;
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= RESPONSE_STABLE_MS) {
        console.log(
          `[gemini] (${jobId}) Gemini đã trả lời xong (${responseText.length} ký tự${images.total > 0 ? `, ${images.loaded}/${images.total} ảnh` : ""}, ${Math.round((Date.now() - start) / 1000)}s).`,
        );
        if (expectedAttachments > 0) {
          // Tin vừa gửi có THỰC SỰ kèm file không (job d84a63fa: gửi đi chỉ
          // có chữ). Chờ Gemini trả lời xong mới báo để lần gửi lại không đụng
          // lượt trả lời đang chạy.
          const sentFiles = await page
            .locator("user-query")
            .last()
            .locator("user-query-file-preview")
            .count()
            .catch(() => 0);
          if (sentFiles < expectedAttachments) {
            await captureSnapshot(page, `${jobId}_gemini-attachment-dropped`, "gemini-attachment-dropped", {
              fullPage: false,
            });
            throw new GeminiSendRejectedError(
              `Tin đã gửi nhưng Gemini chỉ nhận ${sentFiles}/${expectedAttachments} file đính kèm — gửi lại kèm file.`,
            );
          }
        }
        return latest;
      }
    }
    await page.waitForTimeout(2000);
  }
}

/** Đọc text + mọi khối code (theo đúng thứ tự xuất hiện) của 1 lượt trả lời. */
async function readResponse(
  page: Page,
  response: Locator,
  jobId: string,
): Promise<{ text: string; codeBlocks: string[] }> {
  const text = await geminiResponseContentLocator(response).innerText().catch(() => "");
  const blocks = await geminiCodeBlockLocator(response)
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""))
    .catch(() => [] as string[]);
  const codeBlocks = blocks.map((b) => b.trim()).filter(Boolean);
  if (codeBlocks.length === 0) {
    const canvasText = await readCanvasText(page, response, jobId);
    if (canvasText) codeBlocks.push(canvasText);
  }
  return { text, codeBlocks };
}

/**
 * Lượt trả lời đưa kết quả vào Canvas (không có khối code) — bấm mở ĐÚNG
 * Canvas của lượt này rồi đọc toàn bộ chữ trong trình soạn thảo Canvas. Xác
 * nhận qua debug thật (test-gemini-86834d87): chạy tay và bot đều ra Canvas;
 * bot không đọc Canvas nên coi như "không có JSON", gửi "Tiếp tục xử lý" →
 * Gemini hiểu thành làm tập 2, tập 3... rồi bot báo kẹt.
 */
async function readCanvasText(
  page: Page,
  response: Locator,
  jobId: string,
): Promise<string | null> {
  const chip = geminiCanvasChipLocator(response).last();
  if ((await chip.count().catch(() => 0)) === 0) return null;
  const editor = geminiCanvasEditorLocator(page).last();
  // Luôn bấm thẻ Canvas của CHÍNH lượt này — khung Canvas đang mở có thể là
  // của lượt trước.
  await chip
    .locator(".inline-preview-container, .title")
    .first()
    .click({ timeout: 10_000 })
    .catch(() => chip.click({ timeout: 10_000 }).catch(() => {}));
  await editor.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  // Chờ nội dung Canvas đứng yên (còn đang tải/stream thì đọc lại).
  let previous = "";
  for (let i = 0; i < 15; i++) {
    const current = (await editor.innerText().catch(() => "")).trim();
    if (current && current === previous) break;
    previous = current;
    await page.waitForTimeout(1000);
  }
  if (!previous) {
    console.warn(`[gemini] (${jobId}) lượt trả lời có Canvas nhưng không đọc được nội dung Canvas.`);
    return null;
  }
  const repaired = repairCanvasJson(previous);
  console.log(
    `[gemini] (${jobId}) đọc kết quả từ Canvas (${previous.length} ký tự${repaired !== previous ? ", đã sửa dấu ngoặc kép bị mất escape" : ""}).`,
  );
  return repaired;
}

/**
 * Canvas là tài liệu markdown — JSON dán vào đó MẤT ký tự escape của dấu ngoặc
 * kép bên trong chuỗi (DOM thật, test-gemini-86834d87: ...ELENA (spoken):
 * "This time..." thay vì \"This time...\"), JSON.parse lỗi. JSON trong Canvas
 * mỗi thuộc tính nằm 1 dòng → sửa theo dòng: dòng dạng `"khoá": "giá trị",`
 * thì escape mọi dấu " CHƯA escape nằm giữa 2 dấu " bao ngoài. Parse được
 * ngay thì giữ nguyên; sửa xong vẫn lỗi thì trả bản gốc (để cơ chế cứu item
 * trọn vẹn xử lý tiếp).
 */
function repairCanvasJson(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // sửa bên dưới
  }
  const repaired = raw
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*"[^"\\]+"\s*:\s*")(.*)("\s*,?\s*)$/);
      if (!match) return line;
      const inner = match[2].replace(/(?<!\\)"/g, '\\"');
      return `${match[1]}${inner}${match[3]}`;
    })
    .join("\n");
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return raw;
  }
}

/**
 * Lấy MỌI khối JSON hợp lệ trong 1 lượt, đúng thứ tự xuất hiện — Gemini hay
 * tách mỗi file/phần 1 khối code riêng trong CÙNG 1 lượt (vd cuối tập 1 + đầu
 * tập 2). Bản cũ chỉ lấy 1 khối dài nhất → khối còn lại bị bỏ ÂM THẦM (nghi là
 * nguyên nhân aladin_remake_1_tap2_full mất CHARACTER/LOCATION + VIDEO_01–05).
 * Ưu tiên khối code trong DOM; không có mới dò ```fence``` trong text.
 */
function parseJsonFromResponse(
  codeBlocks: string[],
  text: string,
): { values: unknown[]; invalidCount: number; salvagedCount: number } {
  let blocks =
    codeBlocks.length > 0
      ? codeBlocks
      : [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  // Không có khối code/Canvas/fence: Gemini có thể viết JSON thành CHỮ THƯỜNG
  // (các <p>) ngay trong câu trả lời — xác nhận qua debug thật (job
  // 299f4fb3-e8d9-4caa-b988-ae5af86cc6ec lượt 1: prompt cấm code block, Gemini
  // không mở Canvas mà dán JSON dạng chữ → bot bỏ sót toàn bộ asset +
  // VIDEO_01–03). Lấy đoạn từ "[" / "{" đầu tiên tới "]" / "}" cuối cùng,
  // sửa dấu ngoặc kép mất escape như Canvas (markdown cũng nuốt "\\").
  if (blocks.length === 0) {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    if (start >= 0 && end > start) {
      blocks = [repairCanvasJson(text.slice(start, end + 1).trim())];
    }
  }
  const values: unknown[] = [];
  let invalidCount = 0;
  let salvagedCount = 0;
  for (const block of blocks) {
    // Xác nhận qua debug thật (job 224f4d22-da13-469b-815a-c85371d90f43, lượt
    // 3): Gemini viết JSON, bị cắt giữa câu, rồi MỞ LẠI từ đầu bằng 1 fence
    // "```json" mới NGAY TRONG cùng khối code và viết đầy đủ lại. Tách khối
    // theo các fence lồng bên trong, đọc từng phần riêng.
    const pieces = block
      .split(/```(?:json)?/i)
      .map((piece) => piece.trim())
      .filter(Boolean);
    const parsedPieces = pieces.map((piece) => {
      try {
        return { ok: true as const, values: [JSON.parse(piece)] };
      } catch {
        // Nhiều giá trị JSON viết liền nhau ("{...}{...}") trong 1 phần.
        const concatenated = parseConcatenatedJson(piece);
        return concatenated
          ? { ok: true as const, values: concatenated }
          : { ok: false as const, piece };
      }
    });
    // Phần đứng SAU 1 phần bị cắt chỉ được coi là "viết lại" khi nó chứa
    // đúng id ĐẦU TIÊN của phần bị cắt. Xác nhận qua lỗi thật (người dùng
    // gửi HTML): VIDEO_01 bị cắt ở "SPEECH:", Gemini chèn ngay sau 1 fence
    // "```json" với mảng LOC_02–LOC_06 của câu chuyện KHÁC (schema khác hẳn)
    // rồi viết "ĐÃ HOÀN THÀNH" — bản cũ coi mảng lạ đó là bản viết lại → gộp
    // rác vào kết quả và chốt xong khi chưa phân tích hết video.
    let pendingBrokenId: string | null = null;
    let pendingBrokenCounted = false;
    for (const parsed of parsedPieces) {
      if (parsed.ok) {
        if (pendingBrokenId !== null) {
          // Phần bị cắt không có id nào (cắt ngay đầu) — không đối chiếu được,
          // coi phần hợp lệ phía sau là bản viết lại như trước.
          const isRewrite =
            pendingBrokenId === "" ||
            parsed.values.some((v) =>
              JSON.stringify(v).includes(`"id":${JSON.stringify(pendingBrokenId)}`),
            );
          if (!isRewrite) {
            console.warn(
              `[gemini] bỏ 1 khối JSON lạ chèn sau phần bị cắt (không chứa "${pendingBrokenId}"): ${JSON.stringify(parsed.values).slice(0, 150)}`,
            );
            if (!pendingBrokenCounted) {
              invalidCount++;
              pendingBrokenCounted = true;
            }
            continue;
          }
          // Viết lại hợp lệ — phần bị cắt trước đó không còn tính là hỏng.
          if (pendingBrokenCounted) invalidCount--;
          pendingBrokenId = null;
          pendingBrokenCounted = false;
        }
        values.push(...parsed.values);
        continue;
      }
      // Phần hỏng: cứu các item trọn vẹn, tạm tính là "khối hỏng" (bắt Gemini
      // gửi lại) cho tới khi gặp 1 phần viết lại hợp lệ phía sau.
      const salvaged = salvageTruncatedJson(parsed.piece);
      if (salvaged !== null) {
        values.push(salvaged);
        salvagedCount++;
      }
      if (pendingBrokenId === null || !pendingBrokenCounted) {
        invalidCount++;
        pendingBrokenCounted = true;
      }
      pendingBrokenId =
        parsed.piece.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? pendingBrokenId ?? "";
    }
  }
  return { values, invalidCount, salvagedCount };
}

/**
 * Cứu phần đã viết TRỌN VẸN trong 1 khối JSON bị cắt giữa chừng — xác nhận qua
 * HTML hội thoại thật (gemini-82105d327ab826a4, job aladin_remake_1): Gemini
 * hay tự cắt khối code dài rồi chèn luôn 1 câu chat ("Bạn muốn tiếp tục xử lý
 * phần nào...") vào BÊN TRONG khối, 4 lượt liên tiếp như vậy làm mất trắng
 * CHARACTER/LOCATION + VIDEO_01–05 của tập 2 dù các item đầu đã viết đủ.
 * Quét theo cấu trúc ngoặc (bỏ qua ký tự trong chuỗi), lấy điểm cắt muộn nhất
 * ngay sau 1 ITEM hoàn chỉnh của mảng ngoài cùng, đóng các ngoặc còn mở rồi parse lại.
 */
function salvageTruncatedJson(raw: string): unknown | null {
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  const text = raw.slice(start);
  const stack: string[] = [];
  const cutPoints: { end: number; closers: string }[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) break;
      // Chỉ cắt sau 1 ITEM của mảng item ngoài cùng (mảng "[" đầu tiên trong
      // stack — vd {"tap.json": [ ...item... ]}) — KHÔNG cắt sau phần tử của
      // mảng con (vd "ref" bên trong VIDEO), nếu không sẽ giữ lại VIDEO viết dở
      // (có ref nhưng thiếu prompt).
      if (stack.indexOf("[") === stack.length - 1) {
        const closers = [...stack]
          .reverse()
          .map((open) => (open === "[" ? "]" : "}"))
          .join("");
        cutPoints.push({ end: i + 1, closers });
      }
    }
  }
  for (let k = cutPoints.length - 1; k >= 0 && k >= cutPoints.length - 5; k--) {
    try {
      return JSON.parse(text.slice(0, cutPoints[k].end) + cutPoints[k].closers);
    } catch {
      // thử điểm cắt sớm hơn
    }
  }
  return null;
}

/**
 * Tách 1 chuỗi gồm NHIỀU giá trị JSON top-level viết liền nhau ("{..}{..}",
 * "[..]\n[..]") — null nếu chỉ có 1 giá trị hoặc có phần không parse được.
 */
function parseConcatenatedJson(raw: string): unknown[] | null {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          return null;
        }
        start = -1;
      }
    } else if (depth === 0 && !/[\s,]/.test(ch)) {
      return null;
    }
  }
  return depth === 0 && values.length > 1 ? values : null;
}

/** Khoá chống trùng 1 item: "<type>:<id>" — null nếu item không có id. */
function itemKey(item: unknown): string | null {
  if (!item || typeof item !== "object" || !("id" in item)) return null;
  const { id, type } = item as { id?: unknown; type?: unknown };
  return id === undefined ? null : `${String(type ?? "")}:${String(id)}`;
}

/** Bỏ item trùng type+id trong mảng — giữ VỊ TRÍ lần đầu, NỘI DUNG lần sau cùng. */
function dedupeById(items: unknown[]): unknown[] {
  const result: unknown[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    const key = itemKey(item);
    if (key === null) {
      result.push(item);
      continue;
    }
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, result.length);
      result.push(item);
    } else {
      result[index] = item;
    }
  }
  return result;
}

/**
 * mergeJsonPartAuto (dùng chung với Qwen) + chống trùng: Gemini hay gửi LẠI
 * từ đầu sau 1 lượt bị cắt (vd lượt 5 hội thoại aladin gửi lại toàn bộ
 * CHAR/LOC + VIDEO_01 đã có ở lượt 4), cộng với item cứu được từ khối hỏng
 * (salvageTruncatedJson) — nối thẳng sẽ ra item lặp.
 */
function mergeGeminiPart(state: MergeState, part: unknown, jobId: string, turn: number): void {
  mergeJsonPartAuto(state, part, jobId, turn);
  if (state.kind === "array") {
    state.items = dedupeById(state.items);
  } else if (state.kind === "object") {
    for (const [key, value] of Object.entries(state.obj)) {
      if (Array.isArray(value)) state.obj[key] = dedupeById(value);
    }
  }
}

function buildFirstTurnInstruction(): string {
  return `## QUY TẮC TRẢ KẾT QUẢ — BẮT BUỘC (đọc kỹ)

- Đặt TOÀN BỘ kết quả JSON trong khối code \`\`\`json ... \`\`\` ngay trong câu trả lời — KHÔNG dùng Canvas, KHÔNG viết JSON dạng chữ thường ngoài khối code. KHÔNG tạo file, KHÔNG gửi link tải.
- Giữ ĐÚNG schema mà yêu cầu phía trên mô tả (JSON ARRAY hoặc JSON OBJECT) và NHẤT QUÁN kiểu đó qua mọi lượt.
- Nếu yêu cầu phía trên cần NHIỀU FILE JSON (vd nhiều tập), trả 1 JSON OBJECT có key là TÊN FILE (kết thúc bằng ".json"), value là nội dung đầy đủ của file đó.
- KHÔNG cố xuất toàn bộ trong 1 lượt: chia NHIỀU LƯỢT, mỗi lượt ĐÚNG MỘT khối code JSON HỢP LỆ, ĐÃ ĐÓNG NGOẶC ĐẦY ĐỦ, chỉ chứa phần MỚI chưa gửi (array: các item tiếp theo; object: các key mới, hoặc key là mảng thì chỉ các phần tử mới của mảng đó).
- KÍCH THƯỚC MỖI LƯỢT: mỗi khối JSON KHÔNG vượt quá khoảng ${config.geminiMaxCharsPerTurn} ký tự — đây CHỈ là giới hạn để CHIA LƯỢT, KHÔNG phải giới hạn độ dài kết quả. Sắp chạm mức đó thì dừng ở item TRỌN VẸN gần nhất, đóng ngoặc, phần còn lại gửi ở lượt sau.
- TUYỆT ĐỐI KHÔNG rút gọn, gộp clip, bỏ bớt shot/clip/VIDEO hay viết ngắn prompt lại để cho vừa giới hạn — kết quả cuối cùng phải ĐẦY ĐỦ đúng như yêu cầu phía trên (vd giữ đủ số shot/clip/VIDEO theo khung kỹ thuật), dài bao nhiêu thì chia bấy nhiêu lượt.
- KHÔNG viết thêm bất kỳ câu chữ nào BÊN TRONG khối code ngoài JSON; thông báo "${DONE_MARKER}" (nếu có) viết NGOÀI khối code.
- Ưu tiên tuyệt đối việc đóng JSON hợp lệ: nếu sắp hết chỗ, dừng ở item trước đó và gửi tiếp ở lượt sau.
- Ở CUỐI câu trả lời của LƯỢT CUỐI CÙNG (đã gửi đủ toàn bộ), sau khối code, viết đúng nguyên văn: ${DONE_MARKER}
- TUYỆT ĐỐI KHÔNG viết "${DONE_MARKER}" khi vẫn còn phần chưa gửi.
- Lượt nào khối JSON đã chạm/vượt ~${config.geminiMaxCharsPerTurn} ký tự thì lượt đó KHÔNG ĐƯỢC viết "${DONE_MARKER}" hay "Đã hoàn thành" (kể cả câu tổng kết "Đã hoàn thành ..." mà yêu cầu phía trên quy định) — dừng ở item trọn vẹn, chờ tin nhắn "Tiếp tục xử lý" rồi gửi phần còn lại. Câu "${DONE_MARKER}"/tổng kết CHỈ được viết ở lượt cuối cùng, khi đã THẬT SỰ gửi hết toàn bộ nội dung.`;
}

/**
 * Khoá bắt buộc của item theo master prompt — đọc từ 2 dòng quy định schema
 * trong prompt, vd prompt_video_reference.txt / prompt_generate_script.txt:
 *   Asset đúng 5 khóa: {"id":string,"type":"CHARACTER"|"LOCATION","ref":[],"prompt":string,"duration":0}.
 *   VIDEO đúng 9 khóa: {"id":string,"type":"VIDEO","ref":[...],"prompt":string,"duration":number,"shot":integer,...}.
 * Prompt không có dòng nào như vậy thì không kiểm tra (null).
 */
interface ItemSchema {
  video?: string[];
  asset?: string[];
  /**
   * Giá trị "type" hợp lệ (đọc từ "type":"CHARACTER"|"LOCATION" và
   * "type":"VIDEO" trong dòng schema). Xác nhận qua lỗi thật (hội thoại
   * gemini-05dee6b46cfb2d1f): Gemini mất ngữ cảnh, bịa item
   * {"type":"character_scene","ref":"scene_01",...} — đủ 5 khoá nên lọt qua
   * nếu chỉ kiểm tra tên khoá.
   */
  types?: string[];
}

function extractItemSchema(text: string): ItemSchema | null {
  const schema: ItemSchema = {};
  for (const m of text.matchAll(/\b(Asset|VIDEO)\s+đúng\s+\d+\s+khóa\s*:\s*(\{.*)/gi)) {
    // Chỉ lấy khoá CẤP NGOÀI: bỏ phần lồng trong "ref":[{...}].
    const topLevel = m[2].replace(/\[[^\]]*\]/g, "[]");
    const keys = [...new Set([...topLevel.matchAll(/"([A-Za-z_]+)"\s*:/g)].map((k) => k[1]))];
    if (keys.length === 0) continue;
    const typeValues = topLevel.match(/"type"\s*:\s*((?:"[A-Z_]+"\s*\|?\s*)+)/)?.[1];
    for (const t of typeValues?.matchAll(/"([A-Z_]+)"/g) ?? []) {
      schema.types = [...new Set([...(schema.types ?? []), t[1]])];
    }
    if (m[1].toUpperCase() === "VIDEO") schema.video = keys;
    else schema.asset = keys;
  }
  return schema.video || schema.asset ? schema : null;
}

/** Item thiếu khoá bắt buộc (hoặc "prompt" rỗng) theo schema — trả về danh sách khoá thiếu. */
function missingItemKeys(item: unknown, schema: ItemSchema): string[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const record = item as Record<string, unknown>;
  const required = record.type === "VIDEO" ? schema.video : schema.asset;
  if (!required) {
    return schema.types && !schema.types.includes(String(record.type))
      ? [`type "${String(record.type)}" không hợp lệ`]
      : [];
  }
  const missing = required.filter((key) => !(key in record));
  if (schema.types && !schema.types.includes(String(record.type))) {
    missing.push(`type "${String(record.type)}" không hợp lệ (chỉ nhận ${schema.types.join("/")})`);
  }
  if ("ref" in record && required.includes("ref") && !Array.isArray(record.ref)) {
    missing.push("ref phải là mảng");
  }
  if ("prompt" in record && required.includes("prompt") && typeof record.prompt === "string" && record.prompt.trim() === "") {
    missing.push("prompt (rỗng)");
  }
  return missing;
}

/**
 * Bỏ các item THIẾU field khỏi 1 phần JSON (mảng item, hoặc object nhiều file
 * {"<tên>.json": [...]}) — theo yêu cầu người dùng: item VIDEO chưa đủ field
 * không được gộp vào kết quả, bắt Gemini gửi lại đầy đủ.
 */
function dropIncompleteItems(
  value: unknown,
  schema: ItemSchema,
): { value: unknown; dropped: string[] } {
  const dropped: string[] = [];
  const filterArray = (items: unknown[]): unknown[] =>
    items.filter((item) => {
      const missing = missingItemKeys(item, schema);
      if (missing.length === 0) return true;
      const id = (item as { id?: unknown }).id;
      dropped.push(`${id === undefined ? "(không id)" : String(id)} [thiếu: ${missing.join(", ")}]`);
      return false;
    });
  if (Array.isArray(value)) return { value: filterArray(value), dropped };
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = Array.isArray(val) ? filterArray(val) : val;
    }
    return { value: result, dropped };
  }
  return { value, dropped };
}

function buildContinueMessage(
  state: MergeState,
  lastTurnInvalid: boolean,
  incompleteItems: string[] = [],
): string {
  const incompleteWarning =
    incompleteItems.length > 0
      ? `Các item sau THIẾU field bắt buộc nên bot KHÔNG nhận: ${incompleteItems.join("; ")}. Gửi lại ĐẦY ĐỦ các item này (đủ mọi khóa theo đúng schema ở tin nhắn đầu), rồi mới gửi tiếp phần sau.\n\n`
      : "";
  const invalidWarning = lastTurnInvalid && incompleteItems.length === 0
    ? `Lượt vừa rồi có khối JSON bị cắt giữa chừng — bot CHỈ giữ được các item đã viết trọn vẹn (xem trạng thái bên dưới), phần còn lại bị mất. Gửi tiếp NGAY SAU item cuối bot đã có (không quá ~${config.geminiMaxCharsPerTurn} ký tự), đóng ngoặc đầy đủ, đặt trong 1 khối code \`\`\`json\`\`\` (không dùng Canvas), không viết chữ nào khác trong khối code.\n\n`
    : "";
  return `${incompleteWarning}${invalidWarning}Tiếp tục gửi phần tiếp theo (1 khối code \`\`\`json\`\`\` hợp lệ — KHÔNG dùng Canvas, chỉ phần MỚI chưa gửi), đúng quy tắc đã nêu ở lượt đầu.

Trạng thái bot đã gom được (dựa CHÍNH XÁC vào đây để biết tiếp tục từ đâu):
${describeMergeState(state)}

Chỉ viết "${DONE_MARKER}" ở cuối khi đã gửi đủ toàn bộ.`;
}

/** Ghi kết quả đã gộp ra file — object có MỌI key là "*.json" thì tách thành nhiều file. */
async function saveMergedResult(
  state: MergeState,
  baseName: string,
  /** true khi nơi gọi truyền tên gốc (tên video/file prompt) — xem nhánh 1 key bên dưới. */
  hasSourceName = false,
): Promise<string[]> {
  await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
  if (state.kind === "object") {
    const keys = Object.keys(state.obj);
    // Object chỉ có ĐÚNG 1 key "*.json" mà nơi gọi có tên gốc → lưu theo tên
    // gốc, KHÔNG theo tên key. Xác nhận qua lỗi thật (lô "Tham chiếu video"
    // 10 video): ep09_amchen.mp4 ra "01_source_reference_full.json" — Gemini
    // chép đúng tên ví dụ trong prompt; 2 video cùng làm vậy sẽ GHI ĐÈ nhau.
    if (hasSourceName && keys.length === 1 && /\.json$/i.test(keys[0])) {
      const filePath = path.join(config.chatAIResultsDir, `${baseName}.json`);
      await fs.promises.writeFile(filePath, JSON.stringify(state.obj[keys[0]], null, 2), "utf-8");
      return [filePath];
    }
    if (keys.length > 0 && keys.every((k) => /\.json$/i.test(k))) {
      const files: string[] = [];
      for (const key of keys) {
        const filePath = path.join(config.chatAIResultsDir, path.basename(key));
        await fs.promises.writeFile(filePath, JSON.stringify(state.obj[key], null, 2), "utf-8");
        files.push(filePath);
      }
      return files;
    }
  }
  const data = state.kind === "array" ? state.items : state.obj;
  const filePath = path.join(config.chatAIResultsDir, `${baseName}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  return [filePath];
}

function hasData(state: MergeState): boolean {
  return state.kind === "array"
    ? state.items.length > 0
    : state.kind === "object" && Object.keys(state.obj).length > 0;
}

/**
 * Clone askChatAI (chatAI.ts) cho Gemini web — cùng chữ ký/giá trị trả về.
 * attachmentPath (nếu có) được upload lên composer trước khi gửi prompt (file
 * kịch bản .txt hoặc video).
 */
export interface AskGeminiOptions {
  /**
   * Số file JSON kết quả BẮT BUỘC phải có (kết quả dạng object key "*.json",
   * xem saveMergedResult) — vd "Tạo kịch bản mới" nhiều tập: mỗi tập tham
   * chiếu 1 file. Chưa đủ thì KHÔNG chấp nhận "ĐÃ HOÀN THÀNH", nhắc Gemini
   * làm tiếp các tập còn thiếu. Xác nhận qua debug thật (job
   * 224f4d22-da13-469b-815a-c85371d90f43): 2 tập tham chiếu nhưng Gemini chỉ
   * làm tập 02 rồi tự báo "ĐÃ HOÀN THÀNH".
   */
  expectedFileCount?: number;
  /** Tên các file tham chiếu — chỉ để liệt kê trong tin nhắc. */
  expectedSourceNames?: string[];
}

/**
 * Nhắc lại ngữ cảnh khi Gemini quên lượt đầu (vẫn trong CÙNG cuộc chat) —
 * xác nhận qua debug thật (job 299f4fb3, c18f28de: "hệ thống hiện không lưu
 * trữ bối cảnh của các tin nhắn trước đó"). Gửi kèm prompt gốc (nơi gọi ghép
 * phía trước) + danh sách id đã có + 2 item cuối để nối mạch + nhiệm vụ lượt này.
 */
function buildContextReminder(state: MergeState, task: string): string {
  const lists: Array<{ label: string; items: unknown[] }> =
    state.kind === "array"
      ? [{ label: "kết quả", items: state.items }]
      : state.kind === "object"
        ? Object.entries(state.obj)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => ({ label: k, items: v as unknown[] }))
        : [];
  const idLines = lists
    .map(
      ({ label, items }) =>
        `- ${label}: ${items.length} item — id: ${items
          .map((i) => String((i as { id?: unknown })?.id ?? "?"))
          .join(", ")}`,
    )
    .join("\n");
  const last = lists.at(-1);
  const tail = last ? last.items.slice(-2) : [];
  return `## NHẮC LẠI NGỮ CẢNH — TIẾP TỤC KẾT QUẢ ĐANG LÀM DỞ
Toàn bộ yêu cầu gốc và file đính kèm được gửi lại ở trên. Bot ĐÃ nhận và lưu các phần trước — KHÔNG gửi lại các item đã có:
${idLines || "(chưa có item nào)"}

${tail.length > 0 ? `Các item CUỐI CÙNG đã có (để nối mạch, KHÔNG gửi lại):\n\`\`\`json\n${JSON.stringify(tail, null, 2)}\n\`\`\`\n\n` : ""}Nhiệm vụ lượt này (tiếp tục NGAY SAU item cuối đã có, theo đúng định dạng yêu cầu gốc):
${task}`;
}

/** Số lượt liên tiếp không thêm được item hợp lệ nào thì coi là Gemini kẹt. */
const STUCK_TURN_LIMIT = 3;

/** Tổng số item đã gom (array: số item; object: tổng phần tử các mảng + số key không phải mảng). */
function countMergedItems(state: MergeState): number {
  if (state.kind === "array") return state.items.length;
  if (state.kind === "object") {
    return Object.values(state.obj).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 1),
      0,
    );
  }
  return 0;
}

/** Số file JSON đã gom (key "*.json" của kết quả object). */
function collectedFileKeys(state: MergeState): string[] {
  return state.kind === "object"
    ? Object.keys(state.obj).filter((k) => /\.json$/i.test(k))
    : [];
}

function buildOversizeDoneMessage(state: MergeState, turnJsonChars: number): string {
  return `Tiếp tục xử lý — lượt vừa rồi khối JSON dài ${turnJsonChars} ký tự (vượt giới hạn ~${config.geminiMaxCharsPerTurn} ký tự/lượt) nên CHƯA được coi là hoàn thành. Nếu còn BẤT KỲ phần nào chưa gửi (item/VIDEO/shot/clip còn thiếu so với yêu cầu), gửi tiếp NGAY SAU item cuối đã gửi (1 khối code \`\`\`json\`\`\` hợp lệ, không quá ~${config.geminiMaxCharsPerTurn} ký tự). Nếu đã gửi ĐỦ TOÀN BỘ thật sự, chỉ trả lời đúng "${DONE_MARKER}" (không gửi lại JSON). ${describeMergeState(state).replace(/\n/g, " ")}`;
}

function buildMissingFilesMessage(
  state: MergeState,
  options: AskGeminiOptions,
): string {
  const have = collectedFileKeys(state);
  const sources = options.expectedSourceNames?.length
    ? ` (tham chiếu: ${options.expectedSourceNames.join(", ")})`
    : "";
  return `Tiếp tục xử lý — CHƯA XONG: kết quả phải có ĐỦ ${options.expectedFileCount} file JSON, mỗi tập tham chiếu 1 file${sources}. Hiện bot mới nhận ${have.length} file: ${have.join(", ") || "(chưa có)"}. Làm tiếp các tập CÒN THIẾU theo đúng quy tắc ở tin nhắn đầu (JSON OBJECT, key là TÊN FILE MỚI kết thúc ".json", không lặp lại file đã gửi, mỗi lượt không quá ~${config.geminiMaxCharsPerTurn} ký tự). Chỉ viết "${DONE_MARKER}" khi đã gửi đủ ${options.expectedFileCount} file.`;
}

export async function askGemini(
  prompt: string,
  jobId: string,
  promptFileName?: string,
  attachmentPath?: string,
  options: AskGeminiOptions = {},
): Promise<{ downloadedFiles: string[] }> {
  console.log(`[gemini] askGemini(${jobId}): bắt đầu — mở Gemini...`);
  const page = await openGeminiPage(jobId);
  const baseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : jobId;
  try {
    // Upload lỗi thì thử lại tới khi thành công (xem uploadFileWithRetry) —
    // lượt đầu nên được phép tải lại trang.
    if (attachmentPath) {
      await uploadFileWithRetry(page, attachmentPath, jobId, { allowReload: true });
    }
    // await captureSnapshot(page, `${jobId}_gemini-before-send`, "gemini-before-send");

    const state: MergeState = { kind: "unset", items: [], obj: {} };
    // Khoá bắt buộc của item — đọc từ master prompt (prompt, hoặc file .txt
    // đính kèm với "Tạo kịch bản mới"), xem extractItemSchema.
    const schemaSource = `${prompt}\n${
      attachmentPath && /\.(txt|md)$/i.test(attachmentPath)
        ? await fs.promises.readFile(attachmentPath, "utf-8").catch(() => "")
        : ""
    }`;
    const itemSchema = extractItemSchema(schemaSource);
    if (itemSchema) {
      console.log(
        `[gemini] askGemini(${jobId}): kiểm tra field bắt buộc — VIDEO: ${itemSchema.video?.join(",") ?? "-"}; asset: ${itemSchema.asset?.join(",") ?? "-"}.`,
      );
    }
    const expectedFileCount = options.expectedFileCount ?? 0;
    const fileCountNote =
      expectedFileCount > 1
        ? `\n- Kết quả lần này gồm ĐÚNG ${expectedFileCount} FILE JSON (mỗi tập tham chiếu 1 file) — trả JSON OBJECT với ${expectedFileCount} key TÊN FILE; làm lần lượt từng tập, CHỈ viết "${DONE_MARKER}" sau khi đã gửi đủ cả ${expectedFileCount} file.`
        : "";
    const firstTurnMessage = `${prompt}\n\n${buildFirstTurnInstruction()}${fileCountNote}`;
    let messageToSend = firstTurnMessage;
    // Lượt trước không thêm được item nào (thường do Gemini web QUÊN lượt
    // đầu — xem buildContextReminder) → lượt này nhắc lại toàn bộ ngữ cảnh.
    let remindContext = false;
    // let messageToSend = `${prompt}`;
    let done = false;
    // Phát hiện kẹt: STUCK_TURN_LIMIT lượt liên tiếp không có thêm item hợp lệ
    // nào (vd hội thoại gemini-05dee6b46cfb2d1f: 27 lượt liền Gemini lặp item
    // rác "VID_024" thiếu field) → dừng cuộc chat này thay vì lặp tới hết
    // geminiMaxTurns (nơi gọi có thể thử lại bằng cuộc chat mới).
    let turnsWithoutProgress = 0;
    for (let turn = 1; turn <= config.geminiMaxTurns; turn++) {
      console.log(
        `[gemini] askGemini(${jobId}): lượt ${turn}/${config.geminiMaxTurns} — gửi, đang chờ Gemini trả lời...`,
      );
      if (remindContext) {
        console.warn(
          `[gemini] askGemini(${jobId}): lượt trước không có item mới (Gemini có thể đã quên ngữ cảnh) — lượt ${turn} gửi lại prompt gốc${attachmentPath ? " + upload lại file" : ""} trong cùng cuộc chat.`,
        );
        if (attachmentPath) await uploadFileWithRetry(page, attachmentPath, jobId);
        messageToSend = `${firstTurnMessage}\n\n${buildContextReminder(state, messageToSend)}`;
      }
      const response = await sendAndWaitWithRetry(page, messageToSend, jobId, {
        attachmentPaths:
          (turn === 1 || remindContext) && attachmentPath ? [attachmentPath] : undefined,
      });
      if (turn === 1) {
        console.log(`[gemini] askGemini(${jobId}): url hội thoại: ${page.url()}`);
      }
      await captureSnapshot(page, `${jobId}_gemini-turn-${turn}`, `gemini-turn-${turn}`);

      const { text, codeBlocks } = await readResponse(page, response, jobId);
      const parsedResponse = parseJsonFromResponse(codeBlocks, text);
      const { salvagedCount } = parsedResponse;
      let { invalidCount } = parsedResponse;
      const incompleteItems: string[] = [];
      const itemCountBefore = countMergedItems(state);
      for (const value of parsedResponse.values) {
        const { value: complete, dropped } = itemSchema
          ? dropIncompleteItems(value, itemSchema)
          : { value, dropped: [] as string[] };
        incompleteItems.push(...dropped);
        mergeGeminiPart(state, complete, jobId, turn);
      }
      if (incompleteItems.length > 0) {
        console.warn(
          `[gemini] askGemini(${jobId}): lượt ${turn} có ${incompleteItems.length} item thiếu field — bỏ qua, yêu cầu gửi lại: ${incompleteItems.join("; ")}`,
        );
        invalidCount++;
      }
      // Theo yêu cầu người dùng: chấp nhận cả "Đã hoàn thành" (và mọi kiểu
      // viết hoa/thường khác) — Gemini hay không viết đúng nguyên văn in hoa.
      if (countMergedItems(state) > itemCountBefore) {
        turnsWithoutProgress = 0;
        remindContext = false;
      } else if (++turnsWithoutProgress >= STUCK_TURN_LIMIT) {
        throw new GeminiError(
          `Gemini kẹt: ${STUCK_TURN_LIMIT} lượt liên tiếp không có thêm item hợp lệ nào (lượt ${turn}) — dừng cuộc chat này.`,
        );
      }
      const sawDone = text
        .normalize("NFC")
        .toLowerCase()
        .includes(DONE_MARKER.normalize("NFC").toLowerCase());
      if (invalidCount > 0) {
        console.warn(
          `[gemini] askGemini(${jobId}): lượt ${turn} có ${invalidCount} khối code KHÔNG parse được JSON (bị cắt/hỏng, cứu được phần trọn vẹn của ${salvagedCount} khối) — yêu cầu Gemini gửi tiếp từ sau phần đã nhận.`,
        );
      }

      // Lượt có khối JSON hỏng thì KHÔNG chốt dù có marker — phần hỏng chưa
      // vào kết quả, phải để Gemini gửi lại.
      const missingFiles =
        expectedFileCount > 1 && collectedFileKeys(state).length < expectedFileCount;
      // Theo yêu cầu người dùng: lượt có JSON chạm/vượt geminiMaxCharsPerTurn
      // thì KHÔNG được coi là xong dù có "Đã hoàn thành" — xác nhận qua debug
      // thật (test-gemini-27a9cf06 lượt 1: 18/25 VIDEO trong 1 khối 21.650 ký
      // tự kèm "Đã hoàn thành"). Nhắc gửi tiếp; nếu đã đủ thật thì lượt sau
      // Gemini chỉ cần trả lời "ĐÃ HOÀN THÀNH" (khối JSON nhỏ/không có).
      const turnJsonChars = codeBlocks.reduce((sum, block) => sum + block.length, 0);
      const oversizeTurn = turnJsonChars >= config.geminiMaxCharsPerTurn;
      if (sawDone && invalidCount === 0 && oversizeTurn && !missingFiles) {
        console.warn(
          `[gemini] askGemini(${jobId}): lượt ${turn} có JSON ${turnJsonChars} ký tự (≥ ${config.geminiMaxCharsPerTurn}) mà báo "${DONE_MARKER}" — chưa chấp nhận, nhắc gửi tiếp phần còn lại.`,
        );
        messageToSend = buildOversizeDoneMessage(state, turnJsonChars);
        continue;
      }
      if (sawDone && invalidCount === 0 && hasData(state) && !missingFiles) {
        done = true;
        break;
      }
      if (sawDone && invalidCount === 0 && missingFiles) {
        console.warn(
          `[gemini] askGemini(${jobId}): Gemini báo "${DONE_MARKER}" nhưng mới có ${collectedFileKeys(state).length}/${expectedFileCount} file JSON — nhắc làm tiếp các tập còn thiếu.`,
        );
        messageToSend = buildMissingFilesMessage(state, options);
        continue;
      }
      // Theo yêu cầu người dùng: chưa có marker "ĐÃ HOÀN THÀNH" thì chỉ gửi
      // đúng "Tiếp tục xử lý". NGOẠI LỆ: lượt vừa rồi có khối JSON hỏng thì
      // gửi tin nhắc chi tiết (kèm trạng thái đã gom) — chỉ "Tiếp tục xử lý"
      // thì Gemini tưởng phần hỏng đã nhận, viết tiếp phần sau → mất dữ liệu.
      messageToSend =
        invalidCount > 0 || sawDone
          ? buildContinueMessage(state, invalidCount > 0, incompleteItems)
          : buildShortContinueMessage(state);
      // Lượt này không thêm item nào và chưa xong → lượt sau nhắc lại ngữ cảnh.
      remindContext = turnsWithoutProgress > 0;
    }

    if (!hasData(state)) {
      throw new GeminiError(
        `Gemini không trả về JSON hợp lệ nào sau ${config.geminiMaxTurns} lượt.`,
      );
    }
    if (!done) {
      console.warn(
        `[gemini] askGemini(${jobId}): hết ${config.geminiMaxTurns} lượt mà chưa thấy "${DONE_MARKER}" — vẫn lưu phần đã gom được (có thể chưa đầy đủ).`,
      );
    }
    const files = await saveMergedResult(state, baseName, Boolean(promptFileName));
    console.log(`[gemini] askGemini(${jobId}): xong — đã lưu ${files.join(", ")}.`);
    return { downloadedFiles: files };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GeminiError
      ? err
      : new GeminiError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
    // Lưu cookie phiên mới nhất (Google xoay vòng cookie) — xem persistSession.
    await getGeminiBrowserContext.saveSession();
  }
}

/** Clone askChatAIAboutReferenceVideo (chatAI.ts) cho Gemini — upload video + master prompt. */
export async function askGeminiAboutReferenceVideo(
  videoPath: string,
  jobId: string,
  videoFileName?: string,
  extraInstruction?: string,
  masterPromptPath: string = config.promptSplitVideo,
): Promise<{ downloadedFiles: string[] }> {
  const masterPrompt = await fs.promises.readFile(masterPromptPath, "utf-8");
  const prompt = extraInstruction
    ? `${masterPrompt}\n\n## YÊU CẦU BỔ SUNG TỪ NGƯỜI DÙNG (ưu tiên áp dụng, có thể bật TRANSFORM_MODE hoặc điều chỉnh khác so với mặc định ở trên)\n${extraInstruction}`
    : masterPrompt;
  return askGemini(prompt, jobId, videoFileName, videoPath);
}

/** Master prompt kiểm tra video — dùng chung với verifyVideo (chatAI.ts). */
const VERIFY_VIDEO_PROMPT_TEMPLATE_PATH = path.resolve("./src/automation/check_video.txt");

/**
 * Bản Gemini của verifyVideo (chatAI.ts) — cùng tham số, cùng template
 * check_video.txt, cùng thứ tự upload (video liền trước → video hiện tại →
 * ảnh ref ĐÚNG THỨ TỰ), cùng đầu ra: JSON kết quả lưu cạnh video, tên
 * <id video>.json. Gửi ĐÚNG 1 lượt, không lặp "Tiếp tục".
 */
export async function verifyVideoGemini(
  prompt: string,
  refs: { id: string; path: string }[],
  videoPath: string,
  previousVideoPath?: string,
): Promise<{ filePath: string }> {
  const id = path.basename(videoPath, path.extname(videoPath));
  const jobId = `${id}_verify`;
  console.log(`[gemini] verifyVideoGemini(${id}): bắt đầu — mở Gemini...`);
  const page = await openGeminiPage(jobId);
  try {
    const attachmentPaths = [
      ...(previousVideoPath ? [previousVideoPath] : []),
      videoPath,
      ...refs.map((ref) => ref.path),
    ];
    for (const [i, filePath] of attachmentPaths.entries()) {
      // Chỉ file đầu được phép tải lại trang (tải lại sẽ mất các thẻ đã upload).
      await uploadFileWithRetry(page, filePath, jobId, { allowReload: i === 0 });
    }

    const template = await fs.promises.readFile(VERIFY_VIDEO_PROMPT_TEMPLATE_PATH, "utf-8");
    const refsListing = refs.map((ref) => `- ${ref.id}: ${ref.id}.png`).join("\n");
    const generatedVideoBlock = [
      `- Tên file: ${id}.mp4`,
      "- Đây là video hiện tại cần đánh giá.",
      "- So sánh frame có ý nghĩa đầu tiên với video trước.",
    ].join("\n");
    const previousVideoBlock = previousVideoPath
      ? [
          `- Tên file: ${path.basename(previousVideoPath, path.extname(previousVideoPath))}.mp4`,
          "- Đây là video liền trước.",
          "- Dùng frame có ý nghĩa cuối cùng của video này để kiểm tra continuity.",
        ].join("\n")
      : "Không có.";
    const message = `${template
      .replace("[DÁN PROMPT ĐÃ DÙNG ĐỂ TẠO VIDEO VÀO ĐÂY]", prompt)
      .replace("[LIỆT KÊ TẤT CẢ ẢNH THAM CHIẾU VÀ ID]", refsListing)
      .replace("[MÔ TẢ VIDEO NGAY TRƯỚC ĐÓ NẾU CÓ]", previousVideoBlock)
      .replace("[MÔ TẢ VIDEO HIỆN TẠI CẦN ĐÁNH GIÁ]", generatedVideoBlock)}\n\nTrả kết quả JSON trong MỘT khối code (code block).`;

    const response = await sendAndWaitWithRetry(page, message, jobId, { attachmentPaths });
    await captureSnapshot(page, jobId, "result");

    const { text, codeBlocks } = await readResponse(page, response, jobId);
    const { values } = parseJsonFromResponse(codeBlocks, text);
    if (values.length === 0) {
      throw new GeminiError(`Gemini không trả kết quả JSON nào cho video "${id}".`);
    }
    const result = values.length === 1 ? values[0] : values;

    const filePath = path.join(path.dirname(videoPath), `${id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`[gemini] verifyVideoGemini(${id}): đã lưu kết quả ${filePath}`);
    return { filePath };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GeminiError
      ? err
      : new GeminiError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => {});
  }
}
