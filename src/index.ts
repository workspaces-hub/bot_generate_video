import os from "node:os";
import { Telegraf, Telegram, TelegramError } from "telegraf";
import { config } from "./config";
import { registerHandlers } from "./bot/handlers";
import { startQwenFileServerEagerly } from "./automation/qwenFileServer";
import { initQueue } from "./queue";
import {
  getGeminiBrowserContext,
  getGeminiImageBrowserContext,
} from "./automation/geminiBrowser";

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

// handlerTimeout mặc định của Telegraf là 90_000ms (xem node_modules/telegraf/
// lib/telegraf.js — dùng p-timeout bọc quanh middleware) — xác nhận qua lỗi
// thật (2026-09-29): "TimeoutError: Promise timed out after 90000
// milliseconds" khi tải video "Tham chiếu kịch bản" lớn qua MTProto
// (downloadTelegramVideoRobust trong handlers.ts) chạy ĐỒNG BỘ ngay trong
// handler, trước khi enqueue job — video lớn + retry (xem
// telegramMTProto.ts) hoàn toàn có thể vượt 90s dù không có gì sai. Nới lên
// 10 phút — đủ dư cho cả trường hợp chậm nhất, vẫn hữu hạn (không dùng
// Infinity) để 1 handler thật sự bị treo (bug khác) không giữ mãi vô thời hạn.
const bot = new Telegraf(config.botToken, { handlerTimeout: 600_000 });

// Xác nhận qua log thật ("TelegramError: 429: Too Many Requests: retry after
// 42" ở runStoryboardPipelinePollo — nhiều tập liên tiếp gửi nhiều tin "Xác
// nhận tạo ảnh"): Telegram giới hạn tốc độ gửi theo chat, 1 lần 429 làm hỏng
// cả job ChatAI. Bọc callApi trên Telegram.prototype (ctx.telegram là
// instance MỚI tạo cho từng update, khác bot.telegram — xem handleUpdate
// trong telegraf.js) — gặp 429 thì chờ đúng retry_after rồi gửi lại.
// Gửi file luôn dùng { source: <path> } nên gửi lại an toàn (đọc lại file).
const TELEGRAM_429_MAX_RETRIES = 5;
const TELEGRAM_429_MAX_WAIT_SEC = 300;
const originalCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (this: Telegram, method, payload, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await originalCallApi.call(this, method, payload, options);
    } catch (err) {
      const retryAfter =
        err instanceof TelegramError && err.code === 429
          ? (err.parameters?.retry_after ?? 5)
          : null;
      if (
        retryAfter === null ||
        attempt >= TELEGRAM_429_MAX_RETRIES ||
        retryAfter > TELEGRAM_429_MAX_WAIT_SEC
      ) {
        throw err;
      }
      console.warn(
        `[bot] Telegram 429 (${method}) — chờ ${retryAfter}s rồi gửi lại (lần ${attempt + 1}/${TELEGRAM_429_MAX_RETRIES}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    }
  }
} as typeof Telegram.prototype.callApi;

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
// Khởi động NGAY lúc boot (không đợi lazy) — xem docstring
// startQwenFileServerEagerly: link "Nối video" phải sống được qua mọi lần
// restart process (tsx watch lúc dev, hay pm2 crash-restart lúc production),
// không phụ thuộc đã có publish nào chạy trong lần process này chưa.
startQwenFileServerEagerly();

bot
  .launch()
  .then(() => console.log("[bot] Đã khởi động"))
  .catch((err) => {
    console.error("[bot] Không thể khởi động:", err);
    process.exit(1);
  });

// Trước khi thoát (Ctrl+C/pm2 stop): lưu session Gemini mới nhất (xem
// persistSession trong browser.ts) — best-effort, tối đa 5s. Ctrl+C trong
// terminal cũng gửi SIGINT cho Chrome con nên có thể Chrome đã chết trước —
// vì vậy session còn được lưu định kỳ + sau mỗi job, không chỉ dựa vào đây.
async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  bot.stop(signal);
  await Promise.race([
    Promise.all([
      getGeminiBrowserContext.saveSession(),
      getGeminiImageBrowserContext.saveSession(),
    ]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
