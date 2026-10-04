import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { captureErrorSnapshot, captureSnapshot } from "./aiVideo";
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
/** Tin nhắn gửi tiếp khi lượt trả lời chưa có DONE_MARKER. */
const CONTINUE_MESSAGE = "Tiếp tục xử lý";

/** Chờ tối đa cho 1 lượt trả lời (Gemini xem video dài có thể rất lâu). */
const RESPONSE_TIMEOUT_MS = 60 * 60_000;
/** Không thấy lượt trả lời mới nào xuất hiện sau ngần này thì coi là gửi hỏng. */
const RESPONSE_START_TIMEOUT_MS = 5 * 60_000;
/** Nút Stop phải vắng mặt + text đứng yên liên tục ngần này mới coi là xong. */
const RESPONSE_STABLE_MS = 8_000;
/** Chờ tối đa file đính kèm upload/xử lý xong (video lớn). */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

async function openGeminiPage(jobId: string): Promise<Page> {
  const context = await getGeminiBrowserContext();
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
async function uploadFile(page: Page, filePath: string, jobId: string): Promise<void> {
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

  // Chờ thẻ file mới xuất hiện (best-effort — selector thẻ chưa xác nhận DOM thật).
  const appearDeadline = Date.now() + 60_000;
  while (Date.now() < appearDeadline) {
    const count = await geminiAttachmentPreviewLocator(page).count().catch(() => 0);
    if (count > previewsBefore) break;
    await page.waitForTimeout(1000);
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

async function isSendButtonEnabled(button: Locator): Promise<boolean> {
  const ariaDisabled = await button.getAttribute("aria-disabled").catch(() => null);
  if (ariaDisabled === "true") return false;
  return button.isEnabled().catch(() => false);
}

/** Gõ prompt, bấm Gửi, chờ Gemini trả lời XONG. Trả về locator lượt trả lời mới. */
async function sendAndWait(page: Page, text: string, jobId: string): Promise<Locator> {
  const responses = geminiResponseLocator(page);
  const countBefore = await responses.count();

  const input = await firstVisible(geminiPromptInputCandidates(page), 30_000);
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);

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

  const start = Date.now();
  let lastText = "";
  let stableSince: number | null = null;
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
      if (!stopVisible && Date.now() - start > RESPONSE_START_TIMEOUT_MS) {
        throw new GeminiError(
          "Đã bấm Gửi nhưng Gemini không bắt đầu trả lời (không có lượt trả lời mới, không có nút Stop).",
        );
      }
      await page.waitForTimeout(2000);
      continue;
    }
    const latest = responses.last();
    const text = await geminiResponseContentLocator(latest)
      .innerText()
      .catch(() => "");
    if (stopVisible || text !== lastText || text.trim() === "") {
      stableSince = null;
      lastText = text;
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= RESPONSE_STABLE_MS) {
        console.log(
          `[gemini] (${jobId}) Gemini đã trả lời xong (${text.length} ký tự, ${Math.round((Date.now() - start) / 1000)}s).`,
        );
        return latest;
      }
    }
    await page.waitForTimeout(2000);
  }
}

/** Đọc text + mọi khối code (dài nhất trước) của 1 lượt trả lời. */
async function readResponse(response: Locator): Promise<{ text: string; codeBlocks: string[] }> {
  const text = await geminiResponseContentLocator(response).innerText().catch(() => "");
  const blocks = await geminiCodeBlockLocator(response)
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""))
    .catch(() => [] as string[]);
  const codeBlocks = blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return { text, codeBlocks };
}

/** Tìm JSON hợp lệ: khối code (dài nhất trước) → ```fence``` trong text. null nếu không có. */
function parseJsonFromResponse(
  codeBlocks: string[],
  text: string,
): { value: unknown; hadCandidate: boolean } {
  const candidates = [...codeBlocks];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(m[1].trim());
  }
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate), hadCandidate: true };
    } catch {
      // thử khối tiếp theo
    }
  }
  return { value: null, hadCandidate: candidates.length > 0 };
}

function buildFirstTurnInstruction(): string {
  return `## QUY TẮC TRẢ KẾT QUẢ — BẮT BUỘC (đọc kỹ)

- Trả kết quả JSON TRỰC TIẾP trong khối code \`\`\`json ... \`\`\` ngay trong câu trả lời. KHÔNG tạo file, KHÔNG dùng Canvas, KHÔNG gửi link tải.
- Giữ ĐÚNG schema mà yêu cầu phía trên mô tả (JSON ARRAY hoặc JSON OBJECT) và NHẤT QUÁN kiểu đó qua mọi lượt.
- Nếu yêu cầu phía trên cần NHIỀU FILE JSON (vd nhiều tập), trả 1 JSON OBJECT có key là TÊN FILE (kết thúc bằng ".json"), value là nội dung đầy đủ của file đó.
- KHÔNG cố xuất toàn bộ trong 1 lượt nếu dài: chia NHIỀU LƯỢT, mỗi lượt ĐÚNG MỘT khối code JSON HỢP LỆ, ĐÃ ĐÓNG NGOẶC ĐẦY ĐỦ, chỉ chứa phần MỚI chưa gửi (array: các item tiếp theo; object: các key mới, hoặc key là mảng thì chỉ các phần tử mới của mảng đó).
- Ưu tiên tuyệt đối việc đóng JSON hợp lệ: nếu sắp hết chỗ, dừng ở item trước đó và gửi tiếp ở lượt sau.
- Ở CUỐI câu trả lời của LƯỢT CUỐI CÙNG (đã gửi đủ toàn bộ), sau khối code, viết đúng nguyên văn: ${DONE_MARKER}
- TUYỆT ĐỐI KHÔNG viết "${DONE_MARKER}" khi vẫn còn phần chưa gửi.`;
}

function buildContinueMessage(state: MergeState, lastTurnInvalid: boolean): string {
  const invalidWarning = lastTurnInvalid
    ? "Lượt vừa rồi KHÔNG có khối JSON hợp lệ (thiếu khối code hoặc bị cắt giữa chừng). Gửi lại phần đó, chia NHỎ hơn để khối JSON luôn đóng ngoặc đầy đủ.\n\n"
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
export async function askGemini(
  prompt: string,
  jobId: string,
  promptFileName?: string,
  attachmentPath?: string,
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
    let messageToSend = `${prompt}\n\n${buildFirstTurnInstruction()}`;
    let done = false;
    for (let turn = 1; turn <= config.geminiMaxTurns; turn++) {
      console.log(
        `[gemini] askGemini(${jobId}): lượt ${turn}/${config.geminiMaxTurns} — gửi, đang chờ Gemini trả lời...`,
      );
      const response = await sendAndWait(page, messageToSend, jobId);
      if (turn === 1) {
        console.log(`[gemini] askGemini(${jobId}): url hội thoại: ${page.url()}`);
      }
      // await captureSnapshot(page, `${jobId}_gemini-turn-${turn}`, `gemini-turn-${turn}`);

      const { text, codeBlocks } = await readResponse(response);
      const { value, hadCandidate } = parseJsonFromResponse(codeBlocks, text);
      if (value !== null) mergeJsonPartAuto(state, value, jobId, turn);
      const sawDone = text.includes(DONE_MARKER);

      if (sawDone && value !== null) {
        done = true;
        break;
      }
      if (sawDone && hasData(state) && !hadCandidate) {
        // Lượt cuối chỉ xác nhận bằng lời, dữ liệu đã đủ từ các lượt trước.
        done = true;
        break;
      }
      // Theo yêu cầu người dùng: chưa có marker "ĐÃ HOÀN THÀNH" thì chỉ gửi
      // đúng "Tiếp tục xử lý". Có marker mà chưa chốt được (JSON lượt cuối
      // không hợp lệ) thì vẫn nhắc chi tiết để Gemini gửi lại phần hỏng.
      messageToSend = sawDone
        ? buildContinueMessage(state, value === null)
        : CONTINUE_MESSAGE;
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
