import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config";
import { enqueueJob } from "../queue";
import { PROMPT_ACTION, promptKeyboard } from "./keyboard";

const waitingForPrompt = new Set<string>();

function stateKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function isAllowedChat(chatId: number): boolean {
  return !config.groupChatId || config.groupChatId === chatId;
}

export function registerHandlers(bot: Telegraf): void {
  bot.command(["start", "menu"], async (ctx) => {
    if (!ctx.chat || !isAllowedChat(ctx.chat.id)) return;
    await ctx.reply(
      "Bấm nút bên dưới rồi gửi nội dung prompt để tạo video từ hailuoai.video:",
      promptKeyboard,
    );
  });

  bot.action(PROMPT_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.chat || !ctx.from || !isAllowedChat(ctx.chat.id)) return;

    waitingForPrompt.add(stateKey(ctx.chat.id, ctx.from.id));
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, hãy gửi nội dung prompt ở tin nhắn tiếp theo.`,
      { reply_parameters: ctx.callbackQuery.message ? { message_id: ctx.callbackQuery.message.message_id } : undefined },
    );
  });

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.chat || !ctx.from || !isAllowedChat(ctx.chat.id)) return next();

    const key = stateKey(ctx.chat.id, ctx.from.id);
    if (!waitingForPrompt.has(key)) return next();
    if (ctx.message.text.startsWith("/")) return next();

    waitingForPrompt.delete(key);
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      await ctx.reply("Prompt trống, đã huỷ.", { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    const chatId = ctx.chat.id;
    const promptMessageId = ctx.message.message_id;

    const statusMessage = await ctx.reply(`⏳ Đang tạo video cho prompt:\n"${prompt}"`, {
      reply_parameters: { message_id: promptMessageId },
    });

    enqueueJob({
      chatId,
      prompt,
      onSuccess: async (filePath) => {
        await ctx.telegram
          .sendVideo(
            chatId,
            { source: filePath },
            {
              caption: `✅ Video cho prompt: "${prompt}"`,
              reply_parameters: { message_id: promptMessageId },
            },
          )
          .catch(async (err) => {
            console.error("[bot] Gửi video thất bại:", err);
            await ctx.telegram.sendMessage(chatId, "404", {
              reply_parameters: { message_id: promptMessageId },
            });
          });
        await ctx.telegram.deleteMessage(chatId, statusMessage.message_id).catch(() => {});
      },
      onError: async (err) => {
        console.error("[bot] Tạo video thất bại:", err);
        await ctx.telegram.sendMessage(chatId, "404", {
          reply_parameters: { message_id: promptMessageId },
        });
        await ctx.telegram.deleteMessage(chatId, statusMessage.message_id).catch(() => {});
      },
    });
  });
}
