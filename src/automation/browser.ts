import fs from "node:fs";
import type { BrowserContext } from "playwright";
import { config } from "../config";
import { launchRealChrome } from "./launch";

let contextPromise: Promise<BrowserContext> | null = null;

/**
 * Một BrowserContext dùng chung cho mọi job, được tái sử dụng để tránh
 * đăng nhập lại liên tục và giảm tải khi khởi động Chrome.
 * Mỗi job tự mở/đóng page riêng (xem hailuo.ts).
 */
export function getBrowserContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await launchRealChrome();
      const hasSession = fs.existsSync(config.storageStatePath);
      if (!hasSession) {
        console.warn(
          `[browser] Không tìm thấy session tại ${config.storageStatePath}. Chạy "npm run login" trước khi tạo video.`,
        );
      }
      const context = await browser.newContext({
        storageState: hasSession ? config.storageStatePath : undefined,
        viewport: { width: 1440, height: 900 },
      });

      // Nếu Chrome crash ("Target crashed") hoặc bị đóng vì bất kỳ lý do
      // gì, contextPromise đã cache PHẢI được xoá — nếu không, mọi job sau
      // đó sẽ luôn tái sử dụng browser đã chết và fail mãi mãi, cho tới khi
      // restart bot thủ công. Xoá cache để lần gọi tiếp theo tự khởi động
      // lại Chrome mới (tự phục hồi).
      browser.on("disconnected", () => {
        console.warn("[browser] Chrome đã ngắt kết nối/crash — sẽ khởi động lại ở job tiếp theo.");
        contextPromise = null;
      });

      return context;
    })();
  }
  return contextPromise;
}
