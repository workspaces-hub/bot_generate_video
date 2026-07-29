import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - Start Frame";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Image Reference";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Character Reference";
export const OMNI_REF_BUTTON_LABEL = "Video - Omni Reference";

export const promptMenu = Markup.keyboard([
  [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  // [OMNI_REF_BUTTON_LABEL],
]).resize();
