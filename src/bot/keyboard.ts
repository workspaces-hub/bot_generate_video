import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - frame bắt đầu";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Tham chiếu ảnh";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Tham chiếu nhân vật";
export const OMNI_REF_BUTTON_LABEL = "Video - Tham chiếu toàn diện";
export const CHATAI_BUTTON_LABEL = "Tạo video từ kịch bản";
/** Giống CHATAI_BUTTON_LABEL nhưng CHỈ hỏi ChatAI + tải file JSON về gửi lại luôn — không gen ảnh/video (xem submitChatAIJob, processChatAIQueue). */
export const CHATAI_CHECK_BUTTON_LABEL = "Check prompt kịch bản";
/**
 * User upload 1 video (KHÔNG phải kịch bản text) — bot upload video này +
 * master prompt prompt_split_video.txt lên ChatAI, chờ ChatAI phân tích rồi
 * trả file JSON storyboard, gửi lại cho user KÈM nút xác nhận "Tạo ảnh
 * (Pollo)" — cùng luồng xác nhận với CHATAI_BUTTON_LABEL/
 * CHATAI_CHECK_BUTTON_LABEL sau khi có JSON (xem submitScriptReferenceVideoJob,
 * processScriptReferenceVideoQueue).
 */
export const SCRIPT_REFERENCE_BUTTON_LABEL = "Tham chiếu kịch bản";
/**
 * GẦN GIỐNG SCRIPT_REFERENCE_BUTTON_LABEL (cùng askChatAIAboutReferenceVideo,
 * cùng job "scriptReferenceVideo"/processScriptReferenceVideoQueue) nhưng
 * KHÁC 2 điểm: (1) master prompt dùng config.promptVideoReference thay vì
 * config.promptSplitVideo — JSON trả về chia thành các đoạn VIDEO NGẮN nối
 * tiếp (tối đa 15s/đoạn, ranh giới cắt theo lời thoại/diễn biến hợp lý —
 * xem mục 3B trong prompt_video_reference.txt), KHÁC prompt_split_video.txt
 * ở chỗ không chia theo diễn biến/cảnh (không có SHOT nhiều CLIP thời lượng
 * tự do) mà chia đều theo ngân sách thời lượng cố định; (2) job đặt
 * skipImageConfirmation=true — CHỈ dừng ở bước gửi lại JSON cho user, KHÔNG
 * tạo folder generated/, KHÔNG gửi nút xác nhận "Tạo ảnh" (khác hẳn
 * SCRIPT_REFERENCE_BUTTON_LABEL, xem xử lý trong processScriptReferenceVideoQueue).
 */
export const VIDEO_REFERENCE_BUTTON_LABEL = "Tham chiếu video";
/**
 * User gõ tên (1 phần của tên) file JSON storyboard đã có sẵn trong
 * storage/chatai-results — bot tìm TẤT CẢ file JSON có tên CHỨA chuỗi đó
 * (có thể khớp nhiều file = nhiều tập phim), gửi ghép nội dung các file đó +
 * master prompt config.promptGenerateScript lên ChatAI, yêu cầu viết lại
 * thành 1 bộ phim MỚI TƯƠNG TỰ (đổi kịch bản/nhân vật/bối cảnh/đạo cụ/lời
 * thoại, giữ cấu trúc kỹ thuật dựng phim) rồi trả về NHIỀU file JSON tương
 * ứng từng tập, với id nhân vật/bối cảnh/đạo cụ/vật thể nhất quán xuyên các
 * tập (xem prompt_generate_script.txt, handleGenerateScriptRequest/
 * processChatAIQueue — dùng CHUNG hàng đợi/mảng với ChatAIJob, xem docstring
 * GenerateScriptJob trong queue.ts). Cùng luồng xác nhận "Tạo ảnh (Pollo)"
 * với SCRIPT_REFERENCE_BUTTON_LABEL sau khi có JSON (dùng chung
 * runStoryboardPipelinePollo/notifyChatAISuccess).
 */
export const GENERATE_SCRIPT_BUTTON_LABEL = "Tạo kịch bản mới";
/**
 * Bất kỳ ai trong nhóm được phép dùng bot (isAllowedGroup, KHÔNG giới hạn
 * admin — theo yêu cầu người dùng) đều bấm được — user upload 1 file .txt
 * để GHI ĐÈ master prompt prompt_generate_script.txt (dùng cho
 * GENERATE_SCRIPT_BUTTON_LABEL), cho phép sửa prompt trực tiếp từ Telegram
 * không cần SSH/sửa file trên server. Bản CŨ được sao lưu thành
 * "prompt_generate_script_vXX.txt" (XX tăng dần, dùng chung nextBackupVersion
 * với tryReplaceGeneratedFile/tryHandleReferenceJsonUpload) TRƯỚC khi ghi
 * đè — không mất bản trước nếu cần khôi phục lại.
 */
export const UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt tạo kịch bản";
/**
 * GIỐNG UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL HỆT (không giới hạn
 * admin, cùng cơ chế sao lưu bản cũ bằng nextBackupVersion trước khi ghi
 * đè) nhưng ghi đè master prompt prompt_video_reference.txt (dùng cho
 * VIDEO_REFERENCE_BUTTON_LABEL) thay vì prompt_generate_script.txt — RIÊNG
 * nút/mode theo đúng quy ước clone-theo-provider của dự án, không gộp
 * chung 1 nút rồi chọn file qua tham số.
 */
export const UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt tham chiếu video";
/** Dừng SỚM các job đang chờ/đang gen ảnh-video của CHARACTER_REF_BUTTON_LABEL và CHATAI_BUTTON_LABEL — xem stopAll() trong queue.ts. */
export const STOP_ALL_BUTTON_LABEL = "🛑 Stop All";
/** Retry job "storyboardVideo" đã lỗi trước đó (xem failedStoryboardJobs/continueFailedStoryboardVideo trong queue.ts) — user nhập tên file json, bot tự tra lại. */
export const CONTINUE_VIDEO_BUTTON_LABEL = "Tiếp tục tạo video";
/**
 * SỬA (theo yêu cầu người dùng): nút này giờ đẩy job "storyboardScenePollo"
 * (pollo.ai) THAY VÌ "storyboardImagesAIVideo" — xem nhánh "continueSceneFrame"
 * trong handlers.ts, cùng cách đã đổi cho CONTINUE_VIDEO_BUTTON_LABEL (Pollo
 * thay AIVideo).
 */
export const CONTINUE_SCENE_FRAME_BUTTON_LABEL = "Tiếp tục tạo frame";

export const promptMenu = Markup.keyboard([
  [CHATAI_CHECK_BUTTON_LABEL, CHATAI_BUTTON_LABEL],
  [VIDEO_REFERENCE_BUTTON_LABEL, GENERATE_SCRIPT_BUTTON_LABEL],
  [CONTINUE_SCENE_FRAME_BUTTON_LABEL, CONTINUE_VIDEO_BUTTON_LABEL],
  [UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL, UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL],
  [STOP_ALL_BUTTON_LABEL],
  // [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  // [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  // [OMNI_REF_BUTTON_LABEL],
]).resize();
