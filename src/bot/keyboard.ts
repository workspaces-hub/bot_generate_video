import { Markup } from "telegraf";

export const PROMPT_ACTION = "prompt";

export const promptKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("📝 Prompt", PROMPT_ACTION),
]);
