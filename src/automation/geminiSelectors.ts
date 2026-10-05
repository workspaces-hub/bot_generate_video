import type { Locator, Page } from "playwright";

/**
 * Selector cho Gemini web (gemini.google.com/app).
 *
 * LƯU Ý: CHƯA xác nhận qua debug DOM thật của dự án (khác chatAISelectors.ts,
 * mọi selector ở đó đều đã đối chiếu HTML debug thật). Viết theo cấu trúc
 * Angular custom element mà Gemini web đang dùng (rich-textarea, model-response,
 * message-content, code-block...) + aria-label cả tiếng Anh lẫn tiếng Việt.
 * Mỗi lượt geminiAI.ts đều chụp debug snapshot (storage/debug/<jobId>_gemini-*)
 * — selector nào hỏng thì sửa ở đây theo đúng HTML trong snapshot đó.
 */

/** Ô nhập prompt — Quill editor bên trong <rich-textarea>. */
export const geminiPromptInputCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('rich-textarea div.ql-editor[contenteditable="true"]'),
  () => page.locator('div.ql-editor[contenteditable="true"]'),
  () => page.getByRole("textbox", { name: /enter a prompt|nhập câu lệnh|ask gemini|hỏi gemini/i }),
  () => page.locator('[contenteditable="true"][role="textbox"]'),
];

// DOM thật (debug job 38917089-274d-4520-a029-eead0a383026): class
// "send-button" nằm ở <gem-icon-button> bọc ngoài, <button> thật bên trong có
// aria-label "Gửi tin nhắn".
export const geminiSendButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("gem-icon-button.send-button:not(.stop) button"),
  () => page.locator("button.send-button:not(.stop)"),
  () => page.getByRole("button", { name: /^(send message|gửi tin nhắn|gửi)$/i }),
];

/** Nút Stop hiện trong lúc Gemini đang trả lời (nút Send đổi thành Stop). */
export const geminiStopButtonLocator = (page: Page): Locator =>
  page
    .locator("gem-icon-button.send-button.stop button, button.send-button.stop")
    .or(page.getByRole("button", { name: /stop response|dừng phản hồi|dừng câu trả lời/i }));

/** Mỗi lượt trả lời của Gemini là 1 <model-response>. */
export const geminiResponseLocator = (page: Page): Locator =>
  page.locator("model-response");

/** Phần nội dung (markdown đã render) bên trong 1 model-response. */
export const geminiResponseContentLocator = (response: Locator): Locator =>
  response.locator("message-content").first();

/** Khối code trong 1 lượt trả lời (thẻ <code> bên trong <code-block> hoặc <pre>). */
export const geminiCodeBlockLocator = (response: Locator): Locator =>
  response
    .locator('code-block code, [data-test-id="code-content"]')
    .or(response.locator("pre code"));

/** Nút mở menu đính kèm (dấu "+" cạnh ô nhập). */
export const geminiUploadMenuButtonCandidates = (page: Page): Array<() => Locator> => [
  // DOM thật (job 38917089): nút "+" có aria-label "Nội dung tải lên và công cụ".
  () => page.getByRole("button", { name: /nội dung tải lên|upload.*tools/i }),
  () => page.locator('button[aria-label*="upload file menu" i]'),
  () => page.locator('button[aria-label*="tải tệp lên" i]'),
  () => page.locator("uploader button").first(),
  () => page.getByRole("button", { name: /add files|thêm tệp|upload|tải lên/i }),
];

/** Mục "Upload files"/"Tải tệp lên" trong menu đính kèm — bấm vào mở hộp chọn file. */
export const geminiUploadFilesMenuItemCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('[data-test-id="local-images-files-uploader-button"]'),
  () => page.getByRole("menuitem", { name: /upload files|tải tệp lên/i }),
  () => page.getByRole("button", { name: /upload files|tải tệp lên/i }),
];

/** Thẻ file đã đính kèm trong composer. */
export const geminiAttachmentPreviewLocator = (page: Page): Locator =>
  page.locator(
    'uploader-file-preview, file-preview, .file-preview-container, [data-test-id="uploaded-file"]',
  );

/** Thông báo nổi (snackbar) của Gemini — vd file bị từ chối/quá lớn. */
export const geminiSnackbarLocator = (page: Page): Locator =>
  page.locator(".mat-mdc-snack-bar-label, simple-snack-bar, mat-snack-bar-container");

/** Dấu hiệu file đính kèm còn đang upload/xử lý (spinner/progress trong thẻ file). */
export const geminiAttachmentLoadingLocator = (page: Page): Locator =>
  geminiAttachmentPreviewLocator(page).locator(
    'mat-progress-spinner, [role="progressbar"], .loading, .spinner',
  );

/** Dấu hiệu CHƯA đăng nhập (nút/link "Sign in" của Google). */
export const geminiSignInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('a[href*="accounts.google.com/ServiceLogin"]'),
  () => page.getByRole("link", { name: /^(sign in|đăng nhập)$/i }),
  () => page.getByRole("button", { name: /^(sign in|đăng nhập)$/i }),
];

/** Nút mở menu chọn model. */
export const geminiModelMenuButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('[data-test-id="bard-mode-menu-button"]'),
  () => page.locator("bard-mode-switcher button").first(),
];

/** Các lựa chọn trong menu model. */
export const geminiModelOptionLocator = (page: Page): Locator =>
  page.locator('[role="menuitem"], [role="menuitemradio"], button.mat-mdc-menu-item');
