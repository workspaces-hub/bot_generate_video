import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho Gemini web (gemini.google.com) — session tài khoản
 * Google riêng (config.geminiStorageStatePath), không lẫn cookie với ChatGPT.
 * disableGpu=false: cùng lý do với getChatAIBrowserContext (giữ fingerprint
 * WebGL/canvas như Chrome thật, tránh bị Google nghi là bot).
 */
export const getGeminiBrowserContext = createBrowserContextManager(
  config.geminiStorageStatePath,
  "gemini-browser",
  'Chạy "npm run login-gemini" trước khi dùng Gemini.',
  config.geminiUseProxy,
  undefined,
  true,
  false,
);
