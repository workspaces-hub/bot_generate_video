import fs from "node:fs";
import type { BrowserContext } from "playwright";
import { config } from "../config";
import { launchRealChrome } from "./launch";

/**
 * Tạo 1 "trình quản lý context" độc lập — mỗi lần gọi trả về hàm getContext()
 * riêng, cache 1 BrowserContext dùng chung cho mọi job của CÙNG site (tránh
 * đăng nhập lại liên tục, giảm tải khởi động Chrome), tự phục hồi khi Chrome
 * crash. Dùng để tạo NHIỀU trình quản lý độc lập cho các site khác nhau (vd
 * AIVideo và ChatAI) — mỗi site 1 session/storageState riêng,
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
 * Một BrowserContext dùng chung cho mọi job video/ảnh (AIVideo), được
 * tái sử dụng để tránh đăng nhập lại liên tục và giảm tải khi khởi động
 * Chrome. Mỗi job tự mở/đóng page riêng (xem aiVideo.ts). Dùng cho các
 * script CLI một lần (check-credit, download-video-by-feed-id, ...) — KHÔNG
 * dùng cho bot lúc chạy thật, xem getImageBrowserContext/getVideoBrowserContext.
 */
export const getBrowserContext = createBrowserContextManager(
  config.storageStatePath,
  "browser",
  'Chạy "npm run login" trước khi tạo video.',
);

/**
 * 2 BrowserContext RIÊNG BIỆT cho hàng đợi ẢNH và hàng đợi VIDEO (xem
 * imageJobs/videoJobs trong queue.ts) — mỗi hàng đợi giờ chạy độc lập, có
 * thể xử lý CÙNG LÚC (không còn xếp chung 1 hàng đợi như trước). Theo yêu
 * cầu người dùng, dùng LUÔN 2 TÀI KHOẢN AIVideo KHÁC NHAU (2 session file
 * khác nhau — aiVideoImageStorageStatePath riêng cho ảnh, storageStatePath
 * như cũ cho video), KHÔNG chỉ 2 browser context của CÙNG 1 tài khoản — vừa
 * tránh 2 tab thao tác đồng thời trên CÙNG tài khoản dễ xung đột, vừa tránh
 * tranh credit/rate-limit giữa ảnh và video. Đăng nhập tài khoản ảnh bằng
 * `npm run login -- image` (xem scripts/login.ts).
 */
export const getImageBrowserContext = createBrowserContextManager(
  config.aiVideoImageStorageStatePath,
  "browser-image",
  'Chạy "npm run login -- image" trước khi tạo ảnh.',
);
export const getVideoBrowserContext = createBrowserContextManager(
  config.storageStatePath,
  "browser-video",
  'Chạy "npm run login" trước khi tạo video.',
);
