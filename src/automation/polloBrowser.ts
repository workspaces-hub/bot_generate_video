import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext DÙNG CHUNG cho cả gen ẢNH (polloImage.ts) lẫn gen VIDEO
 * (pollo.ts) — 1 PROFILE/session pollo.ai duy nhất (1 Chrome browser process
 * thật sự), mỗi lần generate tự mở/đóng 1 page (tab) riêng trên context này
 * (xem generateImage/generateVideo) — giống hệt cách 1 người dùng thật mở 2
 * tab của cùng 1 trang, KHÔNG phải 2 phiên đăng nhập độc lập. Đăng nhập qua
 * scripts/login-pollo.ts.
 *
 * SỬA (theo yêu cầu người dùng — VPS 100% CPU khi ảnh+video chạy song song,
 * xem htop: mỗi browser instance sinh ra 1 cây process Chrome riêng — GPU
 * process, network service, utility process... — dù chỉ cần ĐÚNG 1 profile):
 * TRƯỚC ĐÂY dùng 2 instance createBrowserContextManager riêng
 * (getPolloBrowserContext cho video + getPolloImageBrowserContext cho ảnh),
 * tức 2 Chrome browser process ĐỘC LẬP cùng đăng nhập 1 tài khoản — vừa tốn
 * gấp đôi overhead process, vừa mang rủi ro chưa xác nhận (2 PHIÊN đăng nhập
 * độc lập trên cùng tài khoản có thể bị pollo.ai tự đăng xuất lẫn nhau).
 * Gộp về 1 BrowserContext dùng chung loại bỏ cả 2 vấn đề: chỉ 1 cây process
 * Chrome (giảm ~nửa CPU/RAM baseline), và đúng mô hình "1 phiên đăng nhập, 2
 * tab" pollo.ai vốn dĩ đã hỗ trợ cho người dùng thật — không còn là 2 phiên
 * độc lập tranh chấp trạng thái đăng nhập nữa.
 *
 * 2 hàng đợi (polloImageJobs/polloVideoJobs trong queue.ts) vẫn chạy THẬT SỰ
 * song song bình thường — page/tab là đơn vị cô lập đủ dùng cho Playwright
 * (mỗi page điều hướng/thao tác độc lập, không đụng nhau), CHỈ pha upload
 * asset dùng chung + mention (thao tác lên thư viện asset TOÀN TÀI KHOẢN,
 * không riêng theo tab) mới cần khoá tuần tự — xem withPolloAssetUploadLock
 * trong pollo.ts (lý do khoá không đổi, vẫn đúng dù giờ chung 1 context).
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
