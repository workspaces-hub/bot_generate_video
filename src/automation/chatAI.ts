import fs from "node:fs";
import path from "node:path";
import type { Locator, Page, Request, Response } from "playwright";
import { config } from "../config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
  getChatAIReviseBrowserContext,
} from "./chatAIBrowser";
import {
  assistantMessageLocator,
  chatModeToggleLocator,
  downloadButtonCandidates,
  downloadFileLinkLocator,
  effortLabelLocator,
  effortSliderAnnouncementLocator,
  effortSliderControlLocator,
  effortSliderThumbLocator,
  fileAttachmentLocator,
  fileCardLocator,
  fileUploadInputLocator,
  inlineFileLinkLocator,
  modelPickerOptionLocator,
  modelPickerSelectModelToggleLocator,
  modelSelectorButtonCandidates,
  promptTextareaCandidates,
  regenerateErrorButtonCandidates,
  sendButtonCandidates,
  signInIndicatorCandidates,
  stopGeneratingButtonCandidates,
  workingIndicatorLocator,
  workModeFileReferenceLocator,
  workModeResourceCardDownloadButtonLocator,
  workModeResourceCardRowLocator,
  workModeToggleLocator,
} from "./chatAISelectors";
import { firstVisible, isPageCrashError } from "./selectors";
// captureSnapshot/captureErrorSnapshot đã tổng quát (chỉ cần Page + jobId),
// dùng lại nguyên bản thay vì viết trùng cho ChatAI.
import { captureErrorSnapshot, captureSnapshot } from "./aiVideo";

export class ChatAIError extends Error {
  /**
   * true khi lỗi này là do ChatGPT báo "lỗi công cụ đọc file" (fileAccessError,
   * xem isFileAccessErrorText) LẶP LẠI tới hết lượt trong askChatAI — theo
   * yêu cầu người dùng: processChatAIQueue đọc field này để quyết định có
   * fallback sang askChatAIWithInlineContent (dán nội dung trực tiếp, né hẳn
   * công cụ đọc file) hay không, thay vì phải so khớp text lỗi.
   */
  fileAccessError?: boolean;

  constructor(message: string, options?: { fileAccessError?: boolean }) {
    super(message);
    this.fileAccessError = options?.fileAccessError;
  }
}

/**
 * page.goto tới ChatGPT kèm retry — xác nhận qua lỗi thật (nhiều job khác
 * nhau): proxy VPS thoáng qua bị lỗi tunnel (net::ERR_TUNNEL_CONNECTION_
 * FAILED) khiến 1 lần goto thất bại hẳn (không phải chỉ chậm) dù chỉ vài
 * giây sau thử lại là proxy đã ổn định trở lại. Retry tối đa `attempts`
 * lần (mặc định 3), có delay giữa các lần thử — dùng chung cho MỌI lần
 * page.goto tới config.chatAIBaseUrl (askChatAI, reviseGenerationPrompt,
 * chatAIImage.ts) thay vì mỗi chỗ tự viết 1 kiểu retry riêng.
 */
export async function gotoChatAIWithRetry(
  page: Page,
  url: string,
  options: Parameters<Page["goto"]>[1],
  attempts = 3,
  delayMs = 5000,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, options);
      return;
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      console.warn(
        `[chatAI] page.goto lỗi lần ${attempt}/${attempts}${isLastAttempt ? "" : ", thử lại"}:`,
        err instanceof Error ? err.message : err,
      );
      if (isLastAttempt) throw err;
      await page.waitForTimeout(delayMs);
    }
  }
}

/**
 * Xoá sạch nội dung ô nhập rồi gõ lại "text" qua page.keyboard.insertText()
 * — KHÔNG dùng textarea.fill(). Xác nhận qua debug thật (job 463abed5):
 * fill() set thẳng textContent của <div contenteditable> (ProseMirror) rồi
 * chỉ bắn 1 sự kiện "input" — ProseMirror (editor thật ChatAI dùng) không
 * đồng bộ lại state nội bộ từ cách này, nên dù DOM hiển thị ĐÚNG text, ứng
 * dụng vẫn coi ô nhập là RỖNG → nút Send không bao giờ hiện ra (timeout "waiting
 * for send-button to be visible" ngay sau khi fill()). insertText() giả lập
 * đúng luồng sự kiện input thật (như gõ tay/paste), ProseMirror nhận diện
 * được bình thường.
 *
 * Xác nhận qua debug thật (job ec8f3f90, sau khi thêm tính năng đính kèm
 * file — xem uploadAttachment): khi composer VỪA có file đính kèm, nội dung
 * bị gõ TRÙNG LẶP (vd "Hãy thực hiện yêu cầu trong fileHãy thực hiện yêu cầu
 * trong file") — nghi vấn: sau khi Ctrl+V dán xong, việc chuyển sang nhánh
 * fallback này (khi so khớp KHÔNG khớp) có thể chạy trong lúc composer chưa
 * ổn định focus đúng vào ô nhập (attachment vừa xong có thể làm focus lệch),
 * khiến Ctrl+A/Delete không xoá được nội dung ĐÃ dán trước đó, rồi insertText
 * chỉ NỐI THÊM text mới vào cuối thay vì thay thế. Focus lại thẳng vào
 * textarea NGAY TRƯỚC khi Ctrl+A để đảm bảo focus đúng chỗ trước khi xoá/gõ,
 * bất kể trạng thái focus trước đó.
 *
 * Dùng .focus() thay vì .click() — xác nhận qua lỗi thật (nhiều job, vd
 * a6158b2d/cc922ffe/d8efadb1/cc5e8802): sau khi ChatGPT đổi sang <textarea>
 * thật (xem promptTextareaCandidates), .click() liên tục báo "<div
 * class=\"...composer-container...\"> intercepts pointer events" suốt 30s dù
 * chính textarea vẫn "visible, enabled and stable" — 1 lớp wrapper của
 * composer nằm ĐÈ lên đúng toạ độ click dù không che mắt thường. .focus() gọi
 * thẳng element.focus() qua JS, KHÔNG cần hit-test toạ độ chuột nên né được
 * lớp che này hoàn toàn, vẫn đủ để Ctrl+A/Delete/insertText hoạt động đúng.
 */
async function insertPromptText(
  page: Page,
  textarea: Locator,
  text: string,
): Promise<void> {
  await textarea.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

/**
 * Chờ nút Send hết trạng thái "aria-disabled=true" — xác nhận qua lỗi thật
 * (job b72824b5-7545-4750-9dd4-1532aa4fba99): sendButton.click() timeout
 * 10s với log Playwright "element is not enabled" liên tục — nút Send tồn
 * tại/visible thật (locator resolve đúng) nhưng ChatGPT tự disable nút này
 * khi ô nhập được coi là RỖNG, dù các bước dán/gõ prompt phía trên không hề
 * báo lỗi gì. Bấm mù vào nút đang disabled chỉ lặp lại đúng lỗi này tới hết
 * timeout mà không có thêm manh mối — chờ RÕ RÀNG nút chuyển enabled trước,
 * để sendMessage có cơ hội tự phát hiện và thử gõ lại (xem lời gọi hàm này).
 */
async function waitForSendButtonEnabled(
  page: Page,
  sendButton: Locator,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await sendButton
      .getAttribute("aria-disabled")
      .catch(() => null);
    if (disabled !== "true") return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Xác nhận qua debug thật (job b72824b5-7545-4750-9dd4-1532aa4fba99, ảnh
 * chụp lúc lỗi "nút Send disabled"): khi PASTE 1 đoạn text RẤT DÀI (như
 * master prompt), ChatGPT tự động chuyển đoạn đó thành 1 THẺ đính kèm riêng
 * (giống thẻ file, tiêu đề rút gọn theo dòng đầu, vd "# PROMPT MASTER — 1
 * .."), thẻ này hiện spinner xoay (`<svg><use href="...#spinner">`, DOM thật
 * xác nhận: div bọc spinner có "display: none !important" khi ĐÃ xong, chỉ
 * hiện khi đang xử lý) trong lúc ChatGPT còn xử lý/tổng hợp nội dung thẻ.
 * Bấm Send lúc thẻ còn spinner có thể khiến ChatGPT chưa nhận đúng nội dung
 * hoặc nút Send chưa kịp bật — chờ MỌI spinner dạng này biến mất (không giới
 * hạn theo tên thẻ cụ thể, để dùng chung được cho cả thẻ text tự sinh lẫn
 * thẻ file khác nếu sau này có cùng cơ chế) trước khi tiếp tục. Dùng
 * offsetParent !== null (không phải chỉ querySelector tồn tại trong DOM) để
 * kiểm tra spinner có THỰC SỰ đang hiển thị hay không — element spinner vẫn
 * NẰM SẴN trong DOM ngay cả khi đã xong, chỉ khác ở chỗ bị ẩn bằng CSS.
 * Best-effort: timeout 30s rồi tự bỏ qua (không throw), không chặn cả job
 * chỉ vì lỡ có spinner lạ nào đó không bao giờ biến mất.
 */
async function waitForComposerTilesToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const spinners = document.querySelectorAll('svg use[href$="#spinner"]');
        for (const spinner of spinners) {
          const svgEl = spinner.closest("svg");
          if (svgEl && (svgEl as unknown as HTMLElement).offsetParent !== null) {
            return false;
          }
        }
        return true;
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
}

/** Chặn lặp vô hạn nếu vì lý do gì đó ChatAI không bao giờ đính kèm file. */
const MAX_TURNS_WAITING_FOR_FILE = 30;

/**
 * Chờ file tile trong composer hết trạng thái "đang upload" — xác nhận qua
 * debug HTML thật (before-click ask.html, job so sánh output_local.json/
 * output_vps.json): file tile lúc CHƯA upload xong là
 * `[role="group"][aria-label="<tên file>"]` chứa 1 progress ring SVG
 * (`circle[stroke-dashoffset]`, dashoffset > 0 = chưa đầy vòng) và nút bên
 * trong mang class "cursor-wait"; icon "đã xong" (checkmark) cùng lúc đó bị
 * ẩn (`display: none !important`). Confirm site có bấm Send NGAY LÚC NÀY vẫn
 * cho qua (không disable nút Send) — đây chính là nguyên nhân storyboard bị
 * ChatAI đọc thiếu/dở dang trên môi trường chậm (VPS/Xvfb): code trước đây
 * chỉ chờ cố định vài giây, không xác minh DOM thật. Chờ VÔ THỜI HẠN (không
 * timeout cố định) tới khi progress ring này biến mất mới coi là upload xong.
 * Tile biến mất hẳn khỏi composer (vd trường hợp hiếm gặp) cũng coi là xong,
 * không chặn vô ích.
 */
async function waitForAttachmentUploadToSettle(
  page: Page,
  fileName: string,
): Promise<void> {
  await page.waitForFunction(
    (name) => {
      const tile = Array.from(document.querySelectorAll('[role="group"]')).find(
        (g) => g.getAttribute("aria-label") === name,
      );
      if (!tile) return true;
      return tile.querySelector("circle[stroke-dashoffset]") === null;
    },
    fileName,
    { timeout: 0 },
  );
}

/**
 * Toast lỗi mạng khi ChatGPT upload file đính kèm thất bại — xác nhận qua
 * debug thật (storage/debug/"after-upload attachment".png/html): banner đỏ
 * (role="alert", bg-red-500) nguyên văn "Failed upload to
 * files.oaiusercontent.com. Please ensure your network settings allow access
 * to this site or contact your network administrator." — nghi do PROXY_SERVER
 * (đã biết chập chờn, xem gotoChatAIWithRetry) không cho qua domain CDN riêng
 * "files.oaiusercontent.com" (khác domain chính chatgpt.com đang dùng để
 * chat). QUAN TRỌNG: progress ring của waitForAttachmentUploadToSettle VẪN
 * biến mất khi upload lỗi kiểu này (thử xong dù thất bại, không phải "đang
 * thử mãi") — nếu không kiểm tra riêng banner này, code sẽ tưởng đã đính kèm
 * xong rồi gõ prompt/bấm Send như bình thường, khiến ChatAI trả lời mà KHÔNG
 * hề có file (lặp lại đúng kiểu lỗi "chưa chứa kịch bản" đã gặp trước đây,
 * dù nguyên nhân khác).
 */
const attachmentUploadFailedLocator = (page: Page): Locator =>
  page.getByText(/failed upload to files\.oaiusercontent\.com/i);

/**
 * Đính kèm 1 file lên composer TRƯỚC khi gõ prompt — dùng khi user gửi prompt
 * qua file (.txt/.md) thay vì gõ/dán trực tiếp: UPLOAD file đó lên ChatAI rồi chỉ
 * gõ 1 câu ngắn yêu cầu ChatAI đọc file, thay vì dán nguyên nội dung file làm
 * prompt text (tránh dán prompt siêu dài, và để ChatAI tự đọc file y hệt cách
 * user thật đính kèm). Cùng cơ chế setInputFiles() đã dùng cho ảnh tham chiếu
 * (uploadReferenceImages trong chatAIImage.ts).
 *
 * Retry khi gặp banner lỗi mạng (xem attachmentUploadFailedLocator) — thử
 * lại setInputFiles từ đầu, tối đa vài lần trước khi báo lỗi rõ ràng thay vì
 * âm thầm tiếp tục gửi prompt không kèm file.
 *
 * GHI LOG network THẬT của request/response tới oaiusercontent.com mỗi lần
 * thử — xác nhận qua curl thật trên VPS: kết nối thô (DNS/TLS/HTTP2) tới
 * domain này hoàn toàn bình thường cả đi thẳng lẫn qua proxy, nên lỗi banner
 * "Failed upload..." KHÔNG PHẢI do mạng/proxy như nghi ngờ ban đầu — phải là
 * request THẬT SỰ của trình duyệt (khác hẳn 1 GET đơn giản của curl, có thể
 * là PUT tới URL có chữ ký SAS hết hạn, hoặc bị Cloudflare chặn theo dấu hiệu
 * automation) mới thất bại. Bắt status code/lỗi thật của request đó (thay vì
 * chỉ đọc lại đúng banner chung chung "Failed upload...") để lần lỗi tiếp
 * theo có bằng chứng cụ thể, tránh phải đoán tiếp.
 */
async function uploadAttachment(page: Page, filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const networkLogs: string[] = [];
    const onResponse = (response: Response) => {
      if (response.url().includes("oaiusercontent.com")) {
        networkLogs.push(
          `response ${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    };
    const onRequestFailed = (request: Request) => {
      if (request.url().includes("oaiusercontent.com")) {
        networkLogs.push(
          `requestfailed ${request.failure()?.errorText ?? "(không rõ lỗi)"} ${request.method()} ${request.url()}`,
        );
      }
    };
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);
    try {
      await fileUploadInputLocator(page).setInputFiles(filePath);
      await waitForAttachmentUploadToSettle(page, fileName);
    } finally {
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    }

    const uploadFailed = await attachmentUploadFailedLocator(page)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (!uploadFailed) break;

    const networkDetail =
      networkLogs.length > 0
        ? networkLogs.join(" | ")
        : "(không bắt được request/response nào tới oaiusercontent.com)";

    if (attempt === maxAttempts) {
      throw new ChatAIError(
        `Đính kèm file "${fileName}" lên ChatGPT thất bại sau ${maxAttempts} lần thử: "Failed upload to files.oaiusercontent.com". Chi tiết network: ${networkDetail}`,
      );
    }
    console.warn(
      `[chatAI] Upload file đính kèm "${fileName}" lỗi mạng (lần ${attempt}/${maxAttempts}), thử lại. Chi tiết network: ${networkDetail}`,
    );
    await page.waitForTimeout(3000);
  }
  // await captureSnapshot(
  //   page,
  //   "after-upload attachment",
  //   "after-upload attachment",
  // );

  // Xác nhận qua thực tế (job 35941268, file 97KB/~2371 dòng): ChatAI trả
  // lời "file bạn gửi chưa chứa kịch bản phim" dù file THẬT SỰ có kịch bản ở
  // cuối — waitForAttachmentUploadToSettle chỉ xác nhận file đã UPLOAD/TRUYỀN
  // xong (spinner phía client hết), không đảm bảo ChatAI đã xử lý/index xong
  // NỘI DUNG file phía server (đọc để trả lời) — với file lớn, việc đó có
  // thể mất lâu hơn hẳn việc chỉ truyền xong bytes. Chờ thêm buffer ổn định
  // TỈ LỆ THEO KÍCH THƯỚC file (không có tín hiệu DOM nào báo "đã index xong"
  // để bám vào) trước khi gõ prompt/bấm Send.
  const fileSizeBytes = await fs.promises
    .stat(filePath)
    .then((s) => s.size)
    .catch(() => 0);
  const extraSettleMs = Math.min(
    60_000,
    Math.max(1000, Math.round(fileSizeBytes / 1024) * 100),
  );
  await page.waitForTimeout(extraSettleMs);
}

/**
 * Gõ text vào ô nhập rồi bấm gửi — prompt có thể RẤT dài, ưu tiên dùng
 * clipboard copy/paste (navigator.clipboard.writeText + Ctrl/Cmd+V) thay vì
 * .fill()/gõ từng phím, đáng tin cậy hơn với nội dung dài (đúng cách user
 * thật sẽ làm: copy nội dung rồi dán vào ô chat).
 *
 * Xác nhận qua debug thật (job ae8f1dbf): 1 số phiên/tài khoản ChatAI có
 * Permissions-Policy CHẶN HẲN Clipboard API ở tầng trang ("NotAllowedError:
 * ... blocked because of a permissions policy applied to the current
 * document") — khác với việc thiếu quyền (permission prompt), nên
 * grantPermissions() không có tác dụng gì với trường hợp này. Fallback sang
 * textarea.fill() (set thẳng nội dung, không cần clipboard, không gõ từng
 * phím) khi gặp lỗi này.
 */
async function sendMessage(
  page: Page,
  text: string,
  jobId: string,
): Promise<void> {
  let clipboardOk = true;
  try {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: config.chatAIBaseUrl,
      });
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  } catch (err) {
    clipboardOk = false;
    console.warn(
      "[chatAI] Clipboard API bị chặn (Permissions-Policy), chuyển sang textarea.fill():",
      err instanceof Error ? err.message : err,
    );
  }

  // Xác nhận qua lỗi thật (job a22dba4a-da81-48a4-89c3-8603f849a8a9): panel
  // xem trước "Library" (data-testid="screen-threadFlyOut", xem
  // downloadAttachedFiles) vẫn còn MỞ từ lượt trước — panel này đóng KHÔNG
  // đầy đủ nếu previewText đọc thất bại (downloadAttachedFiles chỉ bấm nút
  // Close ở nhánh previewText THÀNH CÔNG). Khi panel còn mở, layout composer
  // bị bóp hẹp lại khiến CẢ 4 candidate của promptTextareaCandidates (kể cả
  // #prompt-textarea và textarea[name="prompt-textarea"]) đều resolve nhưng
  // ở trạng thái ẨN (hidden) suốt 20s, throw "Không tìm thấy phần tử nào
  // khớp". Đóng panel này TRƯỚC KHI tìm ô nhập, không tin lượt trước đã đóng
  // đúng — an toàn, không tốn gì nếu panel không mở (click bị catch, bỏ qua).
  const flyOutCloseButton = page.locator(
    '[data-testid="screen-threadFlyOut"] [data-testid="close-button"]',
  );
  if (await flyOutCloseButton.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await flyOutCloseButton.first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const textarea = await firstVisible(promptTextareaCandidates(page), 20_000);
  // .focus() thay vì .click() — xem docstring insertPromptText bên trên (né
  // lỗi wrapper composer "intercepts pointer events" trên <textarea> thật).
  await textarea.focus();
  if (clipboardOk) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+V");

    // Xác nhận qua thực tế: chạy headed qua Xvfb trên VPS (không có clipboard
    // manager X11 thật đứng sau) đôi khi navigator.clipboard.writeText() báo
    // thành công ở tầng JS (KHÔNG throw, clipboardOk vẫn true) nhưng Ctrl+V
    // (paste tầng OS/X11, khác hẳn Web Clipboard API) lại dán nội dung
    // CŨ/không liên quan (vd dán nhầm chữ "playwright" thay vì prompt thật) —
    // sai khác này không tự lộ ra bằng exception nên phải tự đọc lại nội
    // dung sau khi dán rồi so sánh; không khớp thì coi là dán lỗi, ép ghi đè
    // lại bằng fill() (không qua clipboard OS, đường tin cậy tuyệt đối).
    //
    // So sánh sau khi CHUẨN HOÁ khoảng trắng (gộp mọi dãy whitespace/xuống
    // dòng liên tiếp thành 1 dấu cách) — xác nhận qua thực tế (job
    // 5643dab5): so khớp tuyệt đối (chỉ .trim()) với prompt NHIỀU DÒNG/rất
    // dài (JSON storyboard) bị "false positive" do ProseMirror render xuống
    // dòng/đoạn khác cách biểu diễn \n gốc — dù dán ĐÚNG vẫn bị coi là dán
    // sai, kích hoạt fill() lại 1 khối text khổng lồ không cần thiết, gây
    // treo/timeout dây chuyền (fill "not editable" 30s, rồi cả screenshot
    // debug cũng timeout theo vì tab bị đơ).
    const normalizeForCompare = (s: string) => s.replace(/\s+/g, " ").trim();
    const pasted = await textarea.innerText().catch(() => "");
    if (normalizeForCompare(pasted) !== normalizeForCompare(text)) {
      // console.warn(
      //   "[chatAI] Nội dung dán vào ô nhập không khớp prompt (nghi clipboard OS/X11 dán nhầm nội dung cũ) — gõ lại bằng insertText().",
      // );
      await insertPromptText(page, textarea, text);
    }
  } else {
    await insertPromptText(page, textarea, text);
  }
  // Chờ hết spinner ở (các) thẻ đính kèm trong composer — bao gồm thẻ text
  // ChatGPT tự sinh ra khi paste đoạn dài (xem docstring
  // waitForComposerTilesToSettle) — TRƯỚC KHI tìm/kiểm tra nút Send, vì lúc
  // còn spinner nút Send có thể chưa sẵn sàng.
  await waitForComposerTilesToSettle(page);
  // await captureSnapshot(page, "before-click ask", "before-click ask");
  const sendButton = await firstVisible(sendButtonCandidates(page), 10_000);
  // Xác nhận qua lỗi thật (job b72824b5-7545-4750-9dd4-1532aa4fba99): nút
  // Send có thể vẫn "aria-disabled=true" ngay sau khi các bước dán/gõ ở trên
  // đã chạy xong KHÔNG báo lỗi gì — bấm mù vào nút đang disabled chỉ lặp lại
  // "element is not enabled" tới hết 10s rồi throw. Chờ RÕ RÀNG nút chuyển
  // enabled trước; nếu sau 25s vẫn disabled (nghi ô nhập chưa thực sự nhận
  // được text dù bước dán/gõ không báo lỗi), thử gõ lại 1 lần bằng
  // insertPromptText (đường tin cậy nhất, không qua clipboard OS) rồi chờ
  // tiếp — chỉ throw lỗi rõ ràng nếu vẫn disabled sau khi đã thử lại.
  let sendButtonEnabled = await waitForSendButtonEnabled(page, sendButton, 25000);
  if (!sendButtonEnabled) {
    console.warn(
      "[chatAI] Nút Send vẫn disabled sau khi dán/gõ prompt — thử gõ lại bằng insertPromptText trước khi bấm Send.",
    );
    await insertPromptText(page, textarea, text);
    sendButtonEnabled = await waitForSendButtonEnabled(page, sendButton, 10000);
  }
  if (!sendButtonEnabled) {
    throw new ChatAIError(
      "Nút Send vẫn ở trạng thái disabled dù đã thử dán/gõ lại prompt — có thể ChatGPT đã đổi cấu trúc composer.",
    );
  }
  // ChatGPT điều hướng THẬT (từ "/" sang "/c/<id>") khi gửi tin nhắn ĐẦU
  // TIÊN của 1 hội thoại mới — xác nhận qua lỗi thật ("click action done —
  // waiting for scheduled navigations to finish" rồi timeout 30s): click ĐÃ
  // THỰC SỰ xảy ra (log xác nhận "click action done"), chỉ là navigation đó
  // không "settle" kịp trong thời gian actionability mặc định của
  // Playwright. Cùng lớp lỗi đã gặp với pollo.ai (xem clickGenerateButton
  // trong pollo.ts) — kiểm tra bằng chứng tin nhắn ĐÃ GỬI (ô nhập rỗng trở
  // lại, hoặc nút Stop generating xuất hiện) trước khi coi là lỗi thật,
  // thay vì luôn throw ngay khi click() timeout.
  await sendButton.click({ timeout: 10_000 }).catch(async (err) => {
    const textCleared = await textarea
      .innerText()
      .then((t) => t.trim() === "")
      .catch(() => false);
    const stopVisible = await firstVisible(
      stopGeneratingButtonCandidates(page),
      3000,
    )
      .then(() => true)
      .catch(() => false);
    if (!textCleared && !stopVisible) throw err;
    console.warn(
      "[chatAI] Click Send báo lỗi (navigation timeout) nhưng có bằng chứng tin nhắn đã gửi (ô nhập rỗng/nút Stop xuất hiện) — bỏ qua lỗi.",
    );
  });
  // await captureSnapshot(page, "after-click ask", "after-click ask");

  // Chờ nút "Stop generating" xuất hiện (ChatAI bắt đầu trả lời) — best-effort,
  // không throw nếu không thấy (có thể trả lời quá nhanh, đã xong trước khi
  // kịp bắt được trạng thái này).
  //
  // Xác nhận qua debug thật (job 1beafb45): nút Stop có thể xuất hiện MUỘN
  // hơn 10s chờ ban đầu (trang vẫn đang ở "ChatAI/" — CHƯA kịp điều
  // hướng sang URL hội thoại "/c/...", conversation-turn = 0, giữa màn hình
  // còn spinner "đang tải") — nếu vòng lặp bên dưới coi "chưa thấy nút Stop"
  // dù chỉ 1 lần là ĐÃ XONG, sẽ trả về NGAY LẬP TỨC trước khi ChatAI kịp bắt đầu
  // trả lời, khiến readLatestAssistantMessage tìm thấy 0 tin nhắn (throw
  // "Không tìm thấy câu trả lời nào"). hasSeenGenerating chỉ cho phép coi là
  // "đã xong" SAU KHI từng thấy nút Stop xuất hiện thật ít nhất 1 lần (bằng
  // chứng ChatAI đã bắt đầu trả lời) — trừ khi trang đã thật sự có tin nhắn trả
  // lời (hiếm khi ChatAI trả lời quá nhanh, không kịp thấy nút Stop).
  let hasSeenGenerating = await firstVisible(
    stopGeneratingButtonCandidates(page),
    10_000,
  )
    .then(() => true)
    .catch(() => false);

  // Rồi chờ tới khi nút đó biến mất — ChatAI đã trả lời xong.
  //
  // Xác nhận qua debug thật (job ebca2517): nút Stop có thể biến mất RỒI
  // XUẤT HIỆN LẠI trong lúc ChatAI vẫn đang suy luận/trả lời (nhấp nháy giữa các
  // đoạn) — nếu chỉ check 1 lần "không thấy nút Stop" là coi như xong ngay,
  // code sẽ gửi lượt tiếp theo ("yes") trong khi ChatAI thực tế còn đang generate,
  // khiến ô nhập bị khoá và không tìm thấy nút Send (lỗi
  // "waiting for ... send-button to be visible"). Nên phải yêu cầu nút Stop
  // vắng mặt LIÊN TỤC trong 1 khoảng ổn định (giống pattern settle dùng cho
  // upload ảnh ở aiVideo.ts) mới coi là ChatAI đã trả lời xong thật.
  //
  // Xác nhận qua debug thật (job 5010d1a3): với phản hồi có dùng tool tạo
  // file (Code Interpreter — vd tạo meta.json), nút Stop KHÔNG BAO GIỜ biến
  // mất dù trả lời đã xong thật (text đầy đủ + file đính kèm đã hiện, "Worked
  // for 20s") — chờ dựa hoàn toàn vào nút Stop khiến vòng lặp treo tới hết
  // timeout dù ChatAI xong từ lâu. Vì vậy: nếu tin nhắn trả lời MỚI NHẤT đã có
  // file đính kèm hiện ra (fileAttachmentLocator), coi đó là dấu hiệu xong
  // THAY THẾ cho việc chờ nút Stop biến mất.
  const stableRequiredMs = 30000;
  // 10s thay vì 5s — giảm tần suất đánh thức renderer (query DOM mỗi lần)
  // trong lúc queue ảnh/video khác đang tranh CPU. Vòng lặp này KHÔNG giới
  // hạn thời gian tổng (chờ tới khi ChatAI thật sự trả lời xong), nên với
  // model reasoning nặng có thể poll rất nhiều lần liên tục — cùng lý do đã
  // áp dụng cho pollIntervalMs của Pollo (xem waitForGenerationApiStatus,
  // pollo.ts).
  const pollIntervalMs = 10_000;
  // Xác nhận qua debug thật (job d077805e, chatAIImage.ts): ChatAI đôi khi báo
  // lỗi THẬT ("Something went wrong. Please try again." kèm nút Retry,
  // data-testid="regenerate-thread-error-button") — không phải lỗi selector.
  // Tự bấm Retry (giới hạn số lần) trước khi chịu thua, vì nguyên nhân hay
  // gặp là quá tải server nhất thời, thử lại thường tự qua.
  const maxRetriesOnError = 10;
  let retriesUsed = 0;

  // Xác nhận qua thực tế (job ec8f3f90, "Connection interrupted. Waiting for
  // the complete answer"): mạng chập chờn có thể khiến ChatAI mất RẤT LÂU mới
  // trả lời xong thật — không còn giới hạn generationTimeoutMs ở đây nữa,
  // chờ tới khi nào ChatAI THỰC SỰ trả lời xong mới thôi (theo yêu cầu người
  // dùng). Vẫn có 2 lối thoát khác nếu ChatAI lỗi THẬT: retryButton hết lượt
  // Retry (maxRetriesOnError) ở dưới, hoặc lỗi ném ra từ chính Playwright
  // (vd page bị đóng/crash).
  let stableSince: number | null = null;
  // Theo yêu cầu người dùng: đếm số lần poll LIÊN TỤC mà VẪN chưa từng thấy
  // nút Stop (hasSeenGenerating false) — xác nhận qua log lỗi thật (lặp lại
  // vô hạn "stopButtonVisible=false, workingIndicatorVisible=false,
  // hasSeenGenerating=false" dù user xác nhận ChatGPT đã trả lời xong trên
  // trình duyệt thật). Dùng để chụp 1 debug snapshot DUY NHẤT khi vượt
  // ngưỡng nghi ngờ, thay vì đoán mù nguyên nhân (selector nút Stop/tin nhắn
  // trả lời có thể đã lỗi thời, giống lần trước với nút Send).
  let neverGeneratingPollCount = 0;
  let stuckSnapshotTaken = false;
  while (true) {
    const retryButton = await firstVisible(
      regenerateErrorButtonCandidates(page),
      500,
    ).catch(() => null);
    if (retryButton) {
      if (retriesUsed >= maxRetriesOnError) {
        throw new ChatAIError(
          `ChatAI báo lỗi ("Something went wrong") — đã Retry ${retriesUsed} lần vẫn lỗi.`,
        );
      }
      await retryButton.click().catch(() => {});
      retriesUsed++;
      stableSince = null;
      await page.waitForTimeout(pollIntervalMs);
      continue;
    }

    const stopButtonVisible = await firstVisible(
      stopGeneratingButtonCandidates(page),
      500,
    )
      .then(() => true)
      .catch(() => false);
    // Bổ sung tín hiệu "Working for Xm Ys" (xem docstring workingIndicatorLocator)
    // — xác nhận qua lỗi thật (job 61d57820...test_camera_1.txt): nút Stop
    // dò bằng stopGeneratingButtonCandidates có khoảng hở lúc tool call
    // (đọc file...) đang chạy, khiến code coi là "đã xong" (báo 404 không
    // có file) dù ảnh debug lúc đó cho thấy rõ ràng vẫn "Working for 1m
    // 35s". Coi "đang generate" nếu MỘT TRONG HAI tín hiệu còn hiện.
    const workingIndicatorVisible =
      (await workingIndicatorLocator(page)
        .count()
        .catch(() => 0)) > 0;
    const stillGenerating = stopButtonVisible || workingIndicatorVisible;
    if (stillGenerating) {
      hasSeenGenerating = true;
      // Xác nhận qua log lỗi thật (job 3b19ebae, model "High" reasoning
      // effort): nút Stop vẫn hiện thật ("Planning storyboard" — reasoning
      // model đang suy luận), nhưng đoạn code TRƯỚC ĐÂY thiếu hẳn phần dùng
      // stableRequiredMs (biến khai báo nhưng KHÔNG hề dùng để chặn return)
      // — chỉ cần 1 lần poll thấy Stop vắng mặt là return NGAY, khiến bot
      // báo "đã trả lời xong (không có file)" dù ChatAI còn đang generate thật
      // (Stop chớp tắt giữa các bước suy luận, xem job ebca2517 ở trên).
      // Reset lại mốc ổn định mỗi khi THẤY Stop lại — bắt buộc phải vắng mặt
      // LIÊN TỤC đủ stableRequiredMs mới coi là xong thật.
      stableSince = null;
    }

    // Theo yêu cầu người dùng: log tiến trình chờ (trước đây comment sẵn ở
    // đây nhưng chưa bật) — để biết đang kẹt ở bước nào khi ChatGPT đã xong
    // thật trên trình duyệt nhưng bot chưa thấy phản hồi (vd đang chờ nút
    // Stop biến mất ổn định, hay đang retry lỗi...).
    console.log(
      `[chatAI] sendMessage: đang chờ ChatAI — stopButtonVisible=${stopButtonVisible}, workingIndicatorVisible=${workingIndicatorVisible}, hasSeenGenerating=${hasSeenGenerating}, stableSince=${stableSince === null ? "chưa ổn định" : `${Date.now() - stableSince}ms`}, retriesUsed=${retriesUsed}/${maxRetriesOnError}.`,
    );
    if (!stillGenerating) {
      if (hasSeenGenerating) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableRequiredMs) {
          console.log(
            `[chatAI] sendMessage: ChatAI đã trả lời xong (nút Stop vắng mặt ổn định ${stableRequiredMs}ms).`,
          );
          return;
        }
      } else {
        // Chưa từng thấy nút Stop — chỉ coi là xong nếu trang đã thật sự có
        // tin nhắn trả lời (trường hợp hiếm: ChatAI trả lời quá nhanh). Không có
        // gì cả thì vẫn phải chờ tiếp, không được kết luận "xong" (xem job
        // 1beafb45 ở trên).
        const hasAssistantTurn =
          (await assistantMessageLocator(page).count()) > 0;
        if (hasAssistantTurn) {
          console.log(
            "[chatAI] sendMessage: ChatAI đã có tin nhắn trả lời (chưa từng thấy nút Stop — trả lời quá nhanh), coi như xong.",
          );
          return;
        }
        neverGeneratingPollCount++;
        if (neverGeneratingPollCount >= 6 && !stuckSnapshotTaken) {
          stuckSnapshotTaken = true;
          console.warn(
            `[chatAI] sendMessage: sau ${neverGeneratingPollCount} lần poll (~${(neverGeneratingPollCount * pollIntervalMs) / 1000}s) vẫn CHƯA TỪNG thấy nút Stop VÀ chưa có tin nhắn trả lời nào — nghi selector nút Stop/tin nhắn trả lời đã lỗi thời (ChatGPT đổi DOM, giống lần trước với nút Send) hoặc trang chưa điều hướng đúng sang hội thoại thật. Chụp debug snapshot để kiểm tra.`,
          );
          await captureSnapshot(
            page,
            `${jobId}_stuck-no-generating-signal`,
            "stuck-no-generating-signal",
          );
        }
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }
}

/**
 * Nếu tin nhắn trả lời có đính kèm file (ChatAI tạo ra, vd qua code
 * interpreter/canvas) thì tải về config.chatAIResultsDir. Best-effort: bấm
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
 *
 * Xác nhận qua debug thật (job 4c746641): ChatAI đôi khi dùng HẲN 1 kiểu nút
 * link-text THỨ BA — "📄 Tải file <filename>" (tiếng Việt, có emoji) — không
 * khớp cả downloadFileLinkLocator lẫn fileCardLocator, khiến trước đây
 * attachments.count() = 0 dù file JSON có thật trong tin nhắn, bot bỏ sót
 * hoàn toàn (không log gì vì vòng lặp for còn chưa kịp chạy).
 *
 * Xác nhận qua debug thật (job 67b2f3fc): CÙNG 1 file có thể có CẢ nút
 * link-text trích dẫn (không emoji, chỉ tên file trần) LẪN thẻ card
 * "group/open-file" — nút trích dẫn KHÔNG kích hoạt được download/mở preview
 * gì cả (khác hẳn biến thể CÓ emoji đã xác nhận tải được ở job 4c746641),
 * trong khi thẻ card luôn mở được panel xem trước (fallback đáng tin cậy
 * nhất). Vì vậy thứ tự ưu tiên PHẢI là: downloadFileLinkLocator →
 * fileCardLocator → inlineFileLinkLocator (dùng SAU CÙNG, chỉ khi không có
 * nút Download thật lẫn thẻ card nào) — inlineFileLinkLocator cũng đã tự
 * loại trừ class "group/open-file" nên không còn trùng với fileCardLocator.
 *
 * Xác nhận qua debug thật (job pip_boulangerie, HTML): CÙNG 1 tên file có
 * thể xuất hiện dưới dạng NHIỀU nút trích dẫn (citation) rải rác trong cùng
 * 1 đoạn văn trả lời (thấy tới 9 lần khớp cùng 1 filename trong 1 tin nhắn)
 * — nếu dùng inlineFileLinkLocator, "count" đếm được có thể > số file THẬT
 * SỰ, khiến vòng lặp tải TRÙNG cùng 1 file nhiều lần (ra "<tên>.json",
 * "<tên>-2.json"... dù chỉ có 1 kết quả). Dedupe theo aria-label (đúng bằng
 * tên file) TRƯỚC khi lặp — mỗi tên file chỉ tải ĐÚNG 1 LẦN, dù khớp bao
 * nhiêu nút.
 *
 * SỬA (theo yêu cầu người dùng): khi KHÔNG có promptFileName (không đặt lại
 * tên theo file prompt gốc), lưu file ĐÚNG tên ChatAI gợi ý (suggestedName/
 * suggested) — KHÔNG còn thêm tiền tố "<jobId>-" như trước. File gốc lưu ở
 * config.chatAIResultsDir chỉ tồn tại tạm thời: sau khi được COPY vào
 * storage/generated/ (xem runStoryboardPipelinePollo trong queue.ts), bản
 * gốc này bị xoá luôn — không cần tiền tố jobId để tránh trùng tên vì mỗi
 * file chỉ "sống" tạm trong khoảng ngắn giữa lúc tải về và lúc copy xong.
 */
async function downloadAttachedFiles(
  page: Page,
  message: Locator,
  promptFileName?: string,
): Promise<string[]> {
  const downloadLinks = downloadFileLinkLocator(message);
  const fileCards = fileCardLocator(message);
  const inlineLinks = inlineFileLinkLocator(message);
  // Chế độ "Work" — xem docstring workModeResourceCardDownloadButtonLocator/
  // workModeFileReferenceLocator. Thử SAU CÙNG các biến thể mode "Chat" ở
  // trên, vì mode Work không có bất kỳ <button> nào khớp 3 locator đó (đã
  // xác nhận qua debug thật, xem job 9ff64b1a-886f-4aec-97f4-af6f877a5cea).
  // Ưu tiên resource card (nút "Download file" thật, đáng tin cậy hơn) TRƯỚC
  // span trích dẫn workModeRefs (xác nhận qua debug thật, job
  // ec31faa8-2a40-48ae-904a-26e6a7002b5d: bấm span trích dẫn không mở được
  // gì cả, trong khi resource card có nút Download rõ ràng).
  const workModeResourceCardDownloads =
    workModeResourceCardDownloadButtonLocator(message);
  const workModeRefs = workModeFileReferenceLocator(message);
  let attachments = downloadLinks;
  if ((await attachments.count()) === 0) attachments = fileCards;
  if ((await attachments.count()) === 0) attachments = inlineLinks;
  if ((await attachments.count()) === 0) attachments = workModeResourceCardDownloads;
  if ((await attachments.count()) === 0) attachments = workModeRefs;
  const totalMatched = await attachments.count();
  // resource card CÓ nút Download nhưng aria-label CHUNG CHUNG ("Download
  // file", không có tên file) — nếu đang ở nhánh này, dedupe/đặt tên file
  // phải tra thêm attribute "title" (tên file thật) trên phần tử hiển thị
  // tên NẰM TRONG CÙNG resource-row thay vì tin vào aria-label (xem docstring
  // workModeResourceCardDownloadButtonLocator).
  const isResourceCardTier = attachments === workModeResourceCardDownloads;

  // Dedupe theo tên file thật (aria-label với 3 locator "Chat"/workModeRefs,
  // hoặc title của resource-row với tier resource card ở trên) — giữ lại
  // index ĐẦU TIÊN cho mỗi tên file, bỏ qua các lần khớp lặp lại sau đó của
  // CÙNG 1 file.
  const seenLabels = new Set<string>();
  const indicesToProcess: number[] = [];
  for (let i = 0; i < totalMatched; i++) {
    const label = isResourceCardTier
      ? ((await workModeResourceCardRowLocator(message)
          .nth(i)
          .locator("[title]")
          .first()
          .getAttribute("title")
          .catch(() => null)) ?? `__no-label-${i}`)
      : ((await attachments
          .nth(i)
          .getAttribute("aria-label")
          .catch(() => null)) ?? `__no-label-${i}`);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    indicesToProcess.push(i);
  }
  console.log(
    `[chatAI] downloadAttachedFiles: khớp ${totalMatched} attachment, xử lý ${indicesToProcess.length} file (đã dedupe theo tên).`,
  );

  const savedPaths: string[] = [];
  // Nếu user gửi prompt qua file .txt (vd "cay_khe.txt"), đặt tên file ChatAI
  // trả về giống tên file đó (giữ nguyên đuôi thật của file tải về, vd
  // .json) thay vì tên ChatAI tự đặt — dễ đối chiếu với file prompt gốc. Nhiều
  // file cùng lượt (hiếm) thì đánh số thêm "-2", "-3"... để không đè lên nhau.
  const promptFileBaseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : null;

  for (const i of indicesToProcess) {
    console.log(
      `[chatAI] downloadAttachedFiles (index ${i}): bắt đầu tải file đính kèm...`,
    );
    try {
      // QUAN TRỌNG: gắn .catch() NGAY khi tạo promise (cùng statement), TRƯỚC
      // khi click() — nếu không, click() throw (vd element bị re-render/stale
      // giữa các lượt "yes" của vòng lặp askChatAI) sẽ nhảy thẳng ra catch
      // bên ngoài trong khi downloadPromise vẫn đang chờ, chưa kịp gắn
      // .catch() ở dòng sau — promise đó reject "mồ côi" sau khi hết timeout,
      // gây unhandled rejection làm crash tiến trình (đã xác nhận qua log
      // thật: lỗi "Timeout 15000ms exceeded" vẫn lọt ra ngoài dù đã có
      // .catch() ở dòng kế tiếp, vì click() đã throw trước khi chạy tới đó).
      const downloadPromise = page
        .waitForEvent("download", { timeout: 15_000 })
        .catch(() => null);
      // force: true — DOM thật xác nhận: nút "Download <filename>"
      // (aria-label bắt đầu bằng "Download ") đôi khi là 1 icon nhỏ chỉ hiện
      // khi hover, NẰM ĐÈ LÊN bởi chính thẻ "card" file (aria-label=tên file,
      // class "group/open-file") to hơn ở CÙNG toạ độ — click bình thường
      // luôn bị coi là "intercepts pointer events" bởi thẻ card và timeout
      // sau 30s dù nút Download đã "visible, enabled, stable". Nút vẫn đúng
      // là nút cần bấm (đã xác nhận qua log thật) nên bỏ qua check hit-target
      // bằng force, không đổi selector.
      await attachments.nth(i).click({ force: true });
      let download = await downloadPromise;

      if (!download) {
        const secondaryDownloadPromise = page
          .waitForEvent("download", { timeout: 10_000 })
          .catch(() => null);
        const downloadButton = await firstVisible(
          downloadButtonCandidates(page),
          5000,
        ).catch(() => null);
        if (downloadButton) {
          // force: true — cùng lý do với click ở trên: DOM thật xác nhận nút
          // "Download" (data-testid="download-files-turn-action-button") bị
          // 1 <div class="z-0 flex justify-end"> (hoặc icon svg con của
          // chính nút) chồng lên đúng toạ độ, khiến click thường luôn bị coi
          // là "intercepts pointer events" và timeout sau 30s dù nút đã
          // visible/enabled/stable — đúng nút cần bấm, chỉ bỏ qua check
          // hit-target.
          await downloadButton.click({ force: true });
        }
        download = await secondaryDownloadPromise;
      }

      if (!download) {
        // Xác nhận qua debug thật (job 0c2ee0e8, b38b1151): bấm file (dù
        // qua thẻ card hay link "Download file <tên>") đều có thể chỉ mở ra
        // panel xem trước dạng "Library" (data-testid="screen-threadFlyOut").
        // Chờ panel xuất hiện lâu hơn (tới 20s — panel có thể chậm render
        // sau khi vừa bấm) rồi lấy nội dung.
        const panelContainer = page.locator(
          '[data-testid="screen-threadFlyOut"]',
        );
        const panelAppeared = await panelContainer
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);

        let previewText: string | null = null;
        if (panelAppeared) {
          const panelContent = panelContainer.locator(".cm-content");
          // Xác nhận qua debug thật (job
          // "...Episode_3_-_SSS-Rank-_The_Slum-Born_Thunder_God_-_ReelShort.mp4"):
          // panel đôi khi hiện "Preview unavailable." + nút "Download" THAY
          // VÌ nội dung CodeMirror (.cm-content) — không phải mọi lần mở
          // panel đều có preview đọc được như trước đây giả định. Phải chờ
          // XÁC NHẬN .cm-content có thật render hay không rồi mới chọn đúng
          // nhánh xử lý, không mặc định luôn có.
          const hasCodePreview = await panelContent
            .first()
            .waitFor({ state: "visible", timeout: 5000 })
            .then(() => true)
            .catch(() => false);

          if (hasCodePreview) {
            // Chọn hết + copy thay vì .innerText() trực tiếp — CodeMirror
            // (editor panel này dùng) có thể ẢO HOÁ (virtualize) nội dung file
            // dài, .innerText() khi đó chỉ đọc được đúng phần đang cuộn tới
            // màn hình chứ KHÔNG PHẢI toàn bộ file. Ctrl+A/Ctrl+C mô phỏng
            // thao tác "chọn hết" thật của CodeMirror (chọn theo MODEL dữ liệu
            // đầy đủ, không phải theo DOM đang render), đọc lại từ clipboard
            // ra được TOÀN BỘ nội dung bất kể có ảo hoá hay không.
            const grantErr = await page
              .context()
              .grantPermissions(["clipboard-read", "clipboard-write"], {
                origin: config.chatAIBaseUrl,
              })
              .then(() => null)
              .catch((err) => err);
            const clickErr = await panelContent
              .first()
              .click()
              .then(() => null)
              .catch((err) => err);
            await page.keyboard.press("ControlOrMeta+A");
            await page.keyboard.press("ControlOrMeta+C");
            let clipboardErr: unknown = null;
            previewText = await page
              .evaluate(() => navigator.clipboard.readText())
              .catch((err) => {
                clipboardErr = err;
                return null;
              });
            console.log(
              `[chatAI] downloadAttachedFiles preview panel (index ${i}): grantPermissions${grantErr ? ` lỗi=${grantErr}` : " ok"}, click panel${clickErr ? ` lỗi=${clickErr}` : " ok"}, clipboard đọc được ${previewText ? previewText.length : 0} ký tự${clipboardErr ? `, lỗi clipboard=${clipboardErr}` : ""}`,
            );
            // Fallback cuối nếu clipboard đọc lỗi (vd bị chặn Permissions-Policy
            // — xem lý do tương tự ở sendMessage): dùng innerText(), chấp nhận
            // rủi ro thiếu nội dung nếu panel có ảo hoá, còn hơn không có gì.
            if (!previewText) {
              let innerTextErr: unknown = null;
              previewText = await panelContent
                .first()
                .innerText({ timeout: 5000 })
                .catch((err) => {
                  innerTextErr = err;
                  return null;
                });
              console.log(
                `[chatAI] downloadAttachedFiles preview panel (index ${i}): innerText fallback đọc được ${previewText ? previewText.length : 0} ký tự${innerTextErr ? `, lỗi=${innerTextErr}` : ""}`,
              );
            }
          } else {
            // KHÔNG có .cm-content — panel đang ở biến thể "Preview
            // unavailable." (chỉ có nút Download, không có gì để đọc qua
            // clipboard/innerText). Best-effort: vẫn thử bấm nút Download
            // NẰM TRONG panel này rồi chờ sự kiện download — ghi nhận CŨ (job
            // 0c2ee0e8/b38b1151, lúc panel CÓ preview code) là nút Download
            // trong panel KHÔNG BAO GIỜ bắn được sự kiện download Playwright
            // bắt được (nghi dùng File System Access API), nhưng CHƯA có
            // bằng chứng thật cho đúng biến thể "Preview unavailable" này —
            // rất có thể dùng cơ chế tải khác hẳn vì không cần dựng
            // CodeMirror, nên vẫn đáng thử trước khi chịu mất hẳn file.
            console.warn(
              `[chatAI] downloadAttachedFiles (index ${i}): panel hiện "Preview unavailable" (không có nội dung CodeMirror để đọc) — thử bấm nút Download trong panel.`,
            );
            const panelDownloadButton = panelContainer.getByRole("button", {
              name: /^download$/i,
            });
            const hasPanelDownloadButton = await panelDownloadButton
              .first()
              .isVisible({ timeout: 3000 })
              .catch(() => false);
            if (hasPanelDownloadButton) {
              const panelDownloadPromise = page
                .waitForEvent("download", { timeout: 15_000 })
                .catch(() => null);
              // Bổ sung: xác nhận qua log lỗi thật (job
              // 69e2966e-3248-4ff8-95f0-2932744257d2_bat_mi_khoi_nghiep.mp4)
              // — nút Download trong panel "Preview unavailable" KHÔNG bắn
              // sự kiện download nào Playwright bắt được (giống hệt biến thể
              // có preview code, xem comment ở nhánh else phía trên). Nghi
              // ChatGPT mở nội dung blob ở TAB MỚI (window.open) thay vì tải
              // xuống thật — chưa có bằng chứng debug trực tiếp xác nhận,
              // nhưng đây là hành vi phổ biến của ChatGPT với file
              // preview-unavailable, nên thử nghe thêm sự kiện "page" mới ở
              // cùng context, đọc thẳng nội dung text nếu có, best-effort
              // (không thay thế download event, chỉ bổ sung thêm 1 lối
              // thoát nếu vẫn thất bại như trước).
              const popupPromise = page
                .context()
                .waitForEvent("page", { timeout: 15_000 })
                .catch(() => null);
              await panelDownloadButton
                .first()
                .click({ force: true })
                .catch(() => {});
              download = await panelDownloadPromise;
              if (!download) {
                const popup = await popupPromise;
                if (popup) {
                  await popup.waitForLoadState("load").catch(() => {});
                  previewText = await popup
                    .evaluate(() => document.body.innerText)
                    .catch(() => null);
                  console.log(
                    `[chatAI] downloadAttachedFiles panel Download (index ${i}): mở tab mới, đọc được ${previewText ? previewText.length : 0} ký tự.`,
                  );
                  await popup.close().catch(() => {});
                }
              }
            }
          }
        }

        if (!download) {
          if (!previewText) {
            // Xác nhận qua thực tế (job 38b68c7a): downloadFileLinkLocator
            // không còn khớp nút nào trên bản UI mới của ChatAI (đã đổi hết
            // sang aria-label "Download file"/"Download" chung chung, không
            // còn "Download <tên file>"), buộc fallback sang panel xem trước —
            // nếu clipboard/innerText/nút Download trong panel ĐỀU thất bại,
            // trước đây code lặng lẽ bỏ qua (continue) không log gì, khiến
            // không thể biết bước tải file đã fail ở đây khi xem log thật.
            console.warn(
              `[chatAI] Không đọc/tải được nội dung preview file đính kèm (index ${i}) — panel${
                panelAppeared ? " đã mở nhưng đọc rỗng" : " không mở ra được"
              }, bỏ qua file này.`,
            );
          }

          if (previewText) {
            await fs.promises.mkdir(config.chatAIResultsDir, {
              recursive: true,
            });
            const suggestedName =
              (await attachments
                .nth(i)
                .getAttribute("aria-label")
                .catch(() => null)) || `attachment-${i}.json`;
            const fileName = promptFileBaseName
              ? `${promptFileBaseName}${savedPaths.length > 0 ? `-${savedPaths.length + 1}` : ""}${path.extname(suggestedName) || ".json"}`
              : suggestedName;
            const filePath = path.join(config.chatAIResultsDir, fileName);
            await fs.promises.writeFile(filePath, previewText, "utf-8");
            savedPaths.push(filePath);
          }

          // SỬA (xác nhận qua lỗi thật, job a22dba4a-da81-48a4-89c3-8603f849a8a9):
          // bước đóng panel TRƯỚC ĐÂY nằm TRONG nhánh `if (previewText)` — nếu
          // đọc previewText thất bại (clipboard lỗi + innerText cũng lỗi/rỗng,
          // xem log cảnh báo ở trên), panel "Library" bị bỏ mở LUÔN, làm bóp
          // hẹp layout composer ở MỌI lượt sau, khiến sendMessage không tìm
          // thấy ô nhập nào còn hiển thị (đã thêm lưới an toàn thứ 2 ngay đầu
          // sendMessage, nhưng đóng sớm NGAY TẠI ĐÂY vẫn đúng hơn — không để
          // trạng thái hỏng kéo dài qua các bước khác không liên quan). Đóng
          // UNCONDITIONALLY mỗi khi panel đã thực sự mở (panelAppeared), không
          // phụ thuộc việc đọc nội dung có thành công hay không.
          if (panelAppeared) {
            await page
              .locator(
                '[data-testid="screen-threadFlyOut"] [data-testid="close-button"]',
              )
              .first()
              .click({ timeout: 2000 })
              .catch(() => {});
          }
          continue;
        }

        // Bấm nút Download TRONG panel (biến thể "Preview unavailable") ĐÃ
        // bắn được sự kiện download thật — đóng panel rồi rơi xuống nhánh
        // lưu file DÙNG CHUNG bên dưới (giống hệt cách xử lý "download" bắt
        // được từ downloadPromise/secondaryDownloadPromise ở trên), không
        // viết trùng logic lưu file ở đây.
        await page
          .locator(
            '[data-testid="screen-threadFlyOut"] [data-testid="close-button"]',
          )
          .first()
          .click({ timeout: 2000 })
          .catch(() => {});
      }

      await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
      const suggested = download.suggestedFilename() || `attachment-${i}`;
      const fileName = promptFileBaseName
        ? `${promptFileBaseName}${savedPaths.length > 0 ? `-${savedPaths.length + 1}` : ""}${path.extname(suggested)}`
        : suggested;
      const filePath = path.join(config.chatAIResultsDir, fileName);
      await download.saveAs(filePath);
      savedPaths.push(filePath);
      console.log(
        `[chatAI] downloadAttachedFiles (index ${i}): đã lưu "${filePath}".`,
      );
    } catch (err) {
      console.warn(`[chatAI] Không tải được file đính kèm (index ${i}):`, err);
    }
  }

  return savedPaths;
}

/**
 * ChatAI báo đã hoàn thiện bản JSON storyboard — coi là dấu hiệu DUY NHẤT để
 * DỪNG gửi "yes" tiếp (KHÔNG dừng chỉ vì đã có file đính kèm — ChatAI có thể
 * đính kèm file trung gian/nháp trước khi thật sự hoàn thiện). Nhận diện qua
 * 1 trong các cách diễn đạt:
 * - "Đã hoàn thiện bản JSON"
 * - "production-ready" kèm "đầy đủ"
 *
 * KHÔNG check chữ "full.json" xuất hiện trong TEXT nữa — xác nhận qua debug
 * thật (job 463abed5): ChatAI có thể nhắc "_full.json" khi mô tả QUY ƯỚC đặt
 * tên file SẼ dùng (vd "sẽ đặt tên file chứa _full.json") — TRƯỚC khi thật
 * sự tạo xong file, không phải xác nhận đã hoàn thiện. Check kiểu "chữ xuất
 * hiện ở bất kỳ đâu trong text" bị false positive ở đúng trường hợp này,
 * khiến vòng lặp coi là "xong" quá sớm trong khi chưa có file thật, rồi kẹt
 * trạng thái dở dang. Tên file "full.json" giờ chỉ được coi là dấu hiệu hoàn
 * thiện khi nó THẬT SỰ là tên 1 file đã tải về (xem readLatestAssistantMessage).
 */
function isCompletionText(text: string): boolean {
  if (/đã hoàn thành/i.test(text)) return true;
  if (/đã hoàn thiện bản json/i.test(text)) return true;
  return /production-ready/i.test(text) && /đầy đủ/i.test(text);
}

/**
 * ChatAI TỰ BÁO rõ ràng là CHƯA xong (xác nhận qua log lỗi thật: "do giới
 * hạn xử lý trong lượt này tôi mới serialize phần đầu storyboard. Cần tiếp
 * tục mở rộng các continuity run còn lại") — luôn ưu tiên tín hiệu này HƠN
 * hasFullJsonFile, vì ChatAI vẫn đặt tên file đính kèm đúng quy ước
 * "_full.json" (theo yêu cầu ở prompt_master.txt) NGAY CẢ KHI file đó chỉ
 * mới chứa phần đầu storyboard — nếu chỉ dựa vào tên file, vòng lặp sẽ dừng
 * nhầm ở file dở dang này.
 */
function isIncompleteText(text: string): boolean {
  return /giới hạn xử lý|chưa (thể )?hoàn thành|chưa hoàn thiện|cần tiếp tục|còn lại|continuity run còn|phần đầu|mới serialize|chỉ (mới|vừa) (tạo|serialize|xuất)/i.test(
    text,
  );
}

/**
 * ChatAI đọc được file đính kèm nhưng khẳng định (SAI, xác nhận qua debug
 * thật job 35941268/1aacc019, file đính kèm THẬT SỰ có kịch bản ở cuối)
 * rằng file "chưa chứa kịch bản phim", yêu cầu người dùng gửi lại kịch bản —
 * thường gặp với file rất dài (kịch bản nằm ở cuối file, có thể ChatAI chưa
 * xử lý/để ý tới phần đó). Nhận diện qua các cách diễn đạt thực tế đã gặp:
 * "chưa có/chứa kịch bản...", "gửi tiếp/gửi lại kịch bản phim...".
 */
function isMissingScriptText(text: string): boolean {
  return /chưa (có|chứa) kịch bản|gửi (tiếp|lại) (toàn bộ )?kịch bản|gửi kịch bản phim/i.test(
    text,
  );
}

/**
 * ChatAI báo LỖI CÔNG CỤ đọc file đính kèm — KHÁC hẳn isMissingScriptText
 * (đó là ChatAI đọc được file nhưng KHẲNG ĐỊNH SAI nội dung không có kịch
 * bản; đây là ChatAI KHÔNG ĐỌC ĐƯỢC file chút nào, thường do trục trặc phía
 * hạ tầng xử lý file của chính ChatGPT) — theo yêu cầu người dùng, nhận diện
 * qua các cách diễn đạt thực tế: "chưa thể đọc (được) file", "lỗi kết nối"
 * kèm "môi trường xử lý (tệp|file)", hoặc ChatAI tự đề nghị "dán nội dung
 * file vào tin nhắn" (paste content trực tiếp) thay vì đọc file đính kèm.
 */
function isFileAccessErrorText(text: string): boolean {
  return /chưa thể đọc (được )?file|(lỗi|sự cố) kết nối.*(môi trường|xử lý (tệp|file))|môi trường xử lý (tệp|file).*(lỗi|sự cố)|dán (nội dung|trực tiếp) (file|tệp).*vào (tin nhắn|đây|khung chat)/i.test(
    text,
  );
}

/**
 * Đánh dấu đầu phần kịch bản thật trong file đính kèm (xem
 * prompt_master.txt/format_output.txt) — export để handlers.ts dùng chung
 * khi chèn nội dung config.formatOuput vào TRƯỚC marker này trong file user
 * upload (xem tryReplaceGeneratedFile/chatAI document handler), tránh viết
 * trùng regex ở 2 nơi.
 */
export const SCRIPT_SECTION_MARKER = /#\s*ĐÂY LÀ KỊCH BẢN/i;

/**
 * Cắt phần kịch bản thật (từ dòng "# ĐÂY LÀ KỊCH BẢN" tới hết file) ra khỏi
 * file đính kèm — dùng khi ChatAI báo nhầm "chưa có kịch bản" (xem
 * isMissingScriptText). Thay vì upload lại NGUYÊN file dài (có thể lại bị bỏ
 * sót y hệt lần trước, xem job 35941268/1aacc019: file 97KB, kịch bản nằm ở
 * cuối), gửi THẲNG đúng đoạn kịch bản dưới dạng text để chắc chắn ChatAI đọc
 * trọn vẹn không phải tìm lại trong 1 file lớn. Trả về null nếu không tìm
 * thấy marker (file không theo đúng cấu trúc mong đợi) — caller tự fallback.
 */
async function extractScriptFromAttachment(
  filePath: string,
): Promise<string | null> {
  const content = await fs.promises
    .readFile(filePath, "utf-8")
    .catch(() => null);
  if (!content) return null;
  const match = content.match(SCRIPT_SECTION_MARKER);
  if (!match || match.index === undefined) return null;
  const script = content.slice(match.index).trim();
  return script || null;
}

/**
 * Lấy file đính kèm (nếu có) và nội dung text của tin nhắn trả lời MỚI NHẤT
 * từ ChatAI.
 *
 * minMessageCount: số tin nhắn trả lời TỐI THIỂU phải đếm được trước khi đọc
 * — caller truyền vào (số tin nhắn đã thấy ở lượt TRƯỚC + 1) để đảm bảo hàm
 * này đọc đúng tin nhắn MỚI vừa được gửi lên, không phải tin nhắn CŨ còn sót
 * lại từ lượt trước. Xác nhận qua debug thật (job 22446d34): sendMessage
 * chỉ chờ tới khi nút "Stop generating" biến mất — DOM có thể vẫn kẹt tin
 * nhắn CŨ 1 lúc SAU đó trước khi tin nhắn mới thật sự append vào DOM. Code
 * cũ chỉ chờ "count !== 0" (đúng cho lượt ĐẦU TIÊN, khi count đang là 0) —
 * từ lượt thứ 2 trở đi, count đã ≥ 1 sẵn từ lượt trước nên điều kiện đó luôn
 * đúng NGAY LẬP TỨC dù tin nhắn mới CHƯA kịp xuất hiện, khiến hàm đọc lại
 * đúng tin nhắn CŨ (2 lượt liên tiếp cho kết quả snapshot giống hệt nhau).
 */
async function readLatestAssistantMessage(
  page: Page,
  promptFileName?: string,
  minMessageCount = 1,
): Promise<{
  downloadedFiles: string[];
  isComplete: boolean;
  missingScript: boolean;
  fileAccessError: boolean;
  messageCount: number;
}> {
  const messages = assistantMessageLocator(page);
  // Xác nhận qua debug thật (job 98d9a048): dù sendMessage đã xác nhận ChatAI
  // trả lời xong thật (hasSeenGenerating true, nút Stop đã biến mất hẳn),
  // trang đôi khi vẫn kẹt ở màn hình loading (spinner giữa trang, canonical
  // URL chưa kịp đổi sang "/c/...") 1 lúc trước khi lịch sử hội thoại thật sự
  // render ra DOM — không phải do sendMessage kết luận sai, mà do trang tải
  // chậm SAU KHI đã xong. Poll thêm vài giây thay vì throw ngay ở lần check
  // đầu tiên. Chờ tới khi ĐẠT minMessageCount (không chỉ khác 0) — xem
  // docstring hàm này.
  let count = await messages.count();
  const pollDeadline = Date.now() + 30_000;
  while (count < minMessageCount && Date.now() < pollDeadline) {
    await page.waitForTimeout(1000);
    count = await messages.count();
  }
  if (count === 0) {
    throw new ChatAIError(
      "Không tìm thấy câu trả lời nào từ ChatAI trên trang",
    );
  }
  const latest: Locator = messages.last();

  const downloadedFiles = await downloadAttachedFiles(
    page,
    latest,
    promptFileName,
  );
  const text = await latest.innerText().catch(() => "");
  // Tên file "full.json" chỉ tính là dấu hiệu hoàn thiện khi có 1 file THẬT
  // đã tải về mang tên đó (xem comment isCompletionText) — NHƯNG vẫn phải
  // thua tín hiệu "tự báo chưa xong" (xem isIncompleteText) vì ChatAI có thể
  // đặt tên file này đúng quy ước dù nội dung mới chỉ là phần đầu.
  const hasFullJsonFile = downloadedFiles.some((p) => /full\.json$/i.test(p));

  return {
    downloadedFiles,
    isComplete:
      !isIncompleteText(text) && (hasFullJsonFile || isCompletionText(text)),
    missingScript: isMissingScriptText(text),
    fileAccessError: isFileAccessErrorText(text),
    messageCount: count,
  };
}

/**
 * Chọn mode "Công việc"/"Work" thay vì "Trò chuyện"/"Chat" (DOM thật xác
 * nhận: radio group `data-tpp-toggle-value="chatgpt|work"`) — best-effort,
 * không throw nếu không tìm thấy toggle (có thể site đã đổi giao diện, hoặc
 * tài khoản không có tính năng này) và bỏ qua nếu đã ở đúng mode "work"
 * (aria-checked="true") để tránh click thừa.
 */
export async function selectWorkMode(page: Page, jobId: string): Promise<void> {
  try {
    const workToggle = workModeToggleLocator(page).first();
    const alreadyOn =
      (await workToggle.getAttribute("aria-checked").catch(() => null)) ===
      "true";
    if (alreadyOn) return;

    // "modal-beacon" (overlay toàn màn hình thoáng qua của ChatGPT, kiểu
    // thông báo/spotlight tính năng mới) đôi khi che mất toggle này ngay
    // lúc click — xác nhận qua lỗi thật ("<div data-state=\"open\" ...>
    // subtree intercepts pointer events" từ #modal-beacon), kéo dài hết cả
    // 10s retry mặc định của Playwright, KHÔNG tự biến mất trong lúc đó.
    // Escape trước khi thử click — cách đóng phổ biến nhất cho overlay kiểu
    // này, best-effort (vô hại nếu không có gì để đóng).
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    // 15s thay vì 10s — cùng lý do đã sửa cho các click của Pollo (Generate,
    // upload dialog): dưới tải CPU cao, actionability check pass hết nhưng
    // "performing click action" treo tới đúng mốc timeout dù click đã ăn
    // thật, không phải lỗi logic/overlay.
    await workToggle.click({ timeout: 15_000 });
  } catch (err) {
    console.warn(
      "[chatAI] Không chọn được mode 'Work' (best-effort, bỏ qua):",
      err instanceof Error ? err.message : err,
    );
    await captureSnapshot(page, jobId, `selectWorkMode-fail-${Date.now()}`);
  }
}

/**
 * Chọn mode "Trò chuyện"/"Chat" (cùng radio group với selectWorkMode ở
 * trên, xem chatModeToggleLocator) — theo yêu cầu người dùng: askChatAI/
 * askChatAIWithInlineContent chuyển từ "Work" sang "Chat". Lý do đổi: mode
 * "Work" có quota RIÊNG, tách biệt khỏi quota Chat thường ("5-hour limit" —
 * xác nhận qua test thật lúc kiểm tra selectModelGPT6AstraMediumEffort, tài
 * khoản báo "You're out of Work usage for now" dù chat thường vẫn dùng
 * được) — dùng Chat tránh phụ thuộc vào quota riêng này. GPT-6 Astra (model
 * đã thêm cho Work mode) KHÔNG tồn tại ở mode Chat nên KHÔNG còn gọi
 * selectModelGPT6AstraMediumEffort ở đây nữa (xem 2 nơi gọi hàm này).
 */
export async function selectChatMode(page: Page, jobId: string): Promise<void> {
  try {
    const chatToggle = chatModeToggleLocator(page).first();
    const alreadyOn =
      (await chatToggle.getAttribute("aria-checked").catch(() => null)) ===
      "true";
    if (alreadyOn) return;

    // Cùng lý do đã áp dụng ở selectWorkMode (modal-beacon có thể che toggle).
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    await chatToggle.click({ timeout: 15_000 });
  } catch (err) {
    console.warn(
      "[chatAI] Không chọn được mode 'Chat' (best-effort, bỏ qua):",
      err instanceof Error ? err.message : err,
    );
    await captureSnapshot(page, jobId, `selectChatMode-fail-${Date.now()}`);
  }
}

/**
 * Chọn mode Chat/Work + model theo config.chatAIMode (CHATAI_MODE) — theo
 * yêu cầu người dùng: dùng chung cho askChatAI/askChatAIWithInlineContent
 * thay vì lặp lại if/else ở cả 2 nơi.
 *
 * - "work": selectWorkMode rồi selectModelGPT6AstraMediumEffort (model
 *   "GPT-6 Astra" chỉ tồn tại ở mode Work — xem docstring hàm đó).
 * - "chat" (mặc định): selectChatMode, không chọn model riêng gì (dùng model
 *   mặc định của Chat) — né quota RIÊNG của Work ("5-hour limit").
 */
async function selectChatAIModeFromConfig(page: Page, jobId: string): Promise<void> {
  if (config.chatAIMode === "work") {
    await selectWorkMode(page, jobId);
    await selectModelGPT6AstraMediumEffort(page, jobId);
  } else {
    await selectChatMode(page, jobId);
  }
}

/**
 * Chọn mức "reasoning effort" CAO NHẤT (thanh trượt 5 nấc cạnh ô nhập, xem
 * effortSliderControlLocator) — best-effort, không throw nếu không tìm thấy
 * (site đổi giao diện/tài khoản không có tính năng này) và bỏ qua ngay nếu
 * đã ở mức tối đa (đọc attribute "data-max-effort" trên nhãn nút, xem
 * effortLabelLocator) để tránh mở popup thừa.
 *
 * Cơ chế: bấm nút mở popup thanh trượt, rồi bấm phím "ArrowRight" liên tục
 * lên effortSliderControlLocator (phần tử THẬT nhận phím, role="menuitem"
 * tabindex="0" — KHÔNG phải span role="slider" bên trong, phần tử đó chỉ là
 * proxy hiển thị tabindex="-1") tới khi effortSliderThumbLocator báo
 * aria-valuenow === aria-valuemax (đã ở nấc cao nhất), giới hạn tối đa 6 lần
 * bấm phím để chặn vòng lặp vô hạn nếu site đổi cấu trúc.
 */
export async function selectMaxReasoningEffort(page: Page): Promise<void> {
  try {
    const alreadyMax =
      (await effortLabelLocator(page)
        .first()
        .getAttribute("data-max-effort")
        .catch(() => null)) === "true";
    if (alreadyMax) return;

    const button = await firstVisible(
      modelSelectorButtonCandidates(page),
      5000,
    );
    await button.hover().catch(() => {});
    await page.waitForTimeout(200);
    await button.click();
    await page.waitForTimeout(500);

    const sliderControl = await firstVisible(
      [() => effortSliderControlLocator(page)],
      5000,
    ).catch(() => null);
    if (!sliderControl) {
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }

    for (let i = 0; i < 6; i++) {
      const thumb = effortSliderThumbLocator(page).first();
      const valueNow = await thumb
        .getAttribute("aria-valuenow")
        .catch(() => null);
      const valueMax = await thumb
        .getAttribute("aria-valuemax")
        .catch(() => null);
      if (valueNow !== null && valueNow === valueMax) break;
      await sliderControl.press("ArrowRight");
      await page.waitForTimeout(150);
    }

    await page.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    console.warn(
      "[chatAI] Không chọn được mức hỗ trợ tối đa (best-effort, bỏ qua):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Chọn model "GPT-6 Astra" + mức reasoning effort "Medium" — theo yêu cầu
 * người dùng, dùng cho askChatAI/askChatAIWithInlineContent.
 *
 * Xác nhận qua khảo sát DOM thật (script inspect-chatai-model-picker.ts,
 * storage/debug/inspect-chatai-model-picker*.html):
 * - Model "GPT-6 Astra" CHỈ xuất hiện trong danh sách khi đang ở mode "Work"
 *   (xem selectWorkMode) — mode "Chat" chỉ có 2 lựa chọn (GPT-5.6 Sol,
 *   GPT-5.5), KHÔNG có GPT-6 Astra. Hàm này PHẢI được gọi SAU selectWorkMode.
 * - Bấm nút toolbar (modelSelectorButtonCandidates) → bấm
 *   modelPickerSelectModelToggleLocator ("Select model", chuyển sang
 *   "advanced view") → bấm modelPickerOptionLocator(page, "GPT-6 Astra").
 * - Sau khi CHỌN MODEL MỚI (khác model đang dùng), site TỰ ĐỘNG chuyển
 *   sang lại menu chọn effort (aria-expanded="true" sẵn, không cần bấm gì
 *   thêm) — nhưng effort bị RESET về mặc định "Light" (aria-valuenow="0"),
 *   KHÔNG giữ nguyên mức cũ.
 *
 * SỬA (xác nhận qua test thật — script test-chatai-select-model.ts): LÚC
 * ĐẦU đoán "nấc GIỮA thanh trượt" (Math.round(valuemax/2)) luôn là "Medium"
 * — SAI. Thanh trượt của GPT-6 Astra có 5 nấc (aria-valuemax=4), nhưng nấc
 * GIỮA (index 2) lại hiện nhãn "High", KHÔNG PHẢI "Medium" — tức 5 nấc
 * KHÔNG đối xứng quanh "Medium" như đã suy đoán từ trường hợp GPT-5.6 Sol (3
 * nấc, nấc giữa đúng là "Medium"). KHÔNG suy luận theo vị trí nữa — dò TỪNG
 * NẤC một từ đầu (0), đọc lại nhãn thật (effortLabelLocator — span có
 * data-max-effort, LUÔN phản ánh đúng nhãn hiện tại của thanh trượt, đã
 * dùng ổn định cho selectMaxReasoningEffort) sau mỗi lần bấm, dừng NGAY khi
 * nhãn chứa "Medium" (không phân biệt hoa/thường) — tổng quát cho MỌI cách
 * đặt tên/số nấc site có thể đổi, không hard-code vị trí nào cả.
 *
 * best-effort — không throw nếu không chọn được (site đổi giao diện, tài
 * khoản không có GPT-6 Astra, không có nấc nào tên "Medium"...), chỉ log
 * cảnh báo + chụp debug snapshot, để không chặn cả pipeline vì 1 bước không
 * bắt buộc.
 */
export async function selectModelGPT6AstraMediumEffort(
  page: Page,
  jobId: string,
): Promise<void> {
  const modelName = "GPT-6 Astra";
  try {
    const button = await firstVisible(modelSelectorButtonCandidates(page), 5000);
    await button.hover().catch(() => {});
    await page.waitForTimeout(200);
    await button.click();
    await page.waitForTimeout(500);

    const selectModelToggle = modelPickerSelectModelToggleLocator(page).first();
    const toggleVisible = await selectModelToggle
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (!toggleVisible) {
      console.warn(
        `[chatAI] selectModelGPT6AstraMediumEffort: không thấy "Select model" — bỏ qua, giữ model/effort hiện tại.`,
      );
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }
    await selectModelToggle.click({ timeout: 5000 });
    await page.waitForTimeout(500);

    const option = modelPickerOptionLocator(page, modelName).first();
    const optionVisible = await option.isVisible({ timeout: 3000 }).catch(() => false);
    if (!optionVisible) {
      console.warn(
        `[chatAI] selectModelGPT6AstraMediumEffort: không thấy model "${modelName}" trong danh sách (có thể tài khoản chưa có, hoặc chưa ở mode Work) — bỏ qua.`,
      );
      await page.keyboard.press("Escape").catch(() => {});
      await captureSnapshot(page, jobId, "select-gpt6-astra-not-found", {
        includeHtml: true,
      });
      return;
    }

    const alreadySelected =
      (await option.getAttribute("aria-checked").catch(() => null)) === "true";
    if (!alreadySelected) {
      await option.click({ timeout: 5000 });
      await page.waitForTimeout(800);
    }

    const sliderControl = await firstVisible(
      [() => effortSliderControlLocator(page)],
      5000,
    ).catch(() => null);
    if (!sliderControl) {
      console.warn(
        `[chatAI] selectModelGPT6AstraMediumEffort: đã chọn model "${modelName}" nhưng không thấy thanh trượt effort — bỏ qua bước set "Medium".`,
      );
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }

    const thumb = effortSliderThumbLocator(page).first();
    const valueMaxText = await thumb.getAttribute("aria-valuemax").catch(() => null);
    const valueMax = Number.parseInt(valueMaxText ?? "", 10);
    if (!Number.isFinite(valueMax) || valueMax <= 0) {
      console.warn(
        `[chatAI] selectModelGPT6AstraMediumEffort: không đọc được aria-valuemax hợp lệ ("${valueMaxText}") — bỏ qua bước set "Medium".`,
      );
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }

    // Về hẳn nấc 0 trước (dư số lần bấm, không suy đoán vị trí ban đầu).
    for (let i = 0; i < 8; i++) {
      await sliderControl.press("ArrowLeft");
      await page.waitForTimeout(100);
    }

    let reachedMedium = false;
    const announcement = effortSliderAnnouncementLocator(page).first();
    for (let step = 0; step <= valueMax; step++) {
      const currentLabel = await announcement.innerText().catch(() => "");
      if (/medium/i.test(currentLabel)) {
        reachedMedium = true;
        break;
      }
      if (step < valueMax) {
        await sliderControl.press("ArrowRight");
        await page.waitForTimeout(150);
      }
    }

    const finalValue = await thumb.getAttribute("aria-valuenow").catch(() => null);
    const finalLabel = await announcement
      .innerText()
      .catch(() => "(không đọc được)");
    console.log(
      `[chatAI] selectModelGPT6AstraMediumEffort: đã chọn model "${modelName}", effort hiện tại "${finalLabel}" (nấc ${finalValue}/${valueMax})${reachedMedium ? "" : " — KHÔNG tìm thấy nấc nào tên 'Medium', dừng ở nấc cuối đã dò"}.`,
    );
    if (!reachedMedium) {
      await captureSnapshot(page, jobId, "select-gpt6-astra-no-medium-level", {
        includeHtml: true,
      });
    }

    await page.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    console.warn(
      `[chatAI] selectModelGPT6AstraMediumEffort thất bại (best-effort, bỏ qua, giữ model/effort mặc định):`,
      err instanceof Error ? err.message : err,
    );
    await captureSnapshot(page, jobId, "select-gpt6-astra-failed", {
      includeHtml: true,
    });
  }
}

/**
 * Mở ChatAI, gửi prompt, chờ ChatAI trả lời xong, rồi thử tải file ChatAI
 * đính kèm (nếu có, xem downloadAttachedFiles) về config.chatAIResultsDir.
 *
 * Nếu trả lời xong mà phản hồi CHƯA báo đã hoàn thiện (xem isCompletionText
 * — "Đã hoàn thiện bản JSON", "production-ready" kèm "đầy đủ", hoặc nhắc tới
 * "full.json"), chụp lại ảnh màn hình trạng thái hiện tại RỒI gửi tiếp "yes"
 * để ChatAI tiếp tục, lặp lại tới khi isComplete = true thì dừng (giới hạn
 * MAX_TURNS_WAITING_FOR_FILE lượt để chặn lặp vô hạn nếu ChatAI không bao giờ
 * báo xong). CHỈ dừng theo isComplete — có file đính kèm KHÔNG tự động dừng
 * (có thể là file nháp/trung gian) — không có file sau khi hết lượt cũng
 * không coi là lỗi, chỉ trả về mảng rỗng.
 */
export async function askChatAI(
  prompt: string,
  jobId: string,
  promptFileName?: string,
  /** Path local file đính kèm (tuỳ chọn) — nếu có, UPLOAD file này lên composer TRƯỚC khi gõ prompt (xem uploadAttachment), dùng khi user gửi prompt qua file thay vì gõ trực tiếp. */
  attachmentPath?: string,
  /**
   * true (mặc định, giữ hành vi cũ) khi attachmentPath là 1 file KỊCH BẢN
   * DẠNG TEXT (.txt/.md) — cho phép 2 fallback missingScript/fileAccessError
   * bên dưới đọc THẲNG attachmentPath bằng fs.readFile(..., "utf-8") rồi dán
   * nội dung vào tin nhắn. Đặt false khi attachmentPath là file NHỊ PHÂN
   * (video/ảnh, vd askChatAIAboutReferenceVideo) — đọc file nhị phân bằng
   * "utf-8" không throw (Buffer luôn decode được, dù ra chuỗi rác) nên
   * nhánh cũ sẽ ÂM THẦM dán hàng chục/hàng trăm KB dữ liệu rác vào tin nhắn
   * thay vì phát hiện lỗi — false thì bỏ qua thẳng 2 nhánh đọc-file-làm-text
   * này, chỉ re-upload lại file rồi nhắc ChatAI tiếp tục.
   */
  attachmentIsScript = true,
): Promise<{ downloadedFiles: string[] }> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  try {
    await gotoChatAIWithRetry(page, config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new ChatAIError(
        "Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai",
      );
    }

    // domcontentloaded fire sớm với SPA — chờ mạng rảnh trước khi tìm ô nhập
    // prompt, cùng lý do đã áp dụng cho AIVideo (xem generateVideo).
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    // Theo yêu cầu người dùng: chọn Work/Chat + model theo config.chatAIMode
    // (CHATAI_MODE) — xem docstring selectChatAIModeFromConfig.
    await selectChatAIModeFromConfig(page, jobId);
    // await captureSnapshot(page, jobId + "_askChatAI-before-send", "askChatAI-before-send", {
    //   includeHtml: true,
    // });
    if (attachmentPath) {
      await uploadAttachment(page, attachmentPath);
    }

    // Theo yêu cầu người dùng: BỎ bước audit riêng (trước đây bắt buộc thêm
    // 1 lượt yêu cầu ChatAI tự đối chiếu lại toàn bộ file trước khi chấp
    // nhận isComplete=true) — chỉ còn dựa thẳng vào isComplete (xem
    // isCompletionText/isIncompleteText) để quyết định dừng hay tiếp tục.
    const CONTINUE_MESSAGE =
      "yes. chỉ gửi file JSON kết quả khi đã ghép hết các phần và tên file chứa _full.json";

    let messageToSend = prompt;
    let downloadedFiles: string[] = [];
    let lastMessageCount = 0;
    // Theo yêu cầu người dùng (processChatAIQueue: fallback sang
    // askChatAIWithInlineContent khi askChatAI dính fileAccessError) — track
    // xem LƯỢT GẦN NHẤT có phải fileAccessError hay không, reset về false mỗi
    // lượt MỚI (chỉ true nếu lượt đó THỰC SỰ là fileAccessError) để phản ánh
    // đúng trạng thái lúc vòng lặp kết thúc (không phải "đã từng gặp 1 lần
    // nào đó").
    let lastTurnWasFileAccessError = false;
    for (let turn = 1; turn <= MAX_TURNS_WAITING_FOR_FILE; turn++) {
      lastTurnWasFileAccessError = false;
      await sendMessage(page, messageToSend, jobId);

      const result = await readLatestAssistantMessage(
        page,
        promptFileName,
        lastMessageCount + 1,
      );
      lastMessageCount = result.messageCount;
      await captureSnapshot(
        page,
        jobId + "_" + (promptFileName || ""),
        "result",
      );

      // Xác nhận qua log lỗi thật (job 35941268/1aacc019): ChatAI đọc được
      // file đính kèm nhưng khẳng định SAI là "chưa chứa kịch bản phim" dù
      // file THẬT SỰ có kịch bản (thường gặp với file rất dài, kịch bản nằm
      // ở cuối) — gửi lại đúng "yes"/tiếp tục không giải quyết được gì vì
      // ChatAI đang chờ NỘI DUNG kịch bản, không phải xác nhận tiếp tục. Chủ
      // động upload LẠI file đính kèm (nếu có) rồi báo rõ đã gửi lại, thay vì
      // rơi vào nhánh "chưa hoàn thiện" bên dưới (gửi CONTINUE_MESSAGE sẽ vô
      // ích, lặp lại đúng lỗi này tới hết MAX_TURNS_WAITING_FOR_FILE).
      if (result.missingScript) {
        for (const filePath of result.downloadedFiles) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
        // await captureSnapshot(
        //   page,
        //   `${jobId}-missing-script-turn-${turn}`,
        //   `missing-script-turn-${turn}`,
        // );
        const scriptText =
          attachmentPath && attachmentIsScript
            ? await extractScriptFromAttachment(attachmentPath)
            : null;

        if (scriptText) {
          // Gửi THẲNG đúng đoạn kịch bản dưới dạng text (không upload lại
          // nguyên file dài) — chắc chắn ChatAI đọc trọn vẹn, không phải tự
          // tìm lại trong 1 file lớn (nơi đã bỏ sót lần trước).
          messageToSend = `Bạn báo chưa thấy kịch bản — đây là kịch bản phim đầy đủ (trích từ file đính kèm ban đầu), dùng đúng nội dung này, không cần hỏi lại:\n\n${scriptText}\n\nHãy tiếp tục xử lý theo đúng workflow/quy tắc đã nêu trong file đính kèm ban đầu.`;
        } else if (attachmentPath) {
          await uploadAttachment(page, attachmentPath);
          messageToSend =
            "Tôi vừa gửi lại đúng file kịch bản phim ở trên (file đính kèm) — file này CÓ đầy đủ kịch bản, nằm ở cuối file sau phần hướng dẫn/quy tắc xử lý. Hãy đọc lại toàn bộ file đính kèm (kể cả phần cuối) rồi tiếp tục xử lý theo đúng workflow đã nêu, không cần hỏi lại kịch bản nữa.";
        } else {
          messageToSend =
            "Kịch bản phim đã có sẵn trong nội dung tôi gửi ở trên — hãy đọc lại toàn bộ (kể cả phần cuối) và tiếp tục xử lý, không cần hỏi lại.";
        }
        continue;
      }

      // Theo yêu cầu người dùng: ChatAI báo LỖI CÔNG CỤ đọc file (KHÁC
      // missingScript ở trên — không phải đọc nhầm nội dung, mà KHÔNG đọc
      // được file chút nào, thường do trục trặc hạ tầng xử lý file phía
      // ChatGPT) — thay vì cố upload lại file (dễ lặp lại đúng lỗi công cụ
      // đang hỏng), đọc THẲNG nội dung file từ local rồi dán trực tiếp vào
      // tin nhắn dạng text — né hẳn công cụ đọc file đang lỗi.
      if (result.fileAccessError) {
        lastTurnWasFileAccessError = true;
        for (const filePath of result.downloadedFiles) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
        const fileContent =
          attachmentPath && attachmentIsScript
            ? await fs.promises
                .readFile(attachmentPath, "utf-8")
                .catch(() => null)
            : null;

        if (fileContent) {
          messageToSend = `Bạn báo không đọc được file đính kèm (lỗi môi trường/công cụ xử lý file phía bạn) — đây là TOÀN BỘ nội dung file đó, dán trực tiếp vào đây, dùng đúng nội dung này để tiếp tục xử lý, không cần đọc lại file đính kèm nữa:\n\n${fileContent}`;
        } else if (attachmentPath) {
          await uploadAttachment(page, attachmentPath);
          messageToSend =
            "Tôi vừa gửi lại file đính kèm ở trên — hãy thử đọc lại và tiếp tục xử lý theo đúng workflow/quy tắc đã nêu trong đó.";
        } else {
          messageToSend =
            "Nội dung cần xử lý đã có sẵn trong tin nhắn tôi gửi trước đó — hãy đọc lại và tiếp tục xử lý, không cần file đính kèm nào nữa.";
        }
        continue;
      }

      // SỬA (xác nhận qua log lỗi thật, ChatAI tự báo: "do giới hạn xử lý
      // trong lượt này tôi mới serialize phần đầu storyboard. Cần tiếp tục
      // mở rộng các continuity run còn lại"): gate isComplete này TRƯỚC ĐÂY
      // có 1 `break;` VÔ ĐIỀU KIỆN đặt ngay TRƯỚC dòng if (result.isComplete)
      // — khiến khối if này (và toàn bộ nhánh "Chưa hoàn thiện" bên dưới,
      // vốn đã viết đúng) là DEAD CODE, không bao giờ chạy tới. Vòng lặp
      // LUÔN dừng và nhận storyboard DỞ DANG làm kết quả cuối ngay ở LƯỢT
      // ĐẦU TIÊN, bất kể ChatAI có tự báo "chưa xong" hay không — đây chính
      // là nguyên nhân thật của toàn bộ chênh lệch "output ngắn hơn" đã thấy
      // trước giờ với kịch bản dài, không phải do model/locale/prompt. Xoá
      // hẳn `break;` thừa đó (và dòng gán downloadedFiles thừa đi kèm — đã
      // có đúng bên trong khối if dưới đây) để gate này THỰC SỰ chạy.
      if (result.isComplete) {
        // Ưu tiên file MỚI của lượt này (nếu có) làm kết quả hiện tại; nếu
        // lượt này không đính kèm gì (vd chỉ xác nhận lại bằng lời), GIỮ
        // NGUYÊN file tốt nhất đã có từ lượt trước — không xoá oan.
        if (result.downloadedFiles.length > 0) {
          for (const oldPath of downloadedFiles) {
            await fs.promises.unlink(oldPath).catch(() => {});
          }
          downloadedFiles = result.downloadedFiles;
        }
        break;
      }

      // Chưa hoàn thiện (isComplete = false) — file(s) vừa tải ở lượt này (nếu
      // có) chỉ là bản nháp/trung gian (xem docstring askChatAI), KHÔNG phải
      // kết quả cuối — xoá luôn khỏi đĩa để tránh rác lại config.chatAIResultsDir
      // và tránh nhầm với file thật khi đọc lại sau này.
      for (const filePath of result.downloadedFiles) {
        await fs.promises.unlink(filePath).catch((err) => {
          console.warn(`[chatAI] Không xoá được file nháp "${filePath}":`, err);
        });
      }

      // Chưa có file — chụp lại trạng thái hiện tại TRƯỚC KHI gửi "yes" để
      // còn biết ChatAI đang dừng ở đâu (phần nào) nếu vòng lặp không bao giờ
      // ra được file. Đặt tên file debug riêng theo turn (captureSnapshot ghi
      // file theo đúng tham số jobId truyền vào) — nếu không, mỗi lượt sẽ ghi
      // đè lên đúng 1 file, mất hết ảnh các lượt trước.
      await captureSnapshot(
        page,
        `${jobId}-no-file-turn-${turn}`,
        `no-file-turn-${turn}`,
      );
      messageToSend = CONTINUE_MESSAGE;
    }

    // Theo yêu cầu người dùng: hết MAX_TURNS_WAITING_FOR_FILE lượt mà VẪN
    // chưa có file nào, VÀ lượt cuối cùng vẫn đang dính fileAccessError (ChatGPT
    // báo lỗi công cụ đọc file, KHÔNG phải chỉ "chưa hoàn thiện" bình thường)
    // — throw rõ ràng kèm fileAccessError=true thay vì âm thầm trả về mảng
    // rỗng như trước, để processChatAIQueue phát hiện được và fallback sang
    // askChatAIWithInlineContent.
    if (downloadedFiles.length === 0 && lastTurnWasFileAccessError) {
      throw new ChatAIError(
        `ChatAI báo lỗi công cụ đọc file đính kèm (fileAccessError) lặp lại tới hết ${MAX_TURNS_WAITING_FOR_FILE} lượt, không lấy được file kết quả nào.`,
        { fileAccessError: true },
      );
    }

    return { downloadedFiles };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof ChatAIError
      ? err
      : new ChatAIError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/**
 * Dùng chung cho cả 2 nút "Tham chiếu kịch bản" (SCRIPT_REFERENCE_BUTTON_LABEL)
 * VÀ "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL) trong keyboard.ts —
 * xem submitScriptReferenceVideoJob/processScriptReferenceVideoQueue trong
 * queue.ts. User upload 1 VIDEO tham chiếu (không phải kịch bản text) —
 * upload video này lên ChatAI kèm master prompt tại masterPromptPath (mặc
 * định config.promptSplitVideo — chia SHOT/CLIP theo diễn biến; truyền
 * config.promptVideoReference để chỉ gen 1 VIDEO duy nhất mô tả toàn bộ
 * video, xem prompt_video_reference.txt), yêu cầu ChatAI xem/nghe hết video
 * rồi trả về DUY NHẤT 1 file JSON. Dùng lại nguyên vòng lặp
 * turn/isComplete/downloadAttachedFiles của askChatAI — chỉ khác
 * attachmentIsScript=false vì video là file NHỊ PHÂN, không phải file kịch
 * bản dạng text (xem docstring tham số attachmentIsScript trong askChatAI).
 */
export async function askChatAIAboutReferenceVideo(
  videoPath: string,
  jobId: string,
  /** Tên file video gốc (không bắt buộc) — dùng đặt tên lại file JSON ChatAI trả về, xem promptFileName trong askChatAI/downloadAttachedFiles. */
  videoFileName?: string,
  /** Caption user gõ kèm video — TRANSFORM_MODE mặc định ON (xem master prompt), tham số này dùng để TẮT (vd "giữ nguyên như video gốc") hoặc tuỳ chỉnh thêm. Nối vào CUỐI master prompt, KHÔNG thay thế. */
  extraInstruction?: string,
  /** Path master prompt để đọc (mặc định config.promptSplitVideo) — xem docstring hàm này. */
  masterPromptPath: string = config.promptSplitVideo,
): Promise<{ downloadedFiles: string[] }> {
  const masterPrompt = await fs.promises.readFile(masterPromptPath, "utf-8");
  const prompt = extraInstruction
    ? `${masterPrompt}\n\n## YÊU CẦU BỔ SUNG TỪ NGƯỜI DÙNG (ưu tiên áp dụng, có thể bật TRANSFORM_MODE hoặc điều chỉnh khác so với mặc định ở trên)\n${extraInstruction}`
    : masterPrompt;
  return askChatAI(prompt, jobId, videoFileName, videoPath, false);
}

/**
 * Regex khớp khối ```code fence``` markdown thô (có nhãn ngôn ngữ hay không,
 * vd ```json) — CHỈ dùng làm fallback cuối trong readInlineCodeBlock, phòng
 * trường hợp hiếm ChatAI trả lời bằng markdown thô thay vì widget canvas.
 */
const CODE_BLOCK_PATTERN = /```(?:[a-zA-Z]*)\n([\s\S]*?)```/g;

/** Trích nội dung khối markdown code LỚN NHẤT trong text (phòng trường hợp có nhiều khối) — null nếu không có khối nào. */
function extractLargestCodeBlock(text: string): string | null {
  const matches = [...text.matchAll(CODE_BLOCK_PATTERN)];
  if (matches.length === 0) return null;
  let largest = matches[0][1];
  for (const m of matches) {
    if (m[1].length > largest.length) largest = m[1];
  }
  return largest.trim() || null;
}

/**
 * Đọc nội dung khối "code block" ChatGPT trả trong tin nhắn — xác nhận qua
 * debug DOM thật (job 67d7ec98...): ChatGPT KHÔNG render markdown backtick
 * thô, mà dùng 1 widget canvas riêng (`<div id="code-block-viewer">` bọc 1
 * CodeMirror readonly, nhãn "JSON" + nút Copy phía trên — xem ảnh chụp job
 * đó) — .innerText() của cả tin nhắn KHÔNG hề chứa ký tự "```" nên
 * extractLargestCodeBlock luôn trả null dù rõ ràng CÓ khối JSON trên màn
 * hình.
 *
 * SỬA (xác nhận qua lỗi thật LẶP LẠI 2 LẦN — file lưu ra lẫn CẢ nội dung tin
 * nhắn đã gửi/"Pasted text(...).txt", không chỉ riêng JSON trả lời): cách cũ
 * dùng Ctrl+A/Ctrl+C (theo đúng kỹ thuật của downloadAttachedFiles, phòng
 * CodeMirror ảo hoá nội dung dài) — kể cả sau khi sửa click đúng vào
 * pre.cm-content (bên trong, không phải div bọc ngoài) vẫn KHÔNG cứu được:
 * Ctrl+A trên widget readonly này không scope đúng vào riêng nó, vẫn lọt ra
 * chọn thêm nội dung khác trên trang. Kiểm tra lại qua debug HTML THẬT: toàn
 * bộ nội dung JSON (tới tận dấu "]" đóng cuối) đã có sẵn ĐẦY ĐỦ trong DOM
 * tĩnh ngay từ đầu — widget này KHÔNG ảo hoá (khác panel xem trước file đính
 * kèm mà downloadAttachedFiles xử lý, đó là 1 component khác). Bỏ hẳn
 * Ctrl+A/clipboard — đọc thẳng textContent của CHÍNH phần tử pre.cm-content
 * qua evaluate (không qua .innerText(), tránh CSS/visibility ảnh hưởng,
 * cũng không cần chọn/focus/click gì cả).
 */
async function readInlineCodeBlock(
  page: Page,
  message: Locator,
): Promise<string | null> {
  const viewer = message.locator("#code-block-viewer").first();
  const viewerExists = (await viewer.count().catch(() => 0)) > 0;
  if (!viewerExists) {
    // Fallback: ChatAI lỡ trả markdown backtick thô thay vì widget canvas.
    const text = await message.innerText().catch(() => "");
    return extractLargestCodeBlock(text);
  }
  const codeContent = viewer.locator("pre.cm-content").first();
  const content = await codeContent
    .evaluate((el) => el.textContent)
    .catch(() => null);
  return content?.trim() || null;
}

/** Text CHÍNH XÁC báo hiệu ChatAI đã gửi HẾT các phần của kết quả JSON (xem askChatAIWithInlineContent) — KHÔNG suy đoán qua isIncompleteText/isCompletionText (dành cho askChatAI, ngữ cảnh file đính kèm khác hẳn). */
const INLINE_CONTENT_DONE_MARKER = "Đã hoàn thành";

/**
 * Bản CLONE của askChatAI — theo yêu cầu người dùng, tránh hẳn cơ chế
 * upload/tải file đính kèm của ChatAI (đã xác nhận qua nhiều lỗi thật —
 * missingScript, fileAccessError...: công cụ xử lý file của ChatGPT không ổn
 * định). Khác 2 điểm so với askChatAI:
 *
 * 1. KHÔNG upload file lên composer — đọc thẳng nội dung file (attachmentPath)
 *    từ local, dán TRỰC TIẾP vào tin nhắn dạng text (kèm prompt bổ sung phía
 *    sau), cùng hướng dẫn ChatAI PHẢI trả kết quả JSON ngay trong tin nhắn
 *    (bọc trong khối code), KHÔNG tạo file đính kèm.
 * 2. KHÔNG tải file đính kèm nào — đọc lại tin nhắn trả lời, trích nội dung
 *    trong khối code, tự ghi ra file cục bộ (config.chatAIResultsDir) thay vì
 *    nhờ ChatAI tạo file.
 *
 * SỬA (theo yêu cầu người dùng): output JSON có thể QUÁ DÀI cho 1 lượt trả
 * lời — cho phép ChatAI CHIA THÀNH NHIỀU PHẦN, mỗi lượt trả lời 1 khối code
 * chứa 1 JSON ARRAY (1 phần các item, KHÔNG phải toàn bộ mảng bọc khác đi) —
 * bot tự đọc + nối (concat) các phần lại thành 1 mảng hoàn chỉnh. KHÔNG suy
 * đoán "đã xong" qua việc thấy 1 khối code hợp lệ (có thể chỉ là 1 phần) —
 * CHỈ coi là xong khi tin nhắn trả lời chứa ĐÚNG text
 * INLINE_CONTENT_DONE_MARKER ("Đã hoàn thành"); các phần TRƯỚC đó KHÔNG được
 * chứa text này. Lặp lại (gửi tiếp yêu cầu phần kế) tới khi thấy marker hoặc
 * hết MAX_TURNS_WAITING_FOR_FILE lượt.
 */
/**
 * Xác nhận qua lỗi thật (job 300d3c38...): Chrome renderer crash ("Target
 * crashed") giữa chừng khi hội thoại inline (file dán trực tiếp + nhiều lượt
 * chia phần JSON) phình quá lớn trong DOM — cùng lớp lỗi đã gặp và xử lý ở
 * pollo.ts/aiVideo.ts (xem generateVideo trong pollo.ts). Tự mở tab MỚI thử
 * lại 1 lần trước khi chịu thua — LƯU Ý: hội thoại/tiến độ (các item JSON đã
 * nhận được ở các lượt trước) sống TRONG page đã crash, không cách nào phục
 * hồi được (tab mới = hội thoại ChatAI mới hoàn toàn) — retry ở đây chấp
 * nhận làm lại TỪ ĐẦU, không cố nối tiếp phần dở dang.
 */
export async function askChatAIWithInlineContent(
  prompt: string,
  jobId: string,
  promptFileName?: string,
  attachmentPath?: string,
): Promise<{ downloadedFiles: string[] }> {
  const maxCrashRetries = 1;
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptAskChatAIWithInlineContent(
        prompt,
        jobId,
        promptFileName,
        attachmentPath,
      );
    } catch (err) {
      // if (isPageCrashError(err) && attempt < maxCrashRetries) {
      //   console.warn(
      //     `[chatAI] Chrome renderer crash ("Target crashed") — mở tab mới thử lại từ đầu (lần ${attempt + 1}/${maxCrashRetries}):`,
      //     err instanceof Error ? err.message : err,
      //   );
      //   continue;
      // }
      throw err;
    }
  }
}

async function attemptAskChatAIWithInlineContent(
  prompt: string,
  jobId: string,
  promptFileName?: string,
  attachmentPath?: string,
): Promise<{ downloadedFiles: string[] }> {
  console.log(
    `[chatAI] askChatAIWithInlineContent(${jobId}): bắt đầu — mở trang ChatAI...`,
  );
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  try {
    await gotoChatAIWithRetry(page, config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new ChatAIError(
        "Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai",
      );
    }

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    // Theo yêu cầu người dùng: chọn Work/Chat + model theo config.chatAIMode
    // — xem docstring selectChatAIModeFromConfig.
    await selectChatAIModeFromConfig(page, jobId);

    const fileContent = attachmentPath
      ? await fs.promises.readFile(attachmentPath, "utf-8").catch(() => null)
      : null;

    const INLINE_RESULT_INSTRUCTION = `QUAN TRỌNG: Trả kết quả JSON TRỰC TIẾP trong tin nhắn trả lời, bọc trong khối code — KHÔNG tạo file đính kèm, KHÔNG dùng công cụ tạo file.

Kết quả PHẢI là 1 JSON ARRAY. Nếu toàn bộ kết quả quá dài để gửi trong 1 lượt, hãy CHIA THÀNH NHIỀU LƯỢT trả lời — mỗi lượt gửi 1 khối code chứa 1 JSON ARRAY là 1 PHẦN các item tiếp theo (không lặp lại item đã gửi, không bọc thêm object nào khác ngoài mảng). Ở CUỐI tin nhắn của lượt CUỐI CÙNG (khi đã gửi hết toàn bộ, không còn item nào nữa), viết rõ nguyên văn "${INLINE_CONTENT_DONE_MARKER}". TUYỆT ĐỐI KHÔNG viết "${INLINE_CONTENT_DONE_MARKER}" ở các lượt CHƯA gửi hết.`;

    const CONTINUE_MESSAGE = `Tiếp tục gửi phần tiếp theo của mảng JSON (khối code, chỉ chứa các item CHƯA gửi) — chỉ viết "${INLINE_CONTENT_DONE_MARKER}" khi đã gửi hết toàn bộ.`;

    let messageToSend = fileContent
      ? `${fileContent}\n\n${prompt}\n\n${INLINE_RESULT_INSTRUCTION}`
      : `${prompt}\n\n${INLINE_RESULT_INSTRUCTION}`;

    const messages = assistantMessageLocator(page);
    const allItems: unknown[] = [];
    let done = false;
    let lastMessageCount = 0;

    for (let turn = 1; turn <= MAX_TURNS_WAITING_FOR_FILE; turn++) {
      console.log(
        `[chatAI] askChatAIWithInlineContent(${jobId}): lượt ${turn}/${MAX_TURNS_WAITING_FOR_FILE} — gửi tin nhắn, đang chờ ChatAI trả lời...`,
      );
      await sendMessage(page, messageToSend, jobId);

      // Chờ tới khi có tin nhắn trả lời MỚI (đếm tăng so với lượt trước) —
      // cùng cơ chế poll đã dùng trong readLatestAssistantMessage (trang có
      // thể kẹt loading 1 lúc SAU KHI sendMessage đã xác nhận xong).
      const minMessageCount = lastMessageCount + 1;
      let count = await messages.count();
      const pollDeadline = Date.now() + 30_000;
      while (count < minMessageCount && Date.now() < pollDeadline) {
        await page.waitForTimeout(1000);
        count = await messages.count();
      }
      if (count === 0) {
        throw new ChatAIError(
          "Không tìm thấy câu trả lời nào từ ChatAI trên trang",
        );
      }
      lastMessageCount = count;

      const latest = messages.last();
      await captureSnapshot(
        page,
        `${jobId}_${promptFileName || ""}_turn-${turn}`,
        `result-turn-${turn}`,
      );

      const text = await latest.innerText().catch(() => "");
      const chunkJson = await readInlineCodeBlock(page, latest);
      let chunkItemCount = 0;
      if (chunkJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(chunkJson);
        } catch (err) {
          throw new ChatAIError(
            `ChatAI trả về khối code ở lượt ${turn} nhưng không parse được thành JSON hợp lệ: ${err instanceof Error ? err.message : err}`,
          );
        }
        if (!Array.isArray(parsed)) {
          throw new ChatAIError(
            `ChatAI trả về JSON ở lượt ${turn} nhưng KHÔNG PHẢI array (mỗi phần bắt buộc là 1 JSON array theo đúng hướng dẫn).`,
          );
        }
        chunkItemCount = parsed.length;
        allItems.push(...parsed);
      }

      const sawDoneMarker = text.includes(INLINE_CONTENT_DONE_MARKER);
      console.log(
        `[chatAI] askChatAIWithInlineContent(${jobId}): lượt ${turn} — nhận ${chunkItemCount} item mới (tổng ${allItems.length}), marker "Đã hoàn thành": ${sawDoneMarker ? "CÓ" : "chưa"}.`,
      );

      if (sawDoneMarker) {
        done = true;
        break;
      }

      // Chưa thấy marker HOÀN THÀNH (dù có khối code hay không) — nhắc lại
      // đúng yêu cầu để lấy phần tiếp theo.
      messageToSend = CONTINUE_MESSAGE;
    }

    if (!done) {
      throw new ChatAIError(
        `ChatAI chưa gửi text "${INLINE_CONTENT_DONE_MARKER}" sau ${MAX_TURNS_WAITING_FOR_FILE} lượt — kết quả có thể chưa đầy đủ.`,
      );
    }
    if (allItems.length === 0) {
      throw new ChatAIError(
        "ChatAI báo đã hoàn thành nhưng không có item JSON nào được thu thập.",
      );
    }

    await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
    const promptFileBaseName = promptFileName
      ? path.basename(promptFileName, path.extname(promptFileName))
      : jobId;
    const filePath = path.join(
      config.chatAIResultsDir,
      `${promptFileBaseName}.json`,
    );
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(allItems, null, 2),
      "utf-8",
    );
    console.log(
      `[chatAI] askChatAIWithInlineContent(${jobId}): xong — tổng ${allItems.length} item, đã lưu "${filePath}".`,
    );

    return { downloadedFiles: [filePath] };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof ChatAIError
      ? err
      : new ChatAIError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/**
 * Đường dẫn master prompt dùng cho verifyVideo — resolve từ project root
 * (KHÔNG dùng __dirname: build (tsc) không copy file .txt sang dist/, chỉ
 * .js, nên đọc theo path tương đối cwd giống config.ts/generatedDirFor, luôn
 * chạy từ project root).
 */
const VERIFY_VIDEO_PROMPT_TEMPLATE_PATH = path.resolve(
  "./src/automation/check_video.txt",
);

/**
 * Nhờ ChatAI (đóng vai VIDEO CHARACTER CONSISTENCY INSPECTOR — xem master
 * prompt check_video.txt) kiểm tra 1 video kết quả có đúng prompt/ảnh tham
 * chiếu đã dùng để tạo ra nó hay không — theo yêu cầu người dùng.
 *
 * KHÁC hẳn askChatAI/askChatAIWithInlineContent — không liên quan tạo
 * storyboard: upload THẲNG file video (+ video liền trước nếu có) + từng ảnh
 * tham chiếu (refs, ĐÚNG THỨ TỰ) làm đính kèm, dán prompt kiểm tra làm tin
 * nhắn (ghép từ template check_video.txt, thay 4 placeholder "[DÁN PROMPT ĐÃ
 * DÙNG ĐỂ TẠO VIDEO VÀO ĐÂY]", "[LIỆT KÊ TẤT CẢ ẢNH THAM CHIẾU VÀ ID]",
 * "[MÔ TẢ VIDEO NGAY TRƯỚC ĐÓ NẾU CÓ]" và "[MÔ TẢ VIDEO HIỆN TẠI CẦN ĐÁNH
 * GIÁ]"). Đọc JSON kết quả
 * qua readInlineCodeBlock (dùng lại đúng cơ chế của askChatAIWithInlineContent
 * — master prompt tự yêu cầu "Không dùng Markdown fence" nhưng ChatGPT vẫn
 * có thể tự render JSON qua widget canvas #code-block-viewer, hàm này đã tự
 * fallback đọc text thô nếu không thấy widget) rồi lưu ra file NGAY CẠNH
 * video, tên = <id video>.json (id lấy từ basename videoPath, bỏ đuôi).
 *
 * refs: id + đường dẫn file ẢNH tham chiếu ĐÃ RESOLVE sẵn — đúng THỨ TỰ cần
 * liệt kê/upload theo yêu cầu người dùng. Mô tả trong REFERENCE_ASSETS dùng
 * ĐÚNG quy ước tên file id đã dùng xuyên suốt dự án (ảnh: "<id>.png", video:
 * "<id>.mp4") thay vì tên file thật trên đĩa — theo yêu cầu người dùng.
 *
 * previousVideoPath (tuỳ chọn): video liền trước CÙNG SHOT (clip số N-1) nếu
 * có và đã tồn tại trên đĩa — dùng để ChatAI kiểm tra continuity giữa 2 clip
 * (xem PHẦN 2A/11 trong check_video.txt). Không truyền (hoặc rỗng) thì mô tả
 * "Không có." theo đúng quy ước NOT_APPLICABLE của template.
 *
 * Gửi ĐÚNG 1 LẦN (giống askChatAIWithInlineContent) — không lặp lượt chờ
 * hoàn thiện, không có audit.
 */
export interface VerifyVideoRef {
  id: string;
  path: string;
}

export async function verifyVideo(
  prompt: string,
  refs: VerifyVideoRef[],
  videoPath: string,
  previousVideoPath?: string,
): Promise<{ filePath: string }> {
  const id = path.basename(videoPath, path.extname(videoPath));
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  try {
    await gotoChatAIWithRetry(page, config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new ChatAIError(
        "Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai",
      );
    }

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    // Theo yêu cầu người dùng: chọn Work/Chat + model theo config.chatAIMode
    // — cùng helper dùng chung với askChatAI/askChatAIWithInlineContent, xem
    // docstring selectChatAIModeFromConfig.
    await selectChatAIModeFromConfig(page, id);

    // Upload video trước (liền trước, nếu có) → video hiện tại → rồi từng
    // ảnh tham chiếu ĐÚNG THỨ TỰ trong refs — theo yêu cầu người dùng.
    if (previousVideoPath) {
      await uploadAttachment(page, previousVideoPath);
    }
    await uploadAttachment(page, videoPath);
    for (const ref of refs) {
      await uploadAttachment(page, ref.path);
    }

    const template = await fs.promises.readFile(
      VERIFY_VIDEO_PROMPT_TEMPLATE_PATH,
      "utf-8",
    );
    const refsListing = refs.map((ref) => `- ${ref.id}: ${ref.id}.png`).join("\n");

    const currentVideoId = path.basename(videoPath, path.extname(videoPath));
    const generatedVideoBlock = [
      `- Tên file: ${currentVideoId}.mp4`,
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

    const message = template
      .replace("[DÁN PROMPT ĐÃ DÙNG ĐỂ TẠO VIDEO VÀO ĐÂY]", prompt)
      .replace("[LIỆT KÊ TẤT CẢ ẢNH THAM CHIẾU VÀ ID]", refsListing)
      .replace("[MÔ TẢ VIDEO NGAY TRƯỚC ĐÓ NẾU CÓ]", previousVideoBlock)
      .replace("[MÔ TẢ VIDEO HIỆN TẠI CẦN ĐÁNH GIÁ]", generatedVideoBlock);

    await sendMessage(page, message, currentVideoId);

    const messages = assistantMessageLocator(page);
    // Chờ tới khi có ÍT NHẤT 1 tin nhắn trả lời — cùng cơ chế poll đã dùng
    // trong askChatAIWithInlineContent/readLatestAssistantMessage (trang có
    // thể kẹt loading 1 lúc SAU KHI sendMessage đã xác nhận xong).
    let count = await messages.count();
    const pollDeadline = Date.now() + 30_000;
    while (count === 0 && Date.now() < pollDeadline) {
      await page.waitForTimeout(1000);
      count = await messages.count();
    }
    if (count === 0) {
      throw new ChatAIError(
        "Không tìm thấy câu trả lời nào từ ChatAI trên trang",
      );
    }

    const latest = messages.last();
    await captureSnapshot(page, `${id}_verify`, "result");

    const resultJson = await readInlineCodeBlock(page, latest);
    if (!resultJson) {
      throw new ChatAIError(
        `ChatAI không trả kết quả JSON nào cho video "${id}".`,
      );
    }

    const filePath = path.join(path.dirname(videoPath), `${id}.json`);
    await fs.promises.writeFile(filePath, resultJson, "utf-8");

    return { filePath };
  } catch (err) {
    await captureErrorSnapshot(page, id, err);
    throw err instanceof ChatAIError
      ? err
      : new ChatAIError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/** Bỏ dấu ngoặc kép/backtick bọc ngoài và khối ```code fence``` (nếu ChatAI lỡ trả lời kèm định dạng) khỏi prompt đã viết lại. */
function cleanRevisedPrompt(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/**
 * Nhờ ChatAI viết lại 1 prompt tạo ảnh/video đã bị AIVideo từ chối vì vi phạm
 * chính sách nội dung (vd "content violated Community Guidelines... sensitive
 * terms or copyrighted IP") — giữ nguyên ý tưởng/bối cảnh/hành động, chỉ loại
 * bỏ/thay thế tên riêng, thương hiệu, nhân vật có bản quyền hoặc từ ngữ nhạy
 * cảm. Dùng cho generateReferenceImagesForFileViaAIVideo/
 * generateSceneImagesForFileViaAIVideo/generateVideosForFile (storyboardPipeline.ts)
 * để tự động retry lại 1 lần với prompt mới thay vì báo lỗi luôn.
 *
 * Nhẹ hơn askChatAI (không cần vòng lặp chờ file đính kèm/audit — chỉ cần 1
 * câu trả lời text), tái dùng sendMessage() (đã tự chờ ChatAI trả lời xong
 * thật, kể cả retry khi ChatAI báo lỗi tạm thời).
 */
export async function reviseGenerationPrompt(
  prompt: string,
  violationReason: string,
  jobId: string,
): Promise<string> {
  const context = await getChatAIReviseBrowserContext();
  const page = await context.newPage();
  try {
    await gotoChatAIWithRetry(page, config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new ChatAIError(
        "Chưa đăng nhập session ChatAI (revise) hoặc session đã hết hạn. Chạy: npm run login-chatai -- revise",
      );
    }

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    await selectWorkMode(page, jobId);
    if (config.chatAIMaxEffort) {
      await selectMaxReasoningEffort(page);
    }

    const message = `Prompt sau đây bị công cụ tạo ảnh/video (Hailuo) từ chối vì vi phạm chính sách nội dung (nhạy cảm hoặc chứa IP có bản quyền như tên/hình ảnh nhân vật nổi tiếng):

Lý do bị từ chối: ${violationReason}

Prompt gốc:
${prompt}

Hãy viết lại ĐÚNG prompt này để mô tả lại y hệt ý tưởng, bối cảnh, hành động, bố cục — nhưng thay thế hoặc loại bỏ mọi tên riêng, thương hiệu, nhân vật có bản quyền hoặc từ ngữ nhạy cảm có thể khiến công cụ kiểm duyệt nội dung từ chối. Chỉ trả lời DUY NHẤT prompt mới, không thêm giải thích, không dùng dấu ngoặc kép hay markdown.`;

    await sendMessage(page, message, jobId);

    const latest = assistantMessageLocator(page).last();
    const text = await latest.innerText().catch(() => "");
    const revisedPrompt = cleanRevisedPrompt(text);
    console.log("🚀 ~ reviseGenerationPrompt ~ revisedPrompt:", revisedPrompt);
    if (!revisedPrompt) {
      throw new ChatAIError("ChatAI không trả về prompt viết lại nào");
    }

    // await captureSnapshot(page, jobId, "revise-prompt-result");
    return revisedPrompt;
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof ChatAIError
      ? err
      : new ChatAIError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
