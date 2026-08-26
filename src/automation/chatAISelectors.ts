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
 * Toggle "Trò chuyện" (Chat) / "Công việc" (Work) — DOM thật xác nhận: 1 cặp
 * `<button role="radio" data-tpp-toggle-value="chatgpt|work">` (radio group,
 * `aria-checked="true"` trên nút đang chọn). Nhận diện qua attribute
 * `data-tpp-toggle-value="work"` (ổn định, không phụ thuộc ngôn ngữ hiển thị
 * — tiếng Việt là "Công việc", tiếng Anh là "Work").
 */
export const workModeToggleLocator = (page: Page): Locator =>
  page.locator('button[role="radio"][data-tpp-toggle-value="work"]');

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
 * "Download "). Nhận diện qua aria-label kết thúc bằng ".json" (đủ đặc
 * trưng, ChatAI luôn đặt tên file JSON output theo đúng đuôi này) — NHƯNG
 * PHẢI loại trừ tường minh class "group/open-file" (thẻ card, xem
 * fileCardLocator): DOM thật xác nhận (job 67b2f3fc) CÙNG 1 file có thể có
 * CẢ HAI nút — 1 link-text trích dẫn (class "behavior-btn"/"entity-underline")
 * VÀ 1 thẻ card (class "group/open-file") — CẢ HAI đều có aria-label giống
 * hệt tên file, nếu không loại trừ sẽ khớp nhầm cả thẻ card vào đây. Cũng
 * xác nhận qua thực tế (job 67b2f3fc, pip_boulangerie): bấm nút link-text
 * trích dẫn KHÔNG có emoji "📄" (chỉ có tên file trần) KHÔNG mở ra được panel
 * xem trước lẫn kích hoạt download — có vẻ chỉ là citation/tham chiếu, khác
 * hẳn biến thể CÓ emoji "📄 Tải file" (job 4c746641, xác nhận tải được thật).
 * Vì độ tin cậy không chắc chắn, dùng làm phương án CUỐI CÙNG, sau
 * fileCardLocator (xem thứ tự ưu tiên trong downloadAttachedFiles).
 */
export const inlineFileLinkLocator = (message: Locator): Locator =>
  message.locator(
    'button[aria-label$=".json"]:not([class*="group/open-file"])',
  );

/**
 * Thẻ "card" file (mở preview/canvas dạng "screen-threadFlyOut", xem
 * downloadAttachedFiles) — DOM thật xác nhận đây là dạng ĐÁNG TIN CẬY NHẤT
 * để mở được panel xem trước khi không có nút "Download <filename>" trực
 * tiếp (job 38b68c7a, 67b2f3fc) — ưu tiên dùng TRƯỚC inlineFileLinkLocator.
 */
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
 * Nút chọn mức "reasoning effort" hiện ở toolbar cạnh ô nhập. CHỈ LÀ NHÃN
 * HIỂN THỊ (mức độ suy luận), KHÔNG PHẢI tên model đầy đủ — muốn biết CHÍNH
 * XÁC model nào thực sự xử lý 1 câu trả lời, đọc attribute
 * data-message-model-slug trên tin nhắn trả lời thật (xem
 * assistantTextMessageLocator) thay vì dựa vào nút này.
 *
 * DOM thật xác nhận (storage/debug/chatai-effort-menu.html): nhãn KHÔNG cố
 * định theo 1 tập từ tiếng Anh cố định — tài khoản test thấy cả "Light"
 * (English) LẪN "Vừa" (tiếng Việt, = Medium) tuỳ thời điểm, nên regex đoán
 * text cũ (auto|fast|medium|thinking|extended thinking) SAI hoàn toàn, không
 * bao giờ khớp được nút thật:
 * `<button aria-haspopup="menu" aria-expanded="false" ...>
 *   <span class="uFxlGa_SliderTriggerModelLabel">5.6 Sol</span>
 *   <span class="uFxlGa_SliderTriggerEffortLabel" data-max-effort="false">Light</span>
 * </button>`
 * Attribute "data-max-effort" trên span nhãn mức là điểm neo ĐÁNG TIN CẬY
 * DUY NHẤT (không phụ thuộc ngôn ngữ hiển thị) — "true" nghĩa là ĐÃ ở mức tối
 * đa, dùng để biết có cần bấm chọn tiếp hay không. Giữ regex text cũ làm
 * fallback phòng site đổi lại cấu trúc.
 */
export const modelSelectorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("button:has(span[data-max-effort])"),
  () => page.getByRole("button", { name: /^(auto|fast|medium|thinking|extended thinking)$/i }),
];

/** Span nhãn mức hỗ trợ hiện tại — đọc attribute "data-max-effort" để biết đã ở mức tối đa chưa. */
export const effortLabelLocator = (page: Page): Locator =>
  page.locator("span[data-max-effort]");

/**
 * Popup mở ra sau khi bấm modelSelectorButtonCandidates KHÔNG phải menu với
 * các item bấm chọn — là 1 THANH TRƯỢT (Radix Slider) 5 nấc (aria-valuemin=0,
 * aria-valuemax=4). DOM thật xác nhận (storage/debug/chatai-effort-menu.html,
 * lúc đang ở nấc 2/5 "Light"):
 * `<div role="menuitem" tabindex="0" class="... d1BZWq_SliderControl"
 *   aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Power" ...>
 *   ...<span role="slider" aria-valuemin="0" aria-valuemax="4" tabindex="-1"
 *     aria-hidden="true" aria-valuenow="1" ...></span>
 * </div>`
 * — phần tử THẬT SỰ nhận focus/phím là div[role="menuitem"][aria-label="Power"]
 * (tabindex="0", có aria-keyshortcuts) — span role="slider" bên trong chỉ là
 * proxy hiển thị (tabindex="-1", aria-hidden="true"), KHÔNG focus/press phím
 * trực tiếp lên đó được. Bấm phím "ArrowRight" lặp lại trên
 * effortSliderControlLocator tới khi effortSliderThumbLocator có
 * aria-valuenow === aria-valuemax (đã ở nấc cao nhất).
 */
export const effortSliderControlLocator = (page: Page): Locator =>
  page.locator('[role="menuitem"][aria-label="Power"]');

/** Proxy hiển thị giá trị hiện tại của thanh trượt mức hỗ trợ — chỉ đọc attribute, không thao tác trực tiếp lên đây. */
export const effortSliderThumbLocator = (page: Page): Locator =>
  page.locator('span[role="slider"]');

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
