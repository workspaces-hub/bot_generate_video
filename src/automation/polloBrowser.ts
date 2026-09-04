import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho pollo.ai — provider MỚI chạy song song với
 * AIVideo (hailuoai.video), khác domain/session hoàn toàn, nên KHÔNG dùng
 * chung getBrowserContext()/getChatAIBrowserContext() (sẽ lẫn cookie các site
 * vào nhau). Đăng nhập qua scripts/login-pollo.ts.
 *
 * Dùng proxy mặc định (useProxy=true, xem createBrowserContextManager) —
 * cùng lý do đã xác nhận với AIVideo/ChatAI: IP thẳng của VPS dễ bị chặn bởi
 * Cloudflare/anti-bot khi truy cập trực tiếp. CHƯA có bằng chứng thật riêng
 * cho pollo.ai — giữ nguyên mặc định an toàn cho tới khi xác nhận ngược lại.
 */
export const getPolloBrowserContext = createBrowserContextManager(
  config.polloStorageStatePath,
  "pollo-browser",
  'Chạy "npm run login-pollo" trước khi dùng tính năng pollo.ai.',
);

/**
 * BrowserContext RIÊNG cho gen ẢNH (polloImage.ts) — CÙNG 1 tài khoản/session
 * (đọc CHUNG config.polloStorageStatePath) với getPolloBrowserContext ở trên
 * (dùng cho gen VIDEO, pollo.ts), nhưng là 1 instance createBrowserContextManager
 * KHÁC — nghĩa là 1 BrowserContext (Chrome context) THẬT SỰ riêng biệt, launch
 * độc lập, cho phép ảnh và video chạy THẬT SỰ song song (2 hàng đợi
 * polloImageJobs/polloVideoJobs trong queue.ts không còn phải chờ nhau qua
 * 1 context dùng chung nữa).
 *
 * THEO LỰA CHỌN CỦA NGƯỜI DÙNG: chấp nhận rủi ro 2 context cùng đăng nhập 1
 * tài khoản pollo.ai đồng thời (KHÁC với giải pháp AIVideo đã dùng — 2 TÀI
 * KHOẢN riêng, an toàn hơn nhưng cần tài khoản/credit mới) — pollo.ai CHƯA
 * được xác nhận có tolerate 2 phiên song song trên cùng tài khoản hay không
 * (vd có thể tự đăng xuất phiên cũ, hoặc UI 2 tab xung đột trạng thái). Nếu
 * gặp lỗi đăng xuất/xung đột trong thực tế, cân nhắc chuyển sang giải pháp 2
 * tài khoản riêng (xem lại getPolloBrowserContext ở trên làm mẫu).
 */
export const getPolloImageBrowserContext = createBrowserContextManager(
  config.polloStorageStatePath,
  "pollo-browser-image",
  'Chạy "npm run login-pollo" trước khi dùng tính năng pollo.ai.',
);
