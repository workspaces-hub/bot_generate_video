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

/** Khối tin nhắn trả lời của GPT (mỗi lượt hỏi/đáp 1 khối riêng, lấy khối CUỐI). */
export const assistantMessageLocator = (page: Page): Locator =>
  page.locator('[data-message-author-role="assistant"]');

/**
 * File GPT tạo ra và đính kèm trong 1 tin nhắn trả lời (vd qua code
 * interpreter/canvas, hoặc export sẵn thành file để tải) — CHƯA có DOM thật
 * xác nhận (chưa gặp trường hợp thật trong debug snapshot). Dựa theo cấu
 * trúc công khai đã biết: file đính kèm thường là 1 thẻ <a> có attribute
 * download, hoặc trỏ thẳng tới endpoint tải file thật của ChatGPT
 * (/backend-api/estuary/content...), hoặc 1 phần tử mang data-testid chứa
 * "file". Cần chỉnh lại qua debug snapshot (storage/debug/<jobId>*.html) ở
 * lần chạy thử đầu nếu không khớp.
 */
export const fileAttachmentLocator = (message: Locator): Locator =>
  message.locator(
    [
      'a[href*="/backend-api/estuary/content"]',
      "a[download]",
      '[data-testid*="file" i]',
    ].join(", "),
  );

/** Nút "Download" hiện ra sau khi bấm vào 1 file đính kèm (trường hợp bấm vào chỉ mở preview thay vì tải thẳng). */
export const downloadButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^download$/i }),
  () => page.getByRole("link", { name: /^download$/i }),
];

/** Dấu hiệu CHƯA đăng nhập (trang chatgpt.com hiện màn hình đăng nhập). */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/^log in$/i),
  () => page.getByRole("button", { name: /^log in$/i }),
];
