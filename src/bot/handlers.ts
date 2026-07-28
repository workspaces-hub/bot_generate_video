import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
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

interface SubmitJobParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
}

async function submitJob({ ctx, groupChatId, promptMessageId, userId, rawText }: SubmitJobParams): Promise<void> {
  const { text: prompt, resolution, model } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    return;
  }

  const statusMessage = await ctx.reply(`⏳ Đang tạo video cho prompt:\n"${prompt}"`, {
    reply_parameters: { message_id: promptMessageId },
  });

  // Chỉ dữ liệu thuần (không callback/ctx) — enqueueJob tự ghi ra file để
  // sống sót qua restart/crash, xem src/queue.ts.
  enqueueJob({
    chatId: groupChatId,
    prompt,
    resolution,
    model: isAdmin(userId) ? model : DEFAULT_MODEL,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
  });
}

export function registerHandlers(bot: Telegraf): void {
  // bot.use(checkAdmin);

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
    if (ctx.message.text.startsWith("/") || ctx.message.text === PROMPT_BUTTON_LABEL) return next();

    waitingForPrompt.delete(ctx.from.id);
    await submitJob({
      ctx,
      groupChatId: ctx.chat.id,
      promptMessageId: ctx.message.message_id,
      userId: ctx.from.id,
      rawText: ctx.message.text,
    });
  });
}
