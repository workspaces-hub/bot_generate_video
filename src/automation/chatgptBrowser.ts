import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho chatgpt.com — khác domain, khác session hoàn
 * toàn với hailuoai.video, nên KHÔNG dùng chung getBrowserContext() (sẽ lẫn
 * cookie 2 site vào nhau). Đăng nhập qua scripts/login-chatgpt.ts.
 */
export const getChatGptBrowserContext = createBrowserContextManager(
  config.chatGptStorageStatePath,
  "chatgpt-browser",
  'Chạy "npm run login-chatgpt" trước khi dùng tính năng GPT.',
);
