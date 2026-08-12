import fs from "node:fs";
import type { BrowserContext } from "playwright";
import { config } from "../config";
import { launchRealChrome } from "./launch";

/**
 * Tạo 1 "trình quản lý context" độc lập — mỗi lần gọi trả về hàm getContext()
 * riêng, cache 1 BrowserContext dùng chung cho mọi job của CÙNG site (tránh
 * đăng nhập lại liên tục, giảm tải khởi động Chrome), tự phục hồi khi Chrome
 * crash. Dùng để tạo NHIỀU trình quản lý độc lập cho các site khác nhau (vd
 * hailuoai.video và chatgpt.com) — mỗi site 1 session/storageState riêng,
 * không lẫn cookie vào nhau. Mỗi job tự mở/đóng page riêng trên context này.
 */
export function createBrowserContextManager(
  storageStatePath: string,
  logLabel: string,
  loginHint: string,
  useProxy = true,
): () => Promise<BrowserContext> {
  let contextPromise: Promise<BrowserContext> | null = null;

  return function getContext(): Promise<BrowserContext> {
    if (!contextPromise) {
      contextPromise = (async () => {
        const browser = await launchRealChrome(useProxy);
        const hasSession = fs.existsSync(storageStatePath);
        if (!hasSession) {
          console.warn(
            `[${logLabel}] Không tìm thấy session tại ${storageStatePath}. ${loginHint}`,
          );
        }
        const context = await browser.newContext({
          storageState: hasSession ? storageStatePath : undefined,
          viewport: { width: 1440, height: 900 },
        });

        // Nếu Chrome crash ("Target crashed") hoặc bị đóng vì bất kỳ lý do
        // gì, contextPromise đã cache PHẢI được xoá — nếu không, mọi job sau
        // đó sẽ luôn tái sử dụng browser đã chết và fail mãi mãi, cho tới khi
        // restart bot thủ công. Xoá cache để lần gọi tiếp theo tự khởi động
        // lại Chrome mới (tự phục hồi).
        browser.on("disconnected", () => {
          console.warn(`[${logLabel}] Chrome đã ngắt kết nối/crash — sẽ khởi động lại ở job tiếp theo.`);
          contextPromise = null;
        });

        return context;
      })();
    }
    return contextPromise;
  };
}

/**
 * Một BrowserContext dùng chung cho mọi job video/ảnh (hailuoai.video), được
 * tái sử dụng để tránh đăng nhập lại liên tục và giảm tải khi khởi động
 * Chrome. Mỗi job tự mở/đóng page riêng (xem hailuo.ts).
 */
export const getBrowserContext = createBrowserContextManager(
  config.storageStatePath,
  "browser",
  'Chạy "npm run login" trước khi tạo video.',
);
