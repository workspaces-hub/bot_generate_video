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

/** Chặn lặp vô hạn nếu vì lý do gì đó GPT không bao giờ đính kèm file. */
const MAX_TURNS_WAITING_FOR_FILE = 30;

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
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
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
      console.warn(
        "[chatgpt] Nội dung dán vào ô nhập không khớp prompt (nghi clipboard OS/X11 dán nhầm nội dung cũ) — ghi đè lại bằng fill().",
      );
      // timeout dài hơn mặc định (30s) — prompt có thể rất dài (JSON
      // storyboard nhiều nghìn ký tự), ProseMirror cần thời gian xử lý.
      await textarea.fill(text, { timeout: 120_000 });
    }
  } else {
    await textarea.fill(text, { timeout: 120_000 });
  }

  const sendButton = await firstVisible(sendButtonCandidates(page), 10_000);
  await sendButton.click();

  // Chờ nút "Stop generating" xuất hiện (GPT bắt đầu trả lời) — best-effort,
  // không throw nếu không thấy (có thể trả lời quá nhanh, đã xong trước khi
  // kịp bắt được trạng thái này).
  //
  // Xác nhận qua debug thật (job 1beafb45): nút Stop có thể xuất hiện MUỘN
  // hơn 10s chờ ban đầu (trang vẫn đang ở "chatgpt.com/" — CHƯA kịp điều
  // hướng sang URL hội thoại "/c/...", conversation-turn = 0, giữa màn hình
  // còn spinner "đang tải") — nếu vòng lặp bên dưới coi "chưa thấy nút Stop"
  // dù chỉ 1 lần là ĐÃ XONG, sẽ trả về NGAY LẬP TỨC trước khi GPT kịp bắt đầu
  // trả lời, khiến readLatestAssistantMessage tìm thấy 0 tin nhắn (throw
  // "Không tìm thấy câu trả lời nào"). hasSeenGenerating chỉ cho phép coi là
  // "đã xong" SAU KHI từng thấy nút Stop xuất hiện thật ít nhất 1 lần (bằng
  // chứng GPT đã bắt đầu trả lời) — trừ khi trang đã thật sự có tin nhắn trả
  // lời (hiếm khi GPT trả lời quá nhanh, không kịp thấy nút Stop).
  let hasSeenGenerating = await firstVisible(
    stopGeneratingButtonCandidates(page),
    10_000,
  )
    .then(() => true)
    .catch(() => false);

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
  while (Date.now() - start < config.generationTimeoutMs) {
    const retryButton = await firstVisible(
      regenerateErrorButtonCandidates(page),
      500,
    ).catch(() => null);
    if (retryButton) {
      if (retriesUsed >= maxRetriesOnError) {
        throw new ChatGptError(
          `GPT báo lỗi ("Something went wrong") — đã Retry ${retriesUsed} lần vẫn lỗi.`,
        );
      }
      await retryButton.click().catch(() => {});
      retriesUsed++;
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

    // const hasFileReady = await (async () => {
    //   const messages = assistantMessageLocator(page);
    //   if ((await messages.count()) === 0) return false;
    //   return (await fileAttachmentLocator(messages.last()).count()) > 0;
    // })();

    console.log("stillGenerating ", stillGenerating, "hasSeenGenerating", hasSeenGenerating);
    if (!stillGenerating) {
      if (hasSeenGenerating) return;
      // Chưa từng thấy nút Stop — chỉ coi là xong nếu trang đã thật sự có
      // tin nhắn trả lời (trường hợp hiếm: GPT trả lời quá nhanh). Không có
      // gì cả thì vẫn phải chờ tiếp, không được kết luận "xong" (xem job
      // 1beafb45 ở trên).
      const hasAssistantTurn = (await assistantMessageLocator(page).count()) > 0;
      if (hasAssistantTurn) return;
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
  promptFileName?: string,
): Promise<string[]> {
  const downloadLinks = downloadFileLinkLocator(message);
  const attachments =
    (await downloadLinks.count()) > 0
      ? downloadLinks
      : fileCardLocator(message);
  const count = await attachments.count();
  console.log("🚀 ~ downloadAttachedFiles ~ count:", count);
  const savedPaths: string[] = [];
  // Nếu user gửi prompt qua file .txt (vd "cay_khe.txt"), đặt tên file GPT
  // trả về giống tên file đó (giữ nguyên đuôi thật của file tải về, vd
  // .json) thay vì tên GPT tự đặt — dễ đối chiếu với file prompt gốc. Nhiều
  // file cùng lượt (hiếm) thì đánh số thêm "-2", "-3"... để không đè lên nhau.
  const promptFileBaseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : null;

  for (let i = 0; i < count; i++) {
    try {
      // QUAN TRỌNG: gắn .catch() NGAY khi tạo promise (cùng statement), TRƯỚC
      // khi click() — nếu không, click() throw (vd element bị re-render/stale
      // giữa các lượt "yes" của vòng lặp askChatGpt) sẽ nhảy thẳng ra catch
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
      if (!download) continue;

      await fs.promises.mkdir(config.chatGptResultsDir, { recursive: true });
      const suggested = download.suggestedFilename() || `attachment-${i}`;
      const fileName = promptFileBaseName
        ? `${promptFileBaseName}${savedPaths.length > 0 ? `-${savedPaths.length + 1}` : ""}${path.extname(suggested)}`
        : `${jobId}-${suggested}`;
      const filePath = path.join(config.chatGptResultsDir, fileName);
      await download.saveAs(filePath);
      savedPaths.push(filePath);
    } catch (err) {
      console.warn(`[chatgpt] Không tải được file đính kèm (index ${i}):`, err);
    }
  }

  return savedPaths;
}

/**
 * GPT báo đã hoàn thiện bản JSON storyboard — coi là dấu hiệu DUY NHẤT để
 * DỪNG gửi "yes" tiếp (KHÔNG dừng chỉ vì đã có file đính kèm — GPT có thể
 * đính kèm file trung gian/nháp trước khi thật sự hoàn thiện). Nhận diện qua
 * 1 trong các cách diễn đạt:
 * - "Đã hoàn thiện bản JSON"
 * - "production-ready" kèm "đầy đủ"
 * - Nhắc tới tên file "full.json" (tên file JSON cuối cùng) — innerText của
 *   tin nhắn có chứa cả nhãn nút "Download full.json" nếu đã đính kèm.
 */
function isCompletionText(text: string): boolean {
  if (/full\.json/i.test(text)) return true;
  if (/đã hoàn thành/i.test(text)) return true;
  if (/đã hoàn thiện bản json/i.test(text)) return true;
  return /production-ready/i.test(text) && /đầy đủ/i.test(text);
}

/** Lấy file đính kèm (nếu có) và nội dung text của tin nhắn trả lời MỚI NHẤT từ GPT. */
async function readLatestAssistantMessage(
  page: Page,
  jobId: string,
  promptFileName?: string,
): Promise<{ downloadedFiles: string[]; isComplete: boolean }> {
  const messages = assistantMessageLocator(page);
  // Xác nhận qua debug thật (job 98d9a048): dù sendMessage đã xác nhận GPT
  // trả lời xong thật (hasSeenGenerating true, nút Stop đã biến mất hẳn),
  // trang đôi khi vẫn kẹt ở màn hình loading (spinner giữa trang, canonical
  // URL chưa kịp đổi sang "/c/...") 1 lúc trước khi lịch sử hội thoại thật sự
  // render ra DOM — không phải do sendMessage kết luận sai, mà do trang tải
  // chậm SAU KHI đã xong. Poll thêm vài giây thay vì throw ngay ở lần check
  // đầu tiên.
  let count = await messages.count();
  const pollDeadline = Date.now() + 30_000;
  while (count === 0 && Date.now() < pollDeadline) {
    await page.waitForTimeout(1000);
    count = await messages.count();
  }
  if (count === 0) {
    throw new ChatGptError(
      "Không tìm thấy câu trả lời nào từ ChatGPT trên trang",
    );
  }
  const latest: Locator = messages.last();

  const downloadedFiles = await downloadAttachedFiles(page, latest, jobId, promptFileName);
  const text = await latest.innerText().catch(() => "");

  return { downloadedFiles, isComplete: isCompletionText(text) };
}

/**
 * Mở chatgpt.com, gửi prompt, chờ GPT trả lời xong, rồi thử tải file GPT
 * đính kèm (nếu có, xem downloadAttachedFiles) về config.chatGptResultsDir.
 *
 * Nếu trả lời xong mà phản hồi CHƯA báo đã hoàn thiện (xem isCompletionText
 * — "Đã hoàn thiện bản JSON", "production-ready" kèm "đầy đủ", hoặc nhắc tới
 * "full.json"), chụp lại ảnh màn hình trạng thái hiện tại RỒI gửi tiếp "yes"
 * để GPT tiếp tục, lặp lại tới khi isComplete = true thì dừng (giới hạn
 * MAX_TURNS_WAITING_FOR_FILE lượt để chặn lặp vô hạn nếu GPT không bao giờ
 * báo xong). CHỈ dừng theo isComplete — có file đính kèm KHÔNG tự động dừng
 * (có thể là file nháp/trung gian) — không có file sau khi hết lượt cũng
 * không coi là lỗi, chỉ trả về mảng rỗng.
 */
export async function askChatGpt(
  prompt: string,
  jobId: string,
  promptFileName?: string,
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

    let messageToSend = prompt;
    let downloadedFiles: string[] = [];
    for (let turn = 1; turn <= MAX_TURNS_WAITING_FOR_FILE; turn++) {
      await sendMessage(page, messageToSend);

      const result = await readLatestAssistantMessage(page, jobId, promptFileName);
      downloadedFiles = result.downloadedFiles;
      console.log(
        "result.isComplete, downloadedFiles.length",
        result.isComplete,
        downloadedFiles.length,
      );
      if (result.isComplete && downloadedFiles.length > 0) {
        await captureSnapshot(page, jobId, "result");
        break;
      }

      // Chưa hoàn thiện (isComplete = false) — file(s) vừa tải ở lượt này (nếu
      // có) chỉ là bản nháp/trung gian (xem docstring askChatGpt), KHÔNG phải
      // kết quả cuối — xoá luôn khỏi đĩa để tránh rác lại config.chatGptResultsDir
      // và tránh nhầm với file thật khi đọc lại sau này.
      for (const filePath of downloadedFiles) {
        await fs.promises.unlink(filePath).catch((err) => {
          console.warn(
            `[chatgpt] Không xoá được file nháp "${filePath}":`,
            err,
          );
        });
      }
      downloadedFiles = [];

      // Chưa có file — chụp lại trạng thái hiện tại TRƯỚC KHI gửi "yes" để
      // còn biết GPT đang dừng ở đâu (phần nào) nếu vòng lặp không bao giờ
      // ra được file. Đặt tên file debug riêng theo turn (captureSnapshot ghi
      // file theo đúng tham số jobId truyền vào) — nếu không, mỗi lượt sẽ ghi
      // đè lên đúng 1 file, mất hết ảnh các lượt trước.
      await captureSnapshot(
        page,
        `${jobId}-no-file-turn-${turn}`,
        `no-file-turn-${turn}`,
      );
      messageToSend =
        "yes. chỉ gửi file JSON kết quả khi đã ghép hết các phần và tên file chứa _full.json";
    }

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
