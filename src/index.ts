import { Telegraf } from "telegraf";
import { config } from "./config";
import { registerHandlers } from "./bot/handlers";
import { initQueue } from "./queue";

async function main() {
  const bot = new Telegraf(config.botToken);
  registerHandlers(bot);
  // Khôi phục job còn dang dở từ lần chạy trước (nếu có) và bắt đầu xử lý.
  initQueue(bot.telegram);

  await bot.launch();
  console.log("[bot] Đã khởi động");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
main().catch((err) => {
  console.error("[bot] Không thể khởi động:", err);
  process.exit(1);
});
