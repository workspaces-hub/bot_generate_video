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
  return `Tiếp tục xử lý — gửi tiếp phần JSON kế tiếp của kết quả đang làm ở trên (1 khối \`\`\`json\`\`\`, NHIỀU item mới nhất có thể nhưng KHÔNG quá ~${config.geminiMaxCharsPerTurn} ký tự, đúng quy tắc ở tin nhắn đầu). ${describeMergeState(state).replace(/\n/g, " ")} Chỉ viết "${DONE_MARKER}" khi đã gửi đủ toàn bộ.`;
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
  if (!label) return;
  try {
    const menuButton = await firstVisible(geminiModelMenuButtonCandidates(page), 5000);
    const current = (await menuButton.innerText().catch(() => "")).trim();
    if (current.toLowerCase().includes(label.toLowerCase())) {
      console.log(`[gemini] (${jobId}) model hiện tại "${current}" đã khớp "${label}".`);
      return;
    }
    await menuButton.click();
    const option = geminiModelOptionLocator(page)
      .filter({ hasText: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
      .first();
    await option.click({ timeout: 5000 });
    console.log(`[gemini] (${jobId}) đã chọn model khớp "${label}".`);
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
  // Chờ hết spinner upload.
  const settleDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (Date.now() < settleDeadline) {
    const loading = await geminiAttachmentLoadingLocator(page).count().catch(() => 0);
    if (loading === 0) break;
    await page.waitForTimeout(2000);
  }
  console.log(`[gemini] (${jobId}) đã đính kèm "${fileName}".`);
}

/** Nội dung snackbar Gemini đang hiện (nếu có) — dùng kèm thông báo lỗi. */
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
        await uploadFile(page, filePath, jobId);
      }
    }
  }

  // Nút Gửi bị disable trong lúc file đính kèm (video) còn đang xử lý.
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
  let sent = false;
  for (let attempt = 0; attempt < 2 && !sent; attempt++) {
    if (attempt === 1) {
      console.warn(`[gemini] (${jobId}) bấm Gửi nhưng tin chưa đi — thử nhấn Enter.`);
      await input.focus().catch(() => {});
      await page.keyboard.press("Enter");
    }
    const sentDeadline = Date.now() + 20_000;
    while (Date.now() < sentDeadline) {
      if (await hasMessageBeenSent(page, input, countBefore)) {
        sent = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
  }
  if (!sent) {
    const attachmentNote =
      expectedAttachments > 0
        ? ` Thẻ file trong ô nhập: ${await countComposerAttachments(page)}/${expectedAttachments}.`
        : "";
    throw new GeminiError(
      `Đã bấm Gửi nhưng Gemini không nhận tin nhắn (prompt vẫn còn trong ô nhập).${attachmentNote}${await readSnackbarText(page)}`,
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
      if (!stopVisible && Date.now() - start > RESPONSE_START_TIMEOUT_MS) {
        throw new GeminiError(
          "Đã bấm Gửi nhưng Gemini không bắt đầu trả lời (không có lượt trả lời mới, không có nút Stop).",
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
        return latest;
      }
    }
    await page.waitForTimeout(2000);
  }
}

/** Đọc text + mọi khối code (theo đúng thứ tự xuất hiện) của 1 lượt trả lời. */
async function readResponse(response: Locator): Promise<{ text: string; codeBlocks: string[] }> {
  const text = await geminiResponseContentLocator(response).innerText().catch(() => "");
  const blocks = await geminiCodeBlockLocator(response)
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""))
    .catch(() => [] as string[]);
  const codeBlocks = blocks.map((b) => b.trim()).filter(Boolean);
  return { text, codeBlocks };
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
  const blocks =
    codeBlocks.length > 0
      ? codeBlocks
      : [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
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
    for (const [index, parsed] of parsedPieces.entries()) {
      if (parsed.ok) {
        values.push(...parsed.values);
        continue;
      }
      // Phần hỏng: cứu các item trọn vẹn. Chỉ tính là "khối hỏng" (bắt Gemini
      // gửi lại) khi KHÔNG có phần hợp lệ nào viết lại phía sau trong cùng
      // khối — đã viết lại đầy đủ thì phần bị cắt không còn ý nghĩa.
      const salvaged = salvageTruncatedJson(parsed.piece);
      if (salvaged !== null) {
        values.push(salvaged);
        salvagedCount++;
      }
      const rewrittenLater = parsedPieces.slice(index + 1).some((p) => p.ok);
      if (!rewrittenLater) invalidCount++;
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

- Trả kết quả JSON TRỰC TIẾP trong khối code \`\`\`json ... \`\`\` ngay trong câu trả lời. KHÔNG tạo file, KHÔNG dùng Canvas, KHÔNG gửi link tải.
- Giữ ĐÚNG schema mà yêu cầu phía trên mô tả (JSON ARRAY hoặc JSON OBJECT) và NHẤT QUÁN kiểu đó qua mọi lượt.
- Nếu yêu cầu phía trên cần NHIỀU FILE JSON (vd nhiều tập), trả 1 JSON OBJECT có key là TÊN FILE (kết thúc bằng ".json"), value là nội dung đầy đủ của file đó.
- KHÔNG cố xuất toàn bộ trong 1 lượt: chia NHIỀU LƯỢT, mỗi lượt ĐÚNG MỘT khối code JSON HỢP LỆ, ĐÃ ĐÓNG NGOẶC ĐẦY ĐỦ, chỉ chứa phần MỚI chưa gửi (array: các item tiếp theo; object: các key mới, hoặc key là mảng thì chỉ các phần tử mới của mảng đó).
- KÍCH THƯỚC MỖI LƯỢT: gửi NHIỀU item mới nhất có thể (gộp trên mọi key/file) nhưng khối JSON KHÔNG vượt quá khoảng ${config.geminiMaxCharsPerTurn} ký tự. Sắp chạm mức đó thì dừng ở item TRỌN VẸN gần nhất, đóng ngoặc, phần còn lại gửi ở lượt sau.
- KHÔNG viết thêm bất kỳ câu chữ nào BÊN TRONG khối code ngoài JSON.
- Ưu tiên tuyệt đối việc đóng JSON hợp lệ: nếu sắp hết chỗ, dừng ở item trước đó và gửi tiếp ở lượt sau.
- Ở CUỐI câu trả lời của LƯỢT CUỐI CÙNG (đã gửi đủ toàn bộ), sau khối code, viết đúng nguyên văn: ${DONE_MARKER}
- TUYỆT ĐỐI KHÔNG viết "${DONE_MARKER}" khi vẫn còn phần chưa gửi.`;
}

function buildContinueMessage(state: MergeState, lastTurnInvalid: boolean): string {
  const invalidWarning = lastTurnInvalid
    ? `Lượt vừa rồi có khối JSON bị cắt giữa chừng — bot CHỈ giữ được các item đã viết trọn vẹn (xem trạng thái bên dưới), phần còn lại bị mất. Gửi tiếp NGAY SAU item cuối bot đã có (không quá ~${config.geminiMaxCharsPerTurn} ký tự), đóng ngoặc đầy đủ, không viết chữ nào khác trong khối code.\n\n`
    : "";
  return `${invalidWarning}Tiếp tục gửi phần tiếp theo (1 khối \`\`\`json\`\`\` hợp lệ, chỉ phần MỚI chưa gửi), đúng quy tắc đã nêu ở lượt đầu.

Trạng thái bot đã gom được (dựa CHÍNH XÁC vào đây để biết tiếp tục từ đâu):
${describeMergeState(state)}

Chỉ viết "${DONE_MARKER}" ở cuối khi đã gửi đủ toàn bộ.`;
}

/** Ghi kết quả đã gộp ra file — object có MỌI key là "*.json" thì tách thành nhiều file. */
async function saveMergedResult(
  state: MergeState,
  baseName: string,
): Promise<string[]> {
  await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
  if (state.kind === "object") {
    const keys = Object.keys(state.obj);
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

/** Số file JSON đã gom (key "*.json" của kết quả object). */
function collectedFileKeys(state: MergeState): string[] {
  return state.kind === "object"
    ? Object.keys(state.obj).filter((k) => /\.json$/i.test(k))
    : [];
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
    if (attachmentPath) await uploadFile(page, attachmentPath, jobId);
    // await captureSnapshot(page, `${jobId}_gemini-before-send`, "gemini-before-send");

    const state: MergeState = { kind: "unset", items: [], obj: {} };
    const expectedFileCount = options.expectedFileCount ?? 0;
    const fileCountNote =
      expectedFileCount > 1
        ? `\n- Kết quả lần này gồm ĐÚNG ${expectedFileCount} FILE JSON (mỗi tập tham chiếu 1 file) — trả JSON OBJECT với ${expectedFileCount} key TÊN FILE; làm lần lượt từng tập, CHỈ viết "${DONE_MARKER}" sau khi đã gửi đủ cả ${expectedFileCount} file.`
        : "";
    let messageToSend = `${prompt}\n\n${buildFirstTurnInstruction()}${fileCountNote}`;
    let done = false;
    for (let turn = 1; turn <= config.geminiMaxTurns; turn++) {
      console.log(
        `[gemini] askGemini(${jobId}): lượt ${turn}/${config.geminiMaxTurns} — gửi, đang chờ Gemini trả lời...`,
      );
      const response = await sendAndWait(page, messageToSend, jobId, {
        attachmentPaths: turn === 1 && attachmentPath ? [attachmentPath] : undefined,
      });
      if (turn === 1) {
        console.log(`[gemini] askGemini(${jobId}): url hội thoại: ${page.url()}`);
      }
      await captureSnapshot(page, `${jobId}_gemini-turn-${turn}`, `gemini-turn-${turn}`);

      const { text, codeBlocks } = await readResponse(response);
      const { values, invalidCount, salvagedCount } = parseJsonFromResponse(codeBlocks, text);
      for (const value of values) mergeGeminiPart(state, value, jobId, turn);
      // Theo yêu cầu người dùng: chấp nhận cả "Đã hoàn thành" (và mọi kiểu
      // viết hoa/thường khác) — Gemini hay không viết đúng nguyên văn in hoa.
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
          ? buildContinueMessage(state, invalidCount > 0)
          : buildShortContinueMessage(state);
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
    const files = await saveMergedResult(state, baseName);
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
