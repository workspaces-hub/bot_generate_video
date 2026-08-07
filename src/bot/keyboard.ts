import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - frame bắt đầu";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Tham chiếu ảnh";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Tham chiếu nhân vật";
export const OMNI_REF_BUTTON_LABEL = "Video - Tham chiếu toàn diện";
export const GPT_BUTTON_LABEL = "GPT";

export const promptMenu = Markup.keyboard([
  [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  [OMNI_REF_BUTTON_LABEL, GPT_BUTTON_LABEL],
]).resize();
