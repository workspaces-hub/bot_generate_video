import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Prompt";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Image Reference";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Character Reference";

export const promptMenu = Markup.keyboard([
  [PROMPT_BUTTON_LABEL, IMAGE_BUTTON_LABEL],
  [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
]).resize();
