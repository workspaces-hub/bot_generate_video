import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc: ${name} (xem .env.example)`,
    );
  }
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  // Video kết quả (hoặc "404" khi lỗi) luôn đăng vào group cố định này.
  groupChatId: Number(required("GROUP_CHAT_ID")),
  groupChatIdTest: Number(required("GROUP_CHAT_ID_TEST")),

  // Domain thật của dịch vụ tạo video/ảnh AI (bên thứ 3) bot tự động hoá —
  // giá trị mặc định PHẢI giữ đúng domain thật này, chỉ đổi được qua env var
  // AIVIDEO_BASE_URL nếu cần.
  aiVideoBaseUrl: process.env.AIVIDEO_BASE_URL ?? "https://hailuoai.video",
  aiVideoCreateVideoPath:
    process.env.AIVIDEO_CREATE_VIDEO_PATH ?? "/create/image-to-video",
  aiVideoCreateImagePath:
    process.env.AIVIDEO_CREATE_IMAGE_PATH ?? "/create/image-generation",
  // Trang tạo video từ Image Reference / Character Reference — khác hẳn
  // trang tạo video thường (/create/video). Xác nhận thật: chip chuyển mode
  // "Start/End Frame" chỉ mở popover Image/Character Reference trên trang
  // NÀY — trên /create/video, chip đó không mở popover mode nào cả (đã thử
  // và xác nhận qua debug HTML: click không mở đúng popover, chỉ có popover
  // "model-selection-options" không liên quan tồn tại sẵn trong DOM).
  aiVideoCreateVideoRefPath:
    process.env.AIVIDEO_CREATE_VIDEO_REF_PATH ??
    "/create/subject-reference-to-video",

  storageStatePath: path.resolve(
    process.env.STORAGE_STATE_PATH ?? "./storage/session.json",
  ),
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR ?? "./storage/downloads"),
  // Ảnh tham chiếu tải từ Telegram (tính năng tạo ảnh) lưu tạm ở đây.
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? "./storage/uploads"),
  debugDir: path.resolve("./storage/debug"),

  // Tính năng "ChatAI": bot mở dịch vụ chat AI (bên thứ 3) thật, điền prompt,
  // chờ trả lời xong rồi lưu ra file. Dùng session RIÊNG (khác AIVideo) vì
  // khác domain — xem scripts/login-chatai.ts. Giá trị mặc định PHẢI giữ
  // đúng domain thật này, chỉ đổi được qua env var CHATAI_BASE_URL nếu cần.
  chatAIBaseUrl: process.env.CHATAI_BASE_URL ?? "https://chatgpt.com",
  chatAIStorageStatePath: path.resolve(
    process.env.CHATAI_STORAGE_STATE_PATH ?? "./storage/chatai-session.json",
  ),
  chatAIResultsDir: path.resolve(
    process.env.CHATAI_RESULTS_DIR ?? "./storage/chatai-results",
  ),

  headless: (process.env.HEADLESS ?? "false").toLowerCase() === "true",
  generationTimeoutMs: Number(process.env.GENERATION_TIMEOUT_MS ?? 10800_000),

  // Chrome thật (không phải Chromium bundled của Playwright) để Google OAuth
  // không chặn với lỗi "This browser or app may not be secure". Đặt thành
  // "chromium" để dùng Chromium bundled của Playwright (không cần cài Chrome
  // hệ thống) — phù hợp khi chạy trên VPS chỉ để tái sử dụng session đã
  // đăng nhập sẵn, không cần đăng nhập Google trực tiếp trên VPS.
  browserChannel: process.env.BROWSER_CHANNEL || "chrome",

  // Bật khi chạy trong container/VPS không hỗ trợ Chrome sandbox namespace.
  // Chỉ bật khi thực sự cần — giảm cô lập bảo mật của Chrome.
  chromeNoSandbox:
    (process.env.CHROME_NO_SANDBOX ?? "false").toLowerCase() === "true",

  // Danh sách Telegram user id được phép dùng bot, cách nhau bởi dấu phẩy.
  // Để trống = không ai dùng được (an toàn mặc định) — xem cảnh báo dưới đây.
  admins: (process.env.ADMINS ?? "")
    .split(",")
    .map((i) => i.trim())
    .filter(Boolean),
  adminsNotify: process.env.ADMINS_NOTIFY ?? "",

  // Proxy cho Playwright (áp dụng cả lúc `npm run login` và lúc bot chạy
  // generate) — nên dùng CÙNG 1 proxy cho cả 2 để tránh đăng nhập từ IP
  // này nhưng generate từ IP khác, dễ bị AIVideo/Google đánh dấu
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
