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
 * ĐÃ THỬ gộp về 1 BrowserContext dùng chung (2 tab, 1 profile) để giảm CPU
 * (2 cây process Chrome → 1) — REVERT lại 2 context riêng theo yêu cầu người
 * dùng. Lý do (suy đoán, chưa xác nhận hẳn qua bằng chứng đầy đủ nhưng đủ
 * để revert phòng ngừa): lúc dùng chung profile, "enableUnlimitedIfNotEnoughCredit"
 * (switch Unlimited) bắt đầu treo/timeout lặp lại theo kiểu MỚI (không còn
 * do cookie banner) — nghi ngờ 2 tab CÙNG 1 origin storage partition (chung
 * localStorage/BroadcastChannel/IndexedDB, khác hẳn 2 browser instance riêng
 * trước đó dù cùng tài khoản) khiến pollo.ai đồng bộ trạng thái credit/
 * Unlimited giữa 2 tab, tab kia render lại đúng lúc tab này đang thao tác.
 * 2 context riêng (2 process Chrome thật, KHÔNG chung storage partition) né
 * hẳn nguồn race này, đổi lại tốn thêm ~1 cây process Chrome — chấp nhận
 * được, ưu tiên ổn định hơn tối ưu CPU ở đây.
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

/**
 * Giới hạn CỨNG tổng số task pollo.ai (ẢNH + VIDEO cộng lại) đang thực sự
 * chạy ĐỒNG THỜI trong CHÍNH process này — tài khoản pollo.ai cho phép tối
 * đa 8 task song song (theo xác nhận người dùng).
 *
 * KHÁC với config.polloImageConcurrency/polloVideoConcurrency (số worker của
 * RIÊNG từng hàm gọi trong storyboardPipeline.ts, xem generateVideosForFilePollo/
 * generateReferenceImagesForFileViaPollo/generateSceneImagesForFileViaPollo)
 * — 2 config đó không biết về nhau, hàng đợi ẢNH và hàng đợi VIDEO chạy song
 * song ĐỘC LẬP (2 browser context riêng ở trên) nên cộng lại vẫn có thể vượt
 * 8 nếu chỉ dựa vào config tĩnh. Gate CHUNG này đếm SỐ TASK THẬT đang chạy
 * (biến trong bộ nhớ, CHIA SẺ giữa mọi lời gọi withPolloTaskSlot bất kể ảnh
 * hay video) và CHẶN LẠI (chờ có slot trống) trước khi cho phép 1 task mới
 * bắt đầu — bảo đảm KHÔNG BAO GIỜ vượt quá giới hạn thật dù worker-pool nào
 * cấu hình bao nhiêu.
 *
 * CHỈ đúng trong 1 process (biến trong bộ nhớ) — 2 process/2 máy khác nhau
 * dùng chung 1 tài khoản (xem POLLO_VIDEO_CONCURRENCY/POLLO_IMAGE_CONCURRENCY
 * trong .env.example) vẫn phải tự chia tĩnh cho từng máy, gate này không biết
 * gì về process khác.
 */
const MAX_POLLO_ACCOUNT_PARALLEL_TASKS = 8;
let activePolloTaskCount = 0;

export function getActivePolloTaskCount(): number {
  return activePolloTaskCount;
}

/**
 * Chờ tới khi có slot trống (activePolloTaskCount < MAX_POLLO_ACCOUNT_PARALLEL_TASKS)
 * rồi mới chạy fn() — giữ slot suốt lúc fn() đang chạy, tự trả lại slot ngay
 * khi fn() xong (thành công hay lỗi đều trả, xem finally). Bọc NGAY quanh
 * lệnh gen thật (generateImagePollo/generateVideoPollo) — không cần bọc các
 * bước chuẩn bị khác vì 2 hàm đó tự quản lý toàn bộ vòng đời 1 task (mở tab
 * riêng, upload, generate, chờ, đóng tab) bên trong lệnh gọi.
 *
 * Điều kiện while + activePolloTaskCount++ không có "await" ở giữa nên AN
 * TOÀN dù nhiều worker gọi đồng thời (JS đơn luồng, không thể xen kẽ 2
 * statement liền nhau) — không cần lock/mutex riêng.
 */
export async function withPolloTaskSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activePolloTaskCount >= MAX_POLLO_ACCOUNT_PARALLEL_TASKS) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  activePolloTaskCount++;
  try {
    return await fn();
  } finally {
    activePolloTaskCount--;
  }
}
