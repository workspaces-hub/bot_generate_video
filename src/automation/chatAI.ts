import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "./chatAIBrowser";
import {
  assistantMessageLocator,
  downloadButtonCandidates,
  downloadFileLinkLocator,
  effortLabelLocator,
  effortSliderControlLocator,
  effortSliderThumbLocator,
  fileAttachmentLocator,
  fileCardLocator,
  fileUploadInputLocator,
  inlineFileLinkLocator,
  modelSelectorButtonCandidates,
  promptTextareaCandidates,
  regenerateErrorButtonCandidates,
  sendButtonCandidates,
  signInIndicatorCandidates,
  stopGeneratingButtonCandidates,
  workModeToggleLocator,
} from "./chatAISelectors";
import { firstVisible } from "./selectors";
// captureSnapshot/captureErrorSnapshot đã tổng quát (chỉ cần Page + jobId),
// dùng lại nguyên bản thay vì viết trùng cho ChatAI.
import { captureErrorSnapshot, captureSnapshot } from "./aiVideo";

export class ChatAIError extends Error {}

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
 * chỉ NỐI THÊM text mới vào cuối thay vì thay thế. Click lại thẳng vào
 * textarea NGAY TRƯỚC khi Ctrl+A để đảm bảo focus đúng chỗ trước khi xoá/gõ,
 * bất kể trạng thái focus trước đó.
 */
async function insertPromptText(
  page: Page,
  textarea: Locator,
  text: string,
): Promise<void> {
  await textarea.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
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
 * Đính kèm 1 file lên composer TRƯỚC khi gõ prompt — dùng khi user gửi prompt
 * qua file (.txt/.md) thay vì gõ/dán trực tiếp: UPLOAD file đó lên ChatAI rồi chỉ
 * gõ 1 câu ngắn yêu cầu ChatAI đọc file, thay vì dán nguyên nội dung file làm
 * prompt text (tránh dán prompt siêu dài, và để ChatAI tự đọc file y hệt cách
 * user thật đính kèm). Cùng cơ chế setInputFiles() đã dùng cho ảnh tham chiếu
 * (uploadReferenceImages trong chatAIImage.ts).
 */
async function uploadAttachment(page: Page, filePath: string): Promise<void> {
  await fileUploadInputLocator(page).setInputFiles(filePath);
  await waitForAttachmentUploadToSettle(page, path.basename(filePath));

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
async function sendMessage(page: Page, text: string): Promise<void> {
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

  const textarea = await firstVisible(promptTextareaCandidates(page), 20_000);
  await textarea.click();
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
  // await captureSnapshot(page, "before-click ask", "before-click ask");
  const sendButton = await firstVisible(sendButtonCandidates(page), 10_000);
  await sendButton.click();
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
  const pollIntervalMs = 5000;
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

    const stillGenerating = await firstVisible(
      stopGeneratingButtonCandidates(page),
      500,
    )
      .then(() => true)
      .catch(() => false);
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

    // const hasFileReady = await (async () => {
    //   const messages = assistantMessageLocator(page);
    //   if ((await messages.count()) === 0) return false;
    //   return (await fileAttachmentLocator(messages.last()).count()) > 0;
    // })();

    // console.log(
    //   "stillGenerating ",
    //   stillGenerating,
    //   "hasSeenGenerating",
    //   hasSeenGenerating,
    // );
    if (!stillGenerating) {
      if (hasSeenGenerating) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableRequiredMs) return;
      } else {
        // Chưa từng thấy nút Stop — chỉ coi là xong nếu trang đã thật sự có
        // tin nhắn trả lời (trường hợp hiếm: ChatAI trả lời quá nhanh). Không có
        // gì cả thì vẫn phải chờ tiếp, không được kết luận "xong" (xem job
        // 1beafb45 ở trên).
        const hasAssistantTurn =
          (await assistantMessageLocator(page).count()) > 0;
        if (hasAssistantTurn) return;
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
 */
async function downloadAttachedFiles(
  page: Page,
  message: Locator,
  jobId: string,
  promptFileName?: string,
): Promise<string[]> {
  const downloadLinks = downloadFileLinkLocator(message);
  const fileCards = fileCardLocator(message);
  const inlineLinks = inlineFileLinkLocator(message);
  let attachments = downloadLinks;
  if ((await attachments.count()) === 0) attachments = fileCards;
  if ((await attachments.count()) === 0) attachments = inlineLinks;
  const totalMatched = await attachments.count();

  // Dedupe theo aria-label (với cả 3 locator trên, aria-label luôn LÀ tên
  // file thật hoặc chứa tên file) — giữ lại index ĐẦU TIÊN cho mỗi tên file,
  // bỏ qua các lần khớp lặp lại sau đó của CÙNG 1 file.
  const seenLabels = new Set<string>();
  const indicesToProcess: number[] = [];
  for (let i = 0; i < totalMatched; i++) {
    const label =
      (await attachments.nth(i).getAttribute("aria-label").catch(() => null)) ??
      `__no-label-${i}`;
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    indicesToProcess.push(i);
  }

  const savedPaths: string[] = [];
  // Nếu user gửi prompt qua file .txt (vd "cay_khe.txt"), đặt tên file ChatAI
  // trả về giống tên file đó (giữ nguyên đuôi thật của file tải về, vd
  // .json) thay vì tên ChatAI tự đặt — dễ đối chiếu với file prompt gốc. Nhiều
  // file cùng lượt (hiếm) thì đánh số thêm "-2", "-3"... để không đè lên nhau.
  const promptFileBaseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : null;

  for (const i of indicesToProcess) {
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
        // panel xem trước dạng "Library" (data-testid="screen-threadFlyOut")
        // — nút "Download" trong panel này KHÔNG BAO GIỜ bắn sự kiện
        // "download" mà Playwright bắt được (nghi dùng File System Access
        // API/showSaveFilePicker — hộp thoại lưu file NATIVE của hệ điều
        // hành, không hoạt động trong môi trường tự động hoá). Chờ panel
        // xuất hiện lâu hơn (tới 20s — panel có thể chậm render sau khi vừa
        // bấm) rồi lấy nội dung.
        const panelContent = page.locator(
          '[data-testid="screen-threadFlyOut"] .cm-content',
        );
        const panelAppeared = await panelContent
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);

        let previewText: string | null = null;
        if (panelAppeared) {
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
        }

        if (!previewText) {
          // Xác nhận qua thực tế (job 38b68c7a): downloadFileLinkLocator
          // không còn khớp nút nào trên bản UI mới của ChatAI (đã đổi hết
          // sang aria-label "Download file"/"Download" chung chung, không
          // còn "Download <tên file>"), buộc fallback sang panel xem trước —
          // nếu clipboard/innerText ở panel này ĐỀU thất bại, trước đây
          // code lặng lẽ bỏ qua (continue) không log gì, khiến không thể
          // biết bước tải file đã fail ở đây khi xem log thật.
          console.warn(
            `[chatAI] Không đọc được nội dung preview file đính kèm (index ${i}) — panel${
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
            : `${jobId}-${suggestedName}`;
          const filePath = path.join(config.chatAIResultsDir, fileName);
          await fs.promises.writeFile(filePath, previewText, "utf-8");
          savedPaths.push(filePath);
          // Đóng panel xem trước lại cho gọn trước khi xử lý file tiếp theo
          // (nếu có) — best-effort, không throw nếu không tìm thấy nút Close.
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

      await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
      const suggested = download.suggestedFilename() || `attachment-${i}`;
      const fileName = promptFileBaseName
        ? `${promptFileBaseName}${savedPaths.length > 0 ? `-${savedPaths.length + 1}` : ""}${path.extname(suggested)}`
        : `${jobId}-${suggested}`;
      const filePath = path.join(config.chatAIResultsDir, fileName);
      await download.saveAs(filePath);
      savedPaths.push(filePath);
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
  jobId: string,
  promptFileName?: string,
  minMessageCount = 1,
): Promise<{
  downloadedFiles: string[];
  isComplete: boolean;
  missingScript: boolean;
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
    jobId,
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
export async function selectWorkMode(page: Page): Promise<void> {
  try {
    const workToggle = workModeToggleLocator(page).first();
    const alreadyOn =
      (await workToggle.getAttribute("aria-checked").catch(() => null)) ===
      "true";
    if (alreadyOn) return;
    await workToggle.click({ timeout: 10000 });
  } catch (err) {
    console.warn(
      "[chatAI] Không chọn được mode 'Work' (best-effort, bỏ qua):",
      err instanceof Error ? err.message : err,
    );
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

    const button = await firstVisible(modelSelectorButtonCandidates(page), 5000);
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
      const valueNow = await thumb.getAttribute("aria-valuenow").catch(() => null);
      const valueMax = await thumb.getAttribute("aria-valuemax").catch(() => null);
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
): Promise<{ downloadedFiles: string[] }> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(config.chatAIBaseUrl, {
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

    await selectWorkMode(page);
    if (config.chatAIMaxEffort) {
      await selectMaxReasoningEffort(page);
    }
    if (attachmentPath) {
      await uploadAttachment(page, attachmentPath);
    }

    // Xác nhận qua thực tế (job 38b68c7a): ChatAI có thể tự tin báo "Đã hoàn
    // thành"/đính kèm đúng file "_full.json" NGAY CẢ KHI storyboard mới bao
    // phủ một phần nhỏ kịch bản (vd 3/~14 sự kiện chính) — isComplete chỉ
    // phát hiện đúng trường hợp ChatAI TỰ NHẬN chưa xong, không phát hiện
    // được trường hợp ChatAI nhận NHẦM là đã xong. Vì vậy, lần đầu tiên
    // isComplete = true, KHÔNG dừng ngay — bắt buộc thêm 1 lượt audit yêu
    // cầu ChatAI tự đối chiếu lại toàn bộ file với kịch bản gốc trước khi
    // thực sự chấp nhận là xong.
    const AUDIT_MESSAGE =
      "Trước khi coi là xong: hãy tự đối chiếu lại TOÀN BỘ file JSON storyboard vừa tạo với đúng kịch bản trong file nguồn đã gửi — liệt kê nội bộ từng sự kiện/hành động chính trong kịch bản theo đúng thứ tự và xác nhận MỖI sự kiện đó đã có ít nhất một continuity run/clip tương ứng trong file chưa. Nếu phát hiện BẤT KỲ đoạn nào của kịch bản (kể cả đoạn ở giữa hoặc cuối truyện) CHƯA được chuyển thành clip, hãy tiếp tục bổ sung ngay các continuity run còn thiếu và gửi lại TOÀN BỘ file JSON đầy đủ (không chỉ phần thêm), vẫn đặt tên chứa _full.json. Nếu đã xác nhận bao phủ đầy đủ toàn bộ kịch bản từ đầu đến cuối, trả lời ngắn gọn xác nhận lại, không cần gửi lại file.";
    const CONTINUE_MESSAGE =
      "yes. chỉ gửi file JSON kết quả khi đã ghép hết các phần và tên file chứa _full.json";

    let messageToSend = prompt;
    let downloadedFiles: string[] = [];
    let auditRequested = false;
    let lastMessageCount = 0;
    for (let turn = 1; turn <= MAX_TURNS_WAITING_FOR_FILE; turn++) {
      await sendMessage(page, messageToSend);

      const result = await readLatestAssistantMessage(
        page,
        jobId,
        promptFileName,
        lastMessageCount + 1,
      );
      lastMessageCount = result.messageCount;
      await captureSnapshot(page, jobId, "result");

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
        await captureSnapshot(
          page,
          `${jobId}-missing-script-turn-${turn}`,
          `missing-script-turn-${turn}`,
        );
        const scriptText = attachmentPath
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

      // Xác nhận qua log lỗi thật (ChatAI tự báo: "do giới hạn xử lý trong
      // lượt này tôi mới serialize phần đầu storyboard. Cần tiếp tục mở rộng
      // các continuity run còn lại"): gate isComplete này TRƯỚC ĐÂY bị comment
      // out kèm break vô điều kiện ngay lượt đầu tiên — khiến vòng lặp gửi
      // tiếp "yes"/continue bên dưới (vốn đã viết đúng) KHÔNG BAO GIỜ chạy,
      // nhận storyboard DỞ DANG làm kết quả cuối bất cứ khi nào ChatAI cần
      // hơn 1 lượt mới xong (thường xảy ra với kịch bản dài) — đây chính là
      // nguyên nhân thật của toàn bộ chênh lệch "output ngắn hơn" đã thấy
      // trước giờ, không phải do model/locale/prompt. Bật lại gate này.
      downloadedFiles = result.downloadedFiles;
      break;
      if (result.isComplete) {
        // Ưu tiên file MỚI của lượt này (nếu có) làm kết quả hiện tại; nếu
        // lượt này không đính kèm gì (vd chỉ xác nhận lại bằng lời sau lượt
        // audit, không gửi lại file không đổi), GIỮ NGUYÊN file tốt nhất đã
        // có từ lượt trước — không xoá oan.
        if (result.downloadedFiles.length > 0) {
          for (const oldPath of downloadedFiles) {
            await fs.promises.unlink(oldPath).catch(() => {});
          }
          downloadedFiles = result.downloadedFiles;
        }

        if (!auditRequested) {
          auditRequested = true;
          await captureSnapshot(page, `${jobId}-before-audit`, "before-audit");
          messageToSend = AUDIT_MESSAGE;
          continue;
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
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(config.chatAIBaseUrl, {
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

    await selectWorkMode(page);
    if (config.chatAIMaxEffort) {
      await selectMaxReasoningEffort(page);
    }

    const message = `Prompt sau đây bị công cụ tạo ảnh/video (Hailuo) từ chối vì vi phạm chính sách nội dung (nhạy cảm hoặc chứa IP có bản quyền như tên/hình ảnh nhân vật nổi tiếng):

Lý do bị từ chối: ${violationReason}

Prompt gốc:
${prompt}

Hãy viết lại ĐÚNG prompt này để mô tả lại y hệt ý tưởng, bối cảnh, hành động, bố cục — nhưng thay thế hoặc loại bỏ mọi tên riêng, thương hiệu, nhân vật có bản quyền hoặc từ ngữ nhạy cảm có thể khiến công cụ kiểm duyệt nội dung từ chối. Chỉ trả lời DUY NHẤT prompt mới, không thêm giải thích, không dùng dấu ngoặc kép hay markdown.`;

    await sendMessage(page, message);

    const latest = assistantMessageLocator(page).last();
    const text = await latest.innerText().catch(() => "");
    const revisedPrompt = cleanRevisedPrompt(text);
    console.log("🚀 ~ reviseGenerationPrompt ~ revisedPrompt:", revisedPrompt)
    if (!revisedPrompt) {
      throw new ChatAIError("ChatAI không trả về prompt viết lại nào");
    }

    await captureSnapshot(page, jobId, "revise-prompt-result");
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
