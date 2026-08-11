import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - frame bắt đầu";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Tham chiếu ảnh";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Tham chiếu nhân vật";
export const OMNI_REF_BUTTON_LABEL = "Video - Tham chiếu toàn diện";
export const GPT_BUTTON_LABEL = "Tạo video từ kịch bản";
/** Giống GPT_BUTTON_LABEL nhưng CHỈ hỏi GPT + tải file JSON về gửi lại luôn — không gen ảnh/video (xem submitGptJob, processGptQueue). */
export const GPT_CHECK_BUTTON_LABEL = "Check prompt kịch bản";

export const promptMenu = Markup.keyboard([
  [GPT_CHECK_BUTTON_LABEL, GPT_BUTTON_LABEL],
  [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  [OMNI_REF_BUTTON_LABEL],
]).resize();
