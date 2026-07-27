import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config";
import { enqueueJob } from "../queue";
import { PROMPT_BUTTON_LABEL, promptMenu } from "./keyboard";

// userId đang chờ nhập prompt (đã bấm nút 📝 Prompt trong DM).
const waitingForPrompt = new Set<number>();

function isAdmin(userId: number): boolean {
  return config.admins.includes(userId.toString());
}

/** Chặn mọi tương tác từ user không có trong ADMINS (xem .env). */
async function checkAdmin(ctx: Context, next: () => Promise<void>): Promise<void> {
  const userId = ctx.from?.id;
  if (userId && isAdmin(userId)) {
    return next();
  }
}

export function registerHandlers(bot: Telegraf): void {
  bot.use(checkAdmin);

  // Menu chỉ hiện trong DM: reply keyboard gửi tin nhắn vào đúng chat đang
  // mở, nên nếu hiện trong group thì bấm nút sẽ gửi tin vào group thật —
  // phải tránh vì bot không xử lý tin nhắn trong group.
  bot.command(["start", "menu"], async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await ctx.reply("Menu:", promptMenu);
  });

  bot.hears(PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    waitingForPrompt.add(ctx.from.id);
    await ctx.reply("Gửi nội dung prompt bạn muốn tạo video:");
  });

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.from || ctx.chat.type !== "private") return next();

    if (!waitingForPrompt.has(ctx.from.id)) return next();
    if (ctx.message.text.startsWith("/")) return next();

    waitingForPrompt.delete(ctx.from.id);
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
      return;
    }

    const dmChatId = ctx.chat.id;
    const groupChatId = config.groupChatId;

    await ctx.reply(`⏳ Đang tạo video cho prompt:\n"${prompt}"\nKết quả sẽ được đăng vào group.`, promptMenu);

    enqueueJob({
      chatId: groupChatId,
      prompt,
      onSuccess: async (filePath) => {
        await ctx.telegram
          .sendVideo(groupChatId, { source: filePath }, { caption: `✅ Video cho prompt: "${prompt}"` })
          .catch(async (err) => {
            console.error("[bot] Gửi video thất bại:", err);
            await ctx.telegram.sendMessage(groupChatId, "404");
          });
        await ctx.telegram.sendMessage(dmChatId, "✅ Xong! Video đã được đăng vào group.").catch(() => {});
      },
      onError: async (err: any) => {
        console.error("[bot] Tạo video thất bại:", err);
        await ctx.telegram.sendMessage(groupChatId, `
${prompt}:
404`);
        await ctx.telegram.sendMessage(dmChatId, "❌ Tạo video thất bại: " + err.message).catch(() => {});
      },
    });
  });
}
