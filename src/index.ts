import { Telegraf } from "telegraf";
import { config } from "./config";
import { registerHandlers } from "./bot/handlers";
import { initQueue } from "./queue";

const bot = new Telegraf(config.botToken);
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
