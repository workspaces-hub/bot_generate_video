import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config";
import { enqueueJob } from "../queue";
import { PROMPT_BUTTON_LABEL, promptMenu } from "./keyboard";

// userId đang chờ nhập prompt (đã bấm nút 📝 Prompt trong group).
const waitingForPrompt = new Set<number>();

function isAdmin(userId: number): boolean {
  return config.admins.includes(userId.toString());
}

function isAllowedGroup(chatId: number): boolean {
  return chatId === config.groupChatId;
}

/** Chặn mọi tương tác từ user không có trong ADMINS (xem .env). */
async function checkAdmin(
  ctx: Context,
  next: () => Promise<void>,
): Promise<void> {
  const userId = ctx.from?.id;
  if (userId && isAdmin(userId)) {
    return next();
  }
}

export function registerHandlers(bot: Telegraf): void {
  bot.use(checkAdmin);

  // bot.telegram.getMe().then(console.log);

  bot.command(["start", "menu"], async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    await ctx.reply("Menu:", promptMenu);
  });

  bot.hears(PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    waitingForPrompt.add(ctx.from.id);
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo:`,
    );
  });

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    if (!waitingForPrompt.has(ctx.from.id)) return next();
    if (
      ctx.message.text.startsWith("/") ||
      ctx.message.text === PROMPT_BUTTON_LABEL
    )
      return next();

    waitingForPrompt.delete(ctx.from.id);
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
      return;
    }

    const groupChatId = ctx.chat.id;
    const promptMessageId = ctx.message.message_id;

    const statusMessage = await ctx.reply(
      `⏳ Đang tạo video cho prompt:\n"${prompt}"`,
      {
        reply_parameters: { message_id: promptMessageId },
      },
    );

    enqueueJob({
      chatId: groupChatId,
      prompt,
      onSuccess: async (filePath) => {
        await ctx.telegram
          .sendVideo(
            groupChatId,
            { source: filePath },
            {
              caption: `✅ Video cho prompt: "${prompt}"`,
              reply_parameters: { message_id: promptMessageId },
            },
          )
          .catch(async (err: any) => {
            console.error("[bot] Gửi video thất bại:", err);
            await ctx.telegram.sendMessage(groupChatId, "404", {
              reply_parameters: { message_id: promptMessageId },
            });
            try {
              await ctx.telegram.sendMessage(config.admins, err.message);
            } catch {}
          });
        await ctx.telegram
          .deleteMessage(groupChatId, statusMessage.message_id)
          .catch(() => {});
      },
      onError: async (err: any) => {
        console.error("[bot] Tạo video thất bại:", err);
        try {
          await ctx.telegram.sendMessage(config.admins, err.message);
        } catch {}
        await ctx.telegram.sendMessage(groupChatId, "404", {
          reply_parameters: { message_id: promptMessageId },
        });

        await ctx.telegram
          .deleteMessage(groupChatId, statusMessage.message_id)
          .catch(() => {});
      },
    });
  });
}
