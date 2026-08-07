import type { Locator, Page } from "playwright";

/**
 * chatgpt.com CHƯA có DOM thật xác nhận (tính năng mới, chưa chạy qua debug
 * snapshot thực tế) — các selector dưới đây dựa theo cấu trúc DOM công khai,
 * ổn định từ lâu của giao diện ChatGPT (id/data-testid), nhưng vẫn có thể
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

/** Nút gửi prompt (icon mũi tên) cạnh ô nhập. */
export const sendButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('button[data-testid="send-button"]'),
  () => page.getByRole("button", { name: /send prompt/i }),
];

/** Nút dừng khi GPT đang trả lời (thay chỗ nút gửi) — biến mất khi trả lời xong. */
export const stopGeneratingButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('button[data-testid="stop-button"]'),
  () => page.getByRole("button", { name: /stop generating/i }),
];

/**
 * Khối tin nhắn trả lời của GPT (mỗi lượt hỏi/đáp 1 khối riêng, lấy khối
 * CUỐI). DOM thật xác nhận (job 24b9cf53): phản hồi dùng tool tạo ẢNH
 * (image generation) KHÔNG nằm trong [data-message-author-role="assistant"]
 * như tin nhắn text thường — toàn trang lúc đó chỉ có ĐÚNG 1 attribute
 * data-message-author-role (của USER), khiến scope theo attribute này khớp
 * 0 phần tử dù ảnh đã tạo xong thật. Cấu trúc CHUNG cho MỌI lượt trả lời của
 * GPT (cả text lẫn ảnh) là `<section data-testid="conversation-turn-N">`
 * chứa 1 descendant mang class "agent-turn" — dùng cấu trúc này thay vì
 * attribute data-message-author-role để không bỏ sót trường hợp ảnh.
 */
export const assistantMessageLocator = (page: Page): Locator =>
  page
    .locator('section[data-testid^="conversation-turn-"]')
    .filter({ has: page.locator(".agent-turn") });

/**
 * File GPT tạo ra và đính kèm trong 1 tin nhắn trả lời (vd qua code
 * interpreter/canvas) — DOM thật xác nhận (job 6d869584): ChatGPT KHÔNG dùng
 * thẻ <a> cho việc này (khác phỏng đoán ban đầu), mà dùng 2 loại <button>:
 * 1. Link-text NGAY TRONG đoạn trả lời, nhãn "Download <filename>":
 *    `<button aria-label="Download meta.json">Download meta.json</button>`
 *    — bấm vào kích hoạt download thật NGAY (xem downloadFileLinkLocator,
 *    ưu tiên dùng cái này để tải).
 * 2. Thẻ "card" file hiện dưới câu trả lời:
 *    `<button aria-label="meta.json" class="group/open-file ...">` — bấm
 *    vào MỞ PREVIEW (canvas), không chắc tải thẳng (xem fileCardLocator,
 *    chỉ dùng làm fallback khi không có nút "Download ..." nào).
 * fileAttachmentLocator gộp cả 2 — dùng để CHECK "đã có file xuất hiện chưa"
 * (vd sendMessage coi đây là dấu hiệu GPT trả lời xong); còn lúc THỰC SỰ bấm
 * tải (downloadAttachedFiles trong chatgpt.ts) phải ưu tiên
 * downloadFileLinkLocator trước, không bấm cả 2 cho cùng 1 file (tránh tải
 * trùng/mở preview thừa).
 */
export const fileAttachmentLocator = (message: Locator): Locator =>
  message.locator(
    [
      'button[aria-label^="Download "]',
      'button[class*="group/open-file"]',
    ].join(", "),
  );

/** Nút link-text "Download <filename>" — bấm vào kích hoạt download thật ngay, ưu tiên dùng cái này. */
export const downloadFileLinkLocator = (message: Locator): Locator =>
  message.locator('button[aria-label^="Download "]');

/** Thẻ "card" file (mở preview/canvas, không chắc tải thẳng) — chỉ dùng fallback khi downloadFileLinkLocator rỗng. */
export const fileCardLocator = (message: Locator): Locator =>
  message.locator('button[class*="group/open-file"]');

/** Nút "Download" hiện ra sau khi bấm vào 1 file đính kèm (trường hợp bấm vào chỉ mở preview thay vì tải thẳng). */
export const downloadButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^download$/i }),
  () => page.getByRole("link", { name: /^download$/i }),
];

/**
 * Nút "Retry" hiện khi GPT báo lỗi generate (thực tế gặp: generate ẢNH lỗi
 * với message "Something went wrong. Please try again.") — DOM thật (job
 * d077805e): `<button data-testid="regenerate-thread-error-button">Retry</button>`.
 * Đây là lỗi THẬT phía ChatGPT (không phải do bot chọn sai selector) — bấm
 * Retry thường tự sửa được vì nguyên nhân hay gặp là quá tải server nhất
 * thời.
 */
export const regenerateErrorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('[data-testid="regenerate-thread-error-button"]'),
  () => page.getByRole("button", { name: /^retry$/i }),
];

/** Dấu hiệu CHƯA đăng nhập (trang chatgpt.com hiện màn hình đăng nhập). */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/^log in$/i),
  () => page.getByRole("button", { name: /^log in$/i }),
];
