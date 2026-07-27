import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name} (xem .env.example)`);
  }
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  // Video kết quả (hoặc "404" khi lỗi) luôn đăng vào group cố định này.
  groupChatId: Number(required("GROUP_CHAT_ID")),

  hailuoBaseUrl: process.env.HAILUO_BASE_URL ?? "https://hailuoai.video",
  hailuoCreatePath: process.env.HAILUO_CREATE_PATH ?? "/create/video",

  storageStatePath: path.resolve(process.env.STORAGE_STATE_PATH ?? "./storage/session.json"),
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR ?? "./storage/downloads"),
  debugDir: path.resolve("./storage/debug"),

  headless: (process.env.HEADLESS ?? "false").toLowerCase() === "true",
  generationTimeoutMs: Number(process.env.GENERATION_TIMEOUT_MS ?? 600_000),

  // Chrome thật (không phải Chromium bundled của Playwright) để Google OAuth
  // không chặn với lỗi "This browser or app may not be secure". Đặt thành
  // "chromium" để dùng Chromium bundled của Playwright (không cần cài Chrome
  // hệ thống) — phù hợp khi chạy trên VPS chỉ để tái sử dụng session đã
  // đăng nhập sẵn, không cần đăng nhập Google trực tiếp trên VPS.
  browserChannel: process.env.BROWSER_CHANNEL || "chrome",

  // Bật khi chạy trong container/VPS không hỗ trợ Chrome sandbox namespace.
  // Chỉ bật khi thực sự cần — giảm cô lập bảo mật của Chrome.
  chromeNoSandbox: (process.env.CHROME_NO_SANDBOX ?? "false").toLowerCase() === "true",

  // Danh sách Telegram user id được phép dùng bot, cách nhau bởi dấu phẩy.
  // Để trống = không ai dùng được (an toàn mặc định) — xem cảnh báo dưới đây.
  admins: (process.env.ADMINS ?? ""),

  // Proxy cho Playwright (áp dụng cả lúc `npm run login` và lúc bot chạy
  // generate) — nên dùng CÙNG 1 proxy cho cả 2 để tránh đăng nhập từ IP
  // này nhưng generate từ IP khác, dễ bị hailuoai.video/Google đánh dấu
  // đáng ngờ. Để trống PROXY_SERVER nếu không dùng proxy.
  proxyServer: process.env.PROXY_SERVER || undefined,
  proxyUsername: process.env.PROXY_USERNAME || undefined,
  proxyPassword: process.env.PROXY_PASSWORD || undefined,
};

// if (config.admins.length === 0) {
//   console.warn(
//     "[config] ADMINS trống — không ai có quyền dùng bot. Thêm Telegram user id vào ADMINS trong .env (cách nhau bởi dấu phẩy).",
//   );
// }
