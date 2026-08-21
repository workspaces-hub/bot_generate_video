import type { Locator, Page } from "playwright";

/**
 * ChatAI CHƯA có DOM thật xác nhận (tính năng mới, chưa chạy qua debug
 * snapshot thực tế) — các selector dưới đây dựa theo cấu trúc DOM công khai,
 * ổn định từ lâu của giao diện ChatAI (id/data-testid), nhưng vẫn có thể
 * cần chỉnh lại qua debug snapshot (storage/debug/<jobId>*.png/.html) ở lần
 * chạy thử đầu — cùng cách các selector khác trong project này đã được tinh
 * chỉnh dần từ phỏng đoán ban đầu.
 */

/** Ô nhập prompt — thực tế là 1 div contenteditable (ProseMirror), không phải <textarea>. */
export const promptTextareaCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("#prompt-textarea"),
  () => page.getByRole("textbox", { name: /message/i }),
  () => page.locator('[contenteditable="true"]'),
];

/**
 * CHƯA có DOM thật xác nhận (tính năng upload ảnh tham chiếu mới, chưa chạy
 * qua debug snapshot thực tế) — <input type="file"> phục vụ nút "+"/"Add
 * photos & files" trong composer thường bị ẨN (display:none/aria-hidden),
 * KHÔNG cần click mở menu trước — set thẳng file lên input này bằng
 * setInputFiles() (cách chuẩn của Playwright cho input file ẩn, bỏ qua bước
 * mở dialog OS). Có thể cần chỉnh lại qua debug snapshot ở lần chạy thử đầu
 * nếu ChatAI dùng cấu trúc khác (vd nhiều input file cho nhiều mục đích
 * khác nhau trên trang).
 */
export const fileUploadInputLocator = (page: Page): Locator =>
  page.locator('input[type="file"]').first();

/** Nút gửi prompt (icon mũi tên) cạnh ô nhập. */
export const sendButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('button[data-testid="send-button"]'),
  () => page.getByRole("button", { name: /send prompt/i }),
];

/** Nút dừng khi ChatAI đang trả lời (thay chỗ nút gửi) — biến mất khi trả lời xong. */
export const stopGeneratingButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('button[data-testid="stop-button"]'),
  () => page.getByRole("button", { name: /stop generating/i }),
];

/**
 * Khối tin nhắn trả lời của ChatAI (mỗi lượt hỏi/đáp 1 khối riêng, lấy khối
 * CUỐI). DOM thật xác nhận (job 24b9cf53): phản hồi dùng tool tạo ẢNH
 * (image generation) KHÔNG nằm trong [data-message-author-role="assistant"]
 * như tin nhắn text thường — toàn trang lúc đó chỉ có ĐÚNG 1 attribute
 * data-message-author-role (của USER), khiến scope theo attribute này khớp
 * 0 phần tử dù ảnh đã tạo xong thật. Cấu trúc CHUNG cho MỌI lượt trả lời của
 * ChatAI (cả text lẫn ảnh) là `<section data-testid="conversation-turn-N">`
 * chứa 1 descendant mang class "agent-turn" — dùng cấu trúc này thay vì
 * attribute data-message-author-role để không bỏ sót trường hợp ảnh.
 */
export const assistantMessageLocator = (page: Page): Locator =>
  page
    .locator('section[data-testid^="conversation-turn-"]')
    .filter({ has: page.locator(".agent-turn") });

/**
 * File ChatAI tạo ra và đính kèm trong 1 tin nhắn trả lời (vd qua code
 * interpreter/canvas) — DOM thật xác nhận ChatAI dùng NHIỀU kiểu UI khác
 * nhau cho việc này tuỳ phiên/thời điểm (site đổi UI khá thường xuyên):
 * 1. Link-text tiếng Anh NGAY TRONG đoạn trả lời, nhãn "Download <filename>":
 *    `<button aria-label="Download meta.json">Download meta.json</button>`
 *    (job 6d869584) — bấm vào kích hoạt download thật NGAY (xem
 *    downloadFileLinkLocator, ưu tiên dùng cái này để tải).
 * 2. Thẻ "card" file hiện dưới câu trả lời:
 *    `<button aria-label="meta.json" class="group/open-file ...">` — bấm
 *    vào MỞ PREVIEW (canvas), không chắc tải thẳng (xem fileCardLocator,
 *    dùng làm fallback khi không có nút "Download ..." nào).
 * 3. Link-text TIẾNG VIỆT, có emoji, NGAY TRONG đoạn văn (job 4c746641,
 *    KHÔNG khớp cả 2 pattern trên nên trước đây bị bỏ sót hoàn toàn — file
 *    JSON có thật, ChatAI báo đã tạo, nhưng bot không tải được gì cả):
 *    `<button aria-label="📄 Tải file pip_mouse_..._full.json" class="behavior-btn ... entity-underline ...">📄 Tải file ..._full.json</button>`
 *    — nhận diện qua aria-label KẾT THÚC bằng ".json" (xem inlineFileLinkLocator).
 * fileAttachmentLocator gộp cả 3 — dùng để CHECK "đã có file xuất hiện chưa"
 * (vd sendMessage coi đây là dấu hiệu ChatAI trả lời xong); còn lúc THỰC SỰ bấm
 * tải (downloadAttachedFiles trong chatAI.ts) phải ưu tiên
 * downloadFileLinkLocator/inlineFileLinkLocator trước, không bấm nhiều nút
 * cho CÙNG 1 file (tránh tải trùng/mở preview thừa).
 */
export const fileAttachmentLocator = (message: Locator): Locator =>
  message.locator(
    [
      'button[aria-label^="Download "]',
      'button[class*="group/open-file"]',
      'button[aria-label$=".json"]',
    ].join(", "),
  );

/**
 * Nút link-text "Download <filename>" — bấm vào kích hoạt download thật ngay,
 * ưu tiên dùng cái này. DOM thật xác nhận (job 9a775122): CÙNG 1 file có tới
 * 2 nút cùng khớp `[aria-label^="Download "]` — nút link-text thật
 * (`aria-label="Download <filename>"`) VÀ 1 icon hover chung chung
 * (`aria-label="Download file"`, không có tên file) nằm đè lên thẻ card —
 * bấm cả 2 tải TRÙNG LẶP cùng 1 file (đã xác nhận: 2 file tải về giống hệt
 * nhau byte-for-byte). Loại trừ tường minh nút generic "Download file" —
 * chỉ giữ nút có TÊN FILE thật trong aria-label.
 */
export const downloadFileLinkLocator = (message: Locator): Locator =>
  message.locator(
    'button[aria-label^="Download "]:not([aria-label="Download file"])',
  );

/**
 * Link-text TIẾNG VIỆT kèm emoji, nhãn "📄 Tải file <filename>", NGAY TRONG
 * đoạn văn trả lời — DOM thật xác nhận (job 4c746641):
 * `<button aria-label="📄 Tải file pip_mouse_..._full.json" class="behavior-btn ... entity-underline ...">`,
 * hoàn toàn KHÔNG khớp downloadFileLinkLocator (không bắt đầu bằng
 * "Download ") lẫn fileCardLocator (không có class "group/open-file") — nhận
 * diện qua aria-label kết thúc bằng ".json" (đủ đặc trưng, ChatAI luôn đặt
 * tên file JSON output theo đúng đuôi này). Bấm vào cũng kích hoạt download
 * thật (cùng cơ chế downloadFileLinkLocator), ưu tiên dùng trước
 * fileCardLocator.
 */
export const inlineFileLinkLocator = (message: Locator): Locator =>
  message.locator('button[aria-label$=".json"]');

/** Thẻ "card" file (mở preview/canvas, không chắc tải thẳng) — chỉ dùng fallback khi downloadFileLinkLocator/inlineFileLinkLocator rỗng. */
export const fileCardLocator = (message: Locator): Locator =>
  message.locator('button[class*="group/open-file"]');

/** Nút "Download" hiện ra sau khi bấm vào 1 file đính kèm (trường hợp bấm vào chỉ mở preview thay vì tải thẳng). */
export const downloadButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^download$/i }),
  () => page.getByRole("link", { name: /^download$/i }),
];

/**
 * Nút "Retry" hiện khi ChatAI báo lỗi generate (thực tế gặp: generate ẢNH lỗi
 * với message "Something went wrong. Please try again.") — DOM thật (job
 * d077805e): `<button data-testid="regenerate-thread-error-button">Retry</button>`.
 * Đây là lỗi THẬT phía ChatAI (không phải do bot chọn sai selector) — bấm
 * Retry thường tự sửa được vì nguyên nhân hay gặp là quá tải server nhất
 * thời.
 */
export const regenerateErrorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('[data-testid="regenerate-thread-error-button"]'),
  () => page.getByRole("button", { name: /^retry$/i }),
  () => page.getByRole("button", { name: /^thử lại$/i }),
];

/** Dấu hiệu CHƯA đăng nhập (trang ChatAI hiện màn hình đăng nhập). */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/^log in$/i),
  () => page.getByRole("button", { name: /^log in$/i }),
];

/**
 * Nút chọn mức "reasoning effort" hiện ở toolbar cạnh ô nhập (vd "Medium" —
 * thấy lặp lại trong nhiều ảnh debug thật). CHỈ LÀ NHÃN HIỂN THỊ (mức độ suy
 * luận), KHÔNG PHẢI tên model đầy đủ — muốn biết CHÍNH XÁC model nào thực sự
 * xử lý 1 câu trả lời, đọc attribute data-message-model-slug trên tin nhắn
 * trả lời thật (xem assistantTextMessageLocator) thay vì dựa vào nút này.
 * CHƯA có DOM thật xác nhận data-testid cụ thể của nút — chỉ đoán qua text
 * hiển thị, có thể cần chỉnh lại qua debug snapshot.
 */
export const modelSelectorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^(auto|fast|medium|thinking|extended thinking)$/i }),
];

/**
 * Tin nhắn trả lời TEXT thường (KHÔNG dùng cho phản hồi tạo ảnh — xem
 * assistantMessageLocator không có attribute này) — DOM thật xác nhận (job
 * b38b1151): `<div data-message-author-role="assistant" ...
 * data-message-model-slug="chatai-5-6-thinking">` — attribute
 * data-message-model-slug ghi đúng tên model THẬT đã xử lý câu trả lời đó,
 * đáng tin cậy hơn hẳn nhãn hiển thị trên nút chọn model (nhãn đó chỉ là mức
 * độ suy luận, không phải tên model).
 */
export const assistantTextMessageLocator = (page: Page): Locator =>
  page.locator('[data-message-author-role="assistant"]');
