import os from "node:os";
import { Telegraf } from "telegraf";
import { config } from "./config";
import { registerHandlers } from "./bot/handlers";
import { initQueue } from "./queue";

// Theo yêu cầu người dùng (VPS 100% CPU do các Chrome instance gen ảnh/video
// — xác nhận qua `ps aux --sort=-%cpu` thật: 1 renderer Chrome chiếm 64.9%
// CPU 1 mình — khiến process bot Node, dù tự nó chỉ ~3% CPU, bị hệ điều
// hành trì hoãn cấp CPU khi cả hệ thống quá tải, làm trễ/mất phản hồi lệnh
// Telegram như /start dù log xác nhận KHÔNG hề crash): TỰ nâng độ ưu tiên OS
// (hạ niceness) của CHÍNH process bot này (không đụng tới Chrome — Playwright
// không lộ PID tiến trình con qua `Browser` trả về từ chromium.launch(), chỉ
// launchServer()/connect() mới có, đổi lại phức tạp hơn hẳn cho lợi ích
// tương đương). Cần quyền hạ niceness xuống dưới 0 (root — bot đang chạy
// root trên VPS này, xem ps aux) — best-effort, không throw nếu môi trường
// khác không đủ quyền (vd chạy dev không phải root). Kernel Linux ưu tiên
// cấp CPU cho process niceness thấp hơn khi tranh chấp, giúp vòng lặp sự
// kiện Node (nhận/xử lý update Telegram) không bị đói CPU bởi Chrome dù
// Chrome đang ngốn gần hết CPU hệ thống.
try {
  os.setPriority(0, -10);
} catch (err) {
  // console.warn("[bot] Không nâng được độ ưu tiên CPU cho process bot (bỏ qua, cần quyền root):", err);
}

// Lưới an toàn CUỐI CÙNG — bot.catch() bên dưới chỉ bắt lỗi từ middleware
// Telegraf; các queue chạy nền độc lập (processPolloImageQueue,
// processPolloVideoQueue, processChatAIQueue... trong queue.ts, gọi kiểu
// "void func()" không await tới cùng) nếu có 1 lỗi lọt ra ngoài mọi
// try/catch cục bộ vẫn sẽ crash cả process (Node mặc định thoát tiến trình
// khi có unhandled rejection) — cùng hậu quả "bot im lặng không phản hồi"
// đã xác nhận với lỗi Telegraf. Chỉ log, KHÔNG process.exit(), để bot không
// chết oan vì 1 lỗi lẻ ở 1 job/queue không liên quan.
process.on("unhandledRejection", (reason) => {
  console.error("[bot] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bot] Uncaught exception:", err);
});

const bot = new Telegraf(config.botToken);

// QUAN TRỌNG: Telegraf mặc định (không có bot.catch) sẽ "throw err" lại sau
// khi console.error (xem handleError trong telegraf.js) — bất kỳ lỗi nào
// thoát ra khỏi 1 handler (bot.command/bot.hears/bot.on...) MÀ KHÔNG được
// try/catch cục bộ nuốt lại sẽ trở thành unhandled rejection, CRASH LUÔN
// TOÀN BỘ PROCESS BOT (Node mặc định thoát tiến trình khi có unhandled
// rejection) — không phải chỉ lỗi riêng của 1 lệnh/1 người dùng. Nếu pm2 tự
// khởi động lại, hiện tượng bên ngoài là bot "im lặng không phản hồi" (đúng
// lúc crash-restart) cho MỌI lệnh đang gõ, kể cả /start, dù handler của
// /start tự nó không có gì sai — rất khó chẩn đoán vì không thấy lỗi rõ
// ràng ở phía người dùng. Bắt lỗi ở đây để chỉ log, KHÔNG rethrow — giữ bot
// sống tiếp cho các chat/job khác dù 1 update nào đó xử lý lỗi.
bot.catch((err, ctx) => {
  console.error(`[bot] Lỗi khi xử lý update ${ctx.update.update_id}:`, err);
});

registerHandlers(bot);
// Khôi phục job còn dang dở từ lần chạy trước (nếu có) và bắt đầu xử lý.
initQueue(bot.telegram);

bot
  .launch()
  .then(() => console.log("[bot] Đã khởi động"))
  .catch((err) => {
    console.error("[bot] Không thể khởi động:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
