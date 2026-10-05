import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho Gemini web (gemini.google.com) — session tài khoản
 * Google riêng (config.geminiStorageStatePath), không lẫn cookie với ChatGPT.
 * disableGpu=false: cùng lý do với getChatAIBrowserContext (giữ fingerprint
 * WebGL/canvas như Chrome thật, tránh bị Google nghi là bot).
 */
/** Cấu hình lưu session định kỳ — dùng chung cho mọi tài khoản Gemini (xem persistSession trong browser.ts). */
const geminiPersistSession = {
  // Google xoay vòng cookie phiên khá thường xuyên — lưu lại mỗi 2 phút.
  intervalMs: 2 * 60_000,
  // Còn cookie phiên đăng nhập Google = còn đăng nhập.
  isValid: (names: Set<string>) => names.has("SID") || names.has("__Secure-1PSID"),
};

export const getGeminiBrowserContext = createBrowserContextManager(
  config.geminiStorageStatePath,
  "gemini-browser",
  'Chạy "npm run login-gemini" trước khi dùng Gemini.',
  config.geminiUseProxy,
  undefined,
  true,
  false,
  geminiPersistSession,
);

/**
 * BrowserContext RIÊNG cho tạo ảnh bằng Gemini (geminiImage.ts) — tài khoản
 * Google khác (config.geminiImageStorageStatePath), Chrome riêng, không lẫn
 * cookie/hạn mức với askGemini.
 */
export const getGeminiImageBrowserContext = createBrowserContextManager(
  config.geminiImageStorageStatePath,
  "gemini-image-browser",
  'Chạy "npm run login-gemini -- image" trước khi tạo ảnh bằng Gemini.',
  config.geminiUseProxy,
  undefined,
  true,
  false,
  geminiPersistSession,
);
