import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - frame bắt đầu";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Tham chiếu ảnh";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Tham chiếu nhân vật";
export const OMNI_REF_BUTTON_LABEL = "Video - Tham chiếu toàn diện";
export const CHATAI_BUTTON_LABEL = "Tạo video từ kịch bản";
/** Giống CHATAI_BUTTON_LABEL nhưng CHỈ hỏi ChatAI + tải file JSON về gửi lại luôn — không gen ảnh/video (xem submitChatAIJob, processChatAIQueue). */
export const CHATAI_CHECK_BUTTON_LABEL = "Check prompt kịch bản";
/** Dừng SỚM các job đang chờ/đang gen ảnh-video của CHARACTER_REF_BUTTON_LABEL và CHATAI_BUTTON_LABEL — xem stopAll() trong queue.ts. */
export const STOP_ALL_BUTTON_LABEL = "🛑 Stop All";
/** Retry job "storyboardVideo"/"storyboardImagesAIVideo" đã lỗi trước đó (xem failedStoryboardJobs/continueFailedStoryboardVideo trong queue.ts) — user nhập tên file json, bot tự tra lại. */
export const CONTINUE_VIDEO_BUTTON_LABEL = "Tiếp tục tạo video";

export const promptMenu = Markup.keyboard([
  [CHATAI_CHECK_BUTTON_LABEL, CHATAI_BUTTON_LABEL],
  [STOP_ALL_BUTTON_LABEL, CONTINUE_VIDEO_BUTTON_LABEL],
  [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  [OMNI_REF_BUTTON_LABEL],
]).resize();
