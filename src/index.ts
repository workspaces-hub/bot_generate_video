import { Telegraf } from "telegraf";
import { config } from "./config";
import { registerHandlers } from "./bot/handlers";

const bot = new Telegraf(config.botToken);
registerHandlers(bot);

bot
  .launch()
  .then(() => console.log("[bot] Đã khởi động"))
  .catch((err) => {
    console.error("[bot] Không thể khởi động:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
