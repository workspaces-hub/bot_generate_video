import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho chatgpt.com — khác domain, khác session hoàn
 * toàn với hailuoai.video, nên KHÔNG dùng chung getBrowserContext() (sẽ lẫn
 * cookie 2 site vào nhau). Đăng nhập qua scripts/login-chatgpt.ts.
 *
 * Xác nhận qua debug thật (job afd3c6d8): từng thử tắt proxy cho GPT — IP
 * thẳng của VPS lập tức bị chatgpt.com chặn bằng Cloudflare "Verify you are
 * human" challenge, không vào được trang thật. Phải DÙNG LẠI proxy (đánh đổi
 * lấy việc qua được Cloudflare).
 */
export const getChatGptBrowserContext = createBrowserContextManager(
  config.chatGptStorageStatePath,
  "chatgpt-browser",
  'Chạy "npm run login-chatgpt" trước khi dùng tính năng GPT.',
);
