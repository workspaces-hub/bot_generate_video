import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Telegraf, type Telegram } from "telegraf";
import { config } from "./config";
import { generateVideo } from "./automation/aiVideo";
import { generateImage } from "./automation/aiVideoImage";
import {
  askChatAI,
  askChatAIAboutReferenceVideo,
  askChatAIWithInlineContent,
  ChatAIError,
} from "./automation/chatAI";
import { getImageBrowserContext, getVideoBrowserContext } from "./automation/browser";
import {
  getPolloBrowserContext,
  getPolloImageBrowserContext,
} from "./automation/polloBrowser";
import { getChatAIBrowserContext } from "./automation/chatAIBrowser";
import {
  clearStopStoryboardRequest,
  ensureGeneratedFolder,
  ensureGeneratedFolderForName,
  generatedDirFor,
  generatedImageDirFor,
  generateReferenceImagesForFileViaAIVideo,
  generateReferenceImagesForFileViaPollo,
  generateSceneImagesForFileViaAIVideo,
  generateSceneImagesForFileViaPollo,
  generateVideosForFile,
  generateVideosForFileComfyUI,
  generateVideosForFilePollo,
  loadPersistedStopStoryboardRequests,
  reconcileAssetLedgerAcrossFiles,
  requestStopStoryboardPipeline,
  sleep,
  type FailedEntry,
  type GenerateVideosResult,
  type StoryboardEntry,
} from "./automation/storyboardPipeline";
import { promptMenu } from "./bot/keyboard";

interface BaseJob {
  chatId: number;
  /** Telegram user id của người bấm/gõ tạo ra job này — dùng để "Stop All" chỉ dừng ĐÚNG job của user đã bấm, xem stopAll(). */
  userId: number;
  prompt: string;
  /** Tin nhắn prompt gốc — dùng để reply kết quả/404 vào đúng chỗ. */
  promptMessageId: number;
  /** Tin nhắn "⏳ Đang tạo..." — xoá đi khi job xong (nếu còn tồn tại). */
  statusMessageId?: number;
  /**
   * Tên folder CHUNG (không phải theo từng file JSON riêng) dùng làm
   * storage/generated/<tên> cho MỌI file JSON của job này — CHỈ áp dụng cho
   * job KHÁC type "chatAI" (xem runStoryboardPipelinePollo). Job "chatAI"
   * luôn giữ hành vi CŨ (bỏ qua field này): mỗi file JSON có folder RIÊNG
   * theo đúng tên file đó (ensureGeneratedFolder/generatedDirFor). Field
   * này được SET ĐỘNG (không có ở lúc enqueue) ngay khi job biết được
   * downloadedFiles, TRƯỚC khi gọi runStoryboardPipelinePollo — xem
   * processScriptReferenceVideoQueue/processChatAIQueue (nhánh
   * job.type === "generateScript").
   */
  generatedFolderName?: string;
  /**
   * Tên file .txt/.md user upload làm prompt HOẶC file đính kèm tổng hợp
   * (nếu có) — dùng đặt tên lại file ChatAI trả về (xem askChatAI) thay vì
   * tên ChatAI tự đặt. Đặt ở BaseJob (thay vì riêng ChatAIJob) để
   * GenerateScriptJob dùng CHUNG được field/hàng đợi với ChatAIJob (xem
   * chatAIJobs/processChatAIQueue) mà không cần ép kiểu.
   */
  promptFileName?: string;
  /** Path local file prompt/nội dung tổng hợp (nếu có) — UPLOAD file này lên ChatAI, "prompt" lúc này chỉ là câu ngắn yêu cầu ChatAI đọc file (xem handlers.ts/askChatAI). Xoá file này sau khi job xong (finally trong processChatAIQueue). */
  promptAttachmentPath?: string;
}

export interface VideoGenerationJob extends BaseJob {
  type: "video";
  resolution?: string;
  model?: string;
  /** Thời lượng video (tuỳ chọn), nhãn khớp chip site — vd "6s"/"10s". Không truyền thì giữ nguyên mặc định của site. */
  duration?: string;
  /** Ảnh start frame (tuỳ chọn) — nếu có nhiều ảnh gửi lên, lấy ảnh gần nhất. */
  startFramePath?: string;
  /** Ảnh tham chiếu (tuỳ chọn, tối đa 3, dùng trang riêng) — loại trừ lẫn nhau với startFramePath. */
  referenceImagePaths?: string[];
  /** Ảnh nhân vật (bắt buộc đúng 1 ảnh) — mode "Character Reference", loại trừ lẫn nhau với 2 field trên. */
  characterImagePath?: string;
  /** File tham chiếu ảnh/video/audio (tuỳ chọn, tối đa 3) — mode "Omni Reference", loại trừ lẫn nhau với 3 field trên. */
  omniReferencePaths?: string[];
}

export interface ImageGenerationJob extends BaseJob {
  type: "image";
  model?: string;
  referenceImagePaths?: string[];
}

export interface ChatAIJob extends BaseJob {
  type: "chatAI";
}

/**
 * "Tham chiếu kịch bản" (SCRIPT_REFERENCE_BUTTON_LABEL) — KHÁC ChatAIJob ở
 * trên CHỈ ở nguồn input: đây là 1 VIDEO user upload (không phải kịch bản
 * text), gửi kèm master prompt config.promptSplitVideo lên ChatAI (xem
 * askChatAIAboutReferenceVideo). Từ lúc có JSON trở đi, xử lý GIỐNG HỆT
 * ChatAIJob — gửi file JSON, tạo folder generated/, gửi nút xác nhận "Tạo
 * ảnh (Pollo)" (xem runStoryboardPipelinePollo/notifyChatAISuccess, dùng
 * chung với processChatAIQueue — xem processScriptReferenceVideoQueue).
 *
 * Cũng dùng cho "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL, xem
 * masterPromptPath) — nhưng SỬA theo yêu cầu người dùng: tính năng đó CHỈ
 * dừng ở bước lưu JSON + gửi lại cho user, KHÔNG tạo folder generated/,
 * KHÔNG gửi nút xác nhận "Tạo ảnh" (skipImageConfirmation=true).
 */
export interface ScriptReferenceVideoJob extends BaseJob {
  type: "scriptReferenceVideo";
  /** Path local video đã tải về từ Telegram — upload lên ChatAI làm attachment, xoá sau khi job xong (finally trong processScriptReferenceVideoQueue). */
  videoPath: string;
  /** Tên file video gốc user upload — dùng đặt tên lại file JSON ChatAI trả về (xem askChatAIAboutReferenceVideo/downloadAttachedFiles). */
  videoFileName: string;
  /** Caption user gõ kèm video (vd yêu cầu bật TRANSFORM_MODE=ON trong master prompt) — nối thêm vào master prompt trước khi gửi ChatAI, xem askChatAIAboutReferenceVideo. */
  extraInstruction?: string;
  /** Path master prompt dùng cho job này (mặc định config.promptSplitVideo nếu không truyền — xem askChatAIAboutReferenceVideo). Nút "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL) truyền config.promptVideoReference để chỉ gen 1 VIDEO duy nhất thay vì chia SHOT/CLIP. */
  masterPromptPath?: string;
  /** true = job CHỈ gửi lại JSON cho user rồi dừng, KHÔNG tạo folder generated/, KHÔNG gửi nút "Tạo ảnh" xác nhận (xem processScriptReferenceVideoQueue). Nút "Tham chiếu video" đặt true; "Tham chiếu kịch bản" giữ mặc định false/undefined. */
  skipImageConfirmation?: boolean;
}

/**
 * "Tạo kịch bản mới" (GENERATE_SCRIPT_BUTTON_LABEL) — KHÁC ChatAIJob/
 * ScriptReferenceVideoJob ở nguồn input: đây là MỘT HOẶC NHIỀU file JSON
 * storyboard ĐÃ CÓ SẴN trong config.chatAIResultsDir (user gõ tên/1 phần tên
 * để tìm, xem handleGenerateScriptRequest trong handlers.ts), KHÔNG phải
 * upload video/text mới. Bot ghép nội dung TOÀN BỘ file JSON tìm được (mỗi
 * file = 1 tập phim) + master prompt config.promptGenerateScript thành 1
 * file đính kèm DUY NHẤT (BaseJob.promptAttachmentPath), gửi lên ChatAI yêu
 * cầu viết lại thành 1 bộ phim MỚI TƯƠNG TỰ (giữ cấu trúc kỹ thuật dựng phim,
 * đổi kịch bản/nhân vật/bối cảnh/đạo cụ/lời thoại — xem
 * prompt_generate_script.txt) rồi trả về NHIỀU file JSON, mỗi file 1 tập,
 * với id nhân vật/bối cảnh/đạo cụ/vật thể NHẤT QUÁN xuyên các tập.
 *
 * THEO YÊU CẦU NGƯỜI DÙNG: KHÔNG có hàng đợi/mảng riêng — dùng CHUNG hàng đợi
 * với ChatAIJob (đẩy thẳng vào chatAIJobs, xử lý trong processChatAIQueue,
 * xem enqueueJob). Chỉ khác ChatAIJob ở "type" (để processChatAIQueue biết
 * chạy thêm bước hậu kiểm Asset Ledger + xác định folder chung theo tên
 * phim — xem nhánh `job.type === "generateScript"` trong đó) và field
 * referenceFileNames (chỉ để hiển thị log). Từ lúc có JSON trở đi, xử lý
 * GIỐNG HỆT ChatAIJob/ScriptReferenceVideoJob (không skipImageConfirmation)
 * — gửi file JSON, tạo folder generated/, gửi nút xác nhận "Tạo ảnh (Pollo)"
 * cho TỪNG file/tập (xem runStoryboardPipelinePollo/notifyChatAISuccess).
 */
export interface GenerateScriptJob extends BaseJob {
  type: "generateScript";
  /** Tên các file JSON tham chiếu (trong config.chatAIResultsDir) đã ghép vào promptAttachmentPath — chỉ để hiển thị log/thông báo, không dùng để xử lý. */
  referenceFileNames: string[];
  /** Job "generateScript" LUÔN có field này (khác ChatAIJob — tuỳ chọn) — ghi đè lại kiểu bắt buộc để handlers.ts/queue.ts không cần check null thừa. */
  promptAttachmentPath: string;
}

/**
 * Job "tạo video" cho 1 file JSON storyboard — tạo qua 2 đường:
 * (1) User bấm nút "Tạo video" xác nhận (xem createVideoConfirmation/
 *     confirmVideoGeneration) — job CẢ FILE, "entryIds" để trống, xử lý HẾT
 *     entry VIDEO chưa "success" trong file. Trước khi thực sự xử lý, hàng
 *     đợi video LUÔN kiểm tra jsonPath: TOÀN BỘ entry type SCENE_SETTING
 *     phải đã "success": true thì mới lấy ra xử lý — nếu chưa, bỏ qua (giữ
 *     nguyên vị trí trong hàng đợi) và xét job tiếp theo, xem
 *     processVideoQueue/isJsonSceneSettingReady.
 * (2) Tự động đẩy NGAY khi 1 entry SCENE_SETTING_END vừa xong VÀ video entry
 *     tương ứng đã đủ ref (xem findVideoEntriesReadyAfterEnd trong
 *     storyboardPipeline.ts, gọi từ processImageQueue) — job CHỈ 1 CLIP,
 *     "entryIds" = [id entry VIDEO đó]. Đã tự xác nhận đủ ref TRƯỚC khi
 *     enqueue nên KHÔNG cần chờ isJsonSceneSettingReady của CẢ FILE (job loại
 *     này luôn coi là sẵn sàng ngay, xem findNextReadyVideoJobIndex) — cho
 *     phép nhiều clip trong CÙNG 1 file tạo video song song với lúc ảnh
 *     scene của các clip sau vẫn đang generate, thay vì phải đợi xong hết.
 *
 * Nằm trong hàng đợi VIDEO riêng (videoJobs) — KHÔNG tự gen ảnh SCENE_SETTING
 * (việc đó thuộc về job "storyboardImagesAIVideo"/"storyboardSceneImagesAIVideo"
 * trong hàng đợi ẢNH), job này CHỈ gọi generateVideosForFile.
 */
export interface StoryboardVideoJob extends BaseJob {
  type: "storyboardVideo";
  /** Path file JSON storyboard (ảnh CHARACTER/LOCATION/SCENE_SETTING phải đã xong) — truyền cho generateVideosForFile. */
  jsonPath: string;
  /** Không truyền = xử lý HẾT entry VIDEO chưa "success" trong file (nút "Tạo video" thủ công). Có truyền = job per-clip, CHỈ xử lý đúng (các) entry VIDEO này (xem generateVideosForFile onlyEntryIds). */
  entryIds?: string[];
}

/**
 * Job "tạo ảnh CHARACTER/LOCATION cho 1 file JSON storyboard" qua AIVideo
 * (generateReferenceImagesForFileViaAIVideo) — chỉ được tạo SAU KHI user bấm
 * nút "Tạo ảnh" xác nhận (xem createImageConfirmation/confirmImageGeneration),
 * GIỐNG NHAU cho cả 2 chế độ ChatAI (Tạo video từ kịch bản/Check prompt kịch
 * bản — xem processChatAIQueue). Nằm trong hàng đợi ẢNH riêng (imageJobs),
 * TÁCH KHỎI hàng đợi video (videoJobs) — xem docstring AIImageJob/AIVideoJob.
 * Xong không lỗi thì hỏi tiếp xác nhận "Tạo ảnh scene" (xem
 * createSceneConfirmation/confirmSceneGeneration) — KHÔNG tự động đẩy job
 * "storyboardSceneImagesAIVideo" (SCENE_SETTING) — RIÊNG type với job này,
 * xem docstring StoryboardSceneImagesAIVideoJob — để 2 bước ảnh (CHARACTER/
 * LOCATION vs SCENE_SETTING) retry được ĐỘC LẬP qua failedStoryboardJobs (nút
 * "Tiếp tục gen scene frame" chỉ retry ĐÚNG bước SCENE_SETTING, không chạy
 * lại CHARACTER/LOCATION đã xong).
 */
export interface StoryboardImagesAIVideoJob extends BaseJob {
  type: "storyboardImagesAIVideo";
  /** Path file JSON storyboard — truyền cho generateReferenceImagesForFileViaAIVideo. */
  jsonPath: string;
}

/**
 * Job "tạo ảnh SCENE_SETTING cho 1 file JSON storyboard" qua AIVideo
 * (generateSceneImagesForFileViaAIVideo) — RIÊNG type với
 * StoryboardImagesAIVideoJob (CHARACTER/LOCATION) dù cùng thuộc bước "Tạo
 * ảnh", để 2 bước theo dõi/retry ĐỘC LẬP (xem failedStoryboardJobs/
 * continueFailedStoryboardImages). Chỉ được tạo SAU KHI user bấm nút "Tạo
 * ảnh scene" xác nhận (xem createSceneConfirmation/confirmSceneGeneration —
 * gửi ngay sau khi job "storyboardImagesAIVideo"/CHARACTER/LOCATION xong
 * không lỗi). 3 lượt xác nhận nối tiếp nhau: "Tạo ảnh" (CHARACTER/LOCATION)
 * → "Tạo ảnh scene" (SCENE_SETTING) → "Tạo video". Xong không lỗi thì hỏi
 * tiếp xác nhận "Tạo video" (xem createVideoConfirmation) — KHÔNG tự động
 * đẩy job "storyboardVideo".
 */
export interface StoryboardSceneImagesAIVideoJob extends BaseJob {
  type: "storyboardSceneImagesAIVideo";
  /** Path file JSON storyboard (ảnh CHARACTER/LOCATION đã xong) — truyền cho generateSceneImagesForFileViaAIVideo. */
  jsonPath: string;
}

/**
 * 2 job "clone" của StoryboardImagesAIVideoJob/StoryboardVideoJob — GIỐNG HỆT
 * cấu trúc (cùng field, cùng ý nghĩa), CHỈ KHÁC provider gen (pollo.ai thay
 * vì AIVideo/hailuoai.video, xem generateReferenceImagesForFileViaPollo/
 * generateVideosForFilePollo trong storyboardPipeline.ts).
 *
 * KHÁC AIVideo Ở 1 ĐIỂM QUAN TRỌNG (theo yêu cầu người dùng): pipeline Pollo
 * BỎ HẲN bước "Tạo ảnh scene" (không còn StoryboardScenePolloJob/
 * generateSceneImagesForFileViaPollo) — sau khi "Tạo ảnh" (CHARACTER/
 * LOCATION) xong, đi THẲNG sang xác nhận "Tạo video" (xem
 * processPolloImageQueue), video chỉ dùng ref CHARACTER/LOCATION (xem
 * generateVideosForFilePollo).
 *
 * Theo yêu cầu người dùng: ở bước xác nhận "Tạo ảnh", user thấy SONG SONG 2
 * nút bấm (AIVideo/Pollo) và tự chọn provider — có thể trộn (vd ảnh dùng
 * AIVideo, video dùng Pollo). Theo yêu cầu người dùng (KHÔNG sửa function
 * cũ), 2 nút này đến từ 2 LƯỢT SEND MESSAGE riêng biệt của 2 hàm hoàn toàn
 * tách biệt — runStoryboardPipeline (AIVideo, GIỮ NGUYÊN không đổi) +
 * runStoryboardPipelinePollo (clone mới, gửi tin nhắn "Tạo ảnh (Pollo)"
 * riêng) — KHÔNG phải 1 tin nhắn gộp 2 nút chia sẻ 1 confirmId — xem
 * confirmImageGenerationPollo bên dưới.
 *
 * CHƯA có nút "Tiếp tục..." (retry job lỗi) riêng cho Pollo — 2 nút
 * CONTINUE_VIDEO_BUTTON_LABEL/CONTINUE_SCENE_FRAME_BUTTON_LABEL hiện tại chỉ
 * retry lại job AIVideo, ngoài phạm vi yêu cầu ban đầu (chỉ xin clone bước xác
 * nhận, không xin clone luồng retry).
 */
export interface StoryboardImagesPolloJob extends BaseJob {
  type: "storyboardImagesPollo";
  /** Path file JSON storyboard — truyền cho generateReferenceImagesForFileViaPollo. */
  jsonPath: string;
}

/**
 * GIỐNG StoryboardSceneImagesAIVideoJob HỆT (cùng field, cùng lý do tách
 * riêng type với bước CHARACTER/LOCATION) nhưng gen ảnh SCENE_SETTING_START/
 * SCENE_SETTING_END qua pollo.ai (generateSceneImagesForFileViaPollo trong
 * storyboardPipeline.ts) THAY VÌ AIVideo — KHÔI PHỤC lại bước "Tạo ảnh scene"
 * cho pipeline Pollo (đã bỏ trước đây, giờ cần lại vì schema VIDEO.ref chỉ
 * còn trỏ SCENE_SETTING_START/END, xem format_output.txt).
 *
 * Chỉ được tạo SAU KHI user bấm nút "Tạo ảnh scene" xác nhận (xem
 * createSceneConfirmationPollo/confirmSceneGenerationPollo — gửi ngay sau khi
 * job "storyboardImagesPollo" (CHARACTER/LOCATION) xong không lỗi, GIỐNG hệt
 * luồng AIVideo: "Tạo ảnh" → "Tạo ảnh scene" → "Tạo video").
 *
 * Nằm CHUNG hàng đợi ẢNH Pollo (polloImageJobs) với StoryboardImagesPolloJob —
 * cùng lý do AIVideo gộp 2 job "ảnh" (CHARACTER/LOCATION + SCENE_SETTING)
 * chung 1 hàng đợi imageJobs.
 */
export interface StoryboardSceneImagesPolloJob extends BaseJob {
  type: "storyboardScenePollo";
  /** Path file JSON storyboard (ảnh CHARACTER/LOCATION đã xong) — truyền cho generateSceneImagesForFileViaPollo. */
  jsonPath: string;
}

export interface StoryboardVideoPolloJob extends BaseJob {
  type: "storyboardVideoPollo";
  /** Path file JSON storyboard (ảnh CHARACTER/LOCATION và SCENE_SETTING_START/END phải đã xong) — truyền cho generateVideosForFilePollo. */
  jsonPath: string;
  /** Cùng ý nghĩa với StoryboardVideoJob.entryIds — không truyền = xử lý hết entry VIDEO chưa "success", có truyền = chỉ (các) entry này. */
  entryIds?: string[];
}

/**
 * GIỐNG StoryboardVideoPolloJob HỆT (cùng field, cùng ý nghĩa) nhưng gen
 * video qua ComfyUI (generateVideosForFileComfyUI trong storyboardPipeline.ts)
 * THAY VÌ pollo.ai — dùng LẠI CHÍNH ảnh SCENE_SETTING_START/END mà bước "Tạo
 * ảnh scene (Pollo)" đã tạo (ComfyUI không có bước gen ảnh riêng của chính
 * nó). Job "cả file" (không entryIds) được tạo khi user bấm nút "Tạo video
 * (Comfy)" xác nhận (xem processPolloImageQueue) — job PER-CLIP (có entryIds)
 * được TỰ ĐỘNG đẩy ngay khi 1 clip đủ ref, KHÔNG cần xác nhận (xem
 * onVideoEntriesReady trong processPolloImageQueue, nhánh "storyboardScenePollo")
 * — CHỦ Ý CHỈ auto-push cho Comfy (tự host, không tốn credit), KHÔNG auto-push
 * cho Pollo (tốn credit thật trên tài khoản pollo.ai, luôn cần bấm xác nhận
 * thủ công — theo yêu cầu người dùng).
 */
export interface StoryboardVideoComfyJob extends BaseJob {
  type: "storyboardVideoComfy";
  /** Path file JSON storyboard (ảnh SCENE_SETTING_START/END phải đã xong) — truyền cho generateVideosForFileComfyUI. */
  jsonPath: string;
  /** Cùng ý nghĩa với StoryboardVideoPolloJob.entryIds. */
  entryIds?: string[];
}

/**
 * Hàng đợi ẢNH gen bằng AIVideo (hailuoai.video) — RIÊNG với hàng đợi VIDEO
 * (AIVideoJob bên dưới), mỗi hàng đợi 1 browser tab/context xử lý tuần tự
 * độc lập với nhau (2 tab có thể mở đồng thời trên CÙNG tài khoản — chấp
 * nhận được theo yêu cầu người dùng, đổi lấy ảnh và video không phải xếp
 * hàng chờ nhau nữa).
 */
type AIImageJob =
  | ImageGenerationJob
  | StoryboardImagesAIVideoJob
  | StoryboardSceneImagesAIVideoJob;

/** Hàng đợi VIDEO gen bằng AIVideo (hailuoai.video) — xem chú thích AIImageJob ở trên. */
type AIVideoJob = VideoGenerationJob | StoryboardVideoJob;

/**
 * Hàng đợi ẢNH/VIDEO gen bằng pollo.ai — TÁCH RIÊNG hẳn khỏi AIImageJob/
 * AIVideoJob (browser context/session hoàn toàn khác, xem polloBrowser.ts),
 * chạy song song độc lập, không phải chờ hàng đợi AIVideo xử lý xong.
 */
type PolloImageJob = StoryboardImagesPolloJob | StoryboardSceneImagesPolloJob;
type PolloVideoJob = StoryboardVideoPolloJob;

/**
 * Hàng đợi VIDEO gen bằng ComfyUI — TÁCH RIÊNG khỏi PolloVideoJob (gọi thẳng
 * REST API ComfyUI, không dùng browser context nào), chạy song song độc lập
 * với mọi hàng đợi khác. Xem docstring StoryboardVideoComfyJob.
 */
type ComfyVideoJob = StoryboardVideoComfyJob;

export type GenerationJob =
  | AIImageJob
  | AIVideoJob
  | ChatAIJob
  | ScriptReferenceVideoJob
  | GenerateScriptJob
  | PolloImageJob
  | PolloVideoJob
  | ComfyVideoJob;

const IMAGE_QUEUE_FILE = path.resolve("./storage/image-queue.json");
const VIDEO_QUEUE_FILE = path.resolve("./storage/video-queue.json");
const CHATAI_QUEUE_FILE = path.resolve("./storage/chatai-queue.json");
const SCRIPT_REFERENCE_VIDEO_QUEUE_FILE = path.resolve(
  "./storage/script-reference-video-queue.json",
);
const PENDING_VIDEO_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-video-confirmations.json",
);
const PENDING_IMAGE_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-image-confirmations.json",
);
const PENDING_SCENE_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-scene-confirmations.json",
);
const PENDING_SCENE_CONFIRMATIONS_POLLO_FILE = path.resolve(
  "./storage/pending-scene-confirmations-pollo.json",
);
const FAILED_STORYBOARD_JOBS_FILE = path.resolve(
  "./storage/failed-storyboard-jobs.json",
);
const PENDING_VIDEO_CONFIRMATIONS_POLLO_FILE = path.resolve(
  "./storage/pending-video-confirmations-pollo.json",
);
const PENDING_IMAGE_CONFIRMATIONS_POLLO_FILE = path.resolve(
  "./storage/pending-image-confirmations-pollo.json",
);
const FAILED_STORYBOARD_JOBS_POLLO_FILE = path.resolve(
  "./storage/failed-storyboard-jobs-pollo.json",
);
const POLLO_IMAGE_QUEUE_FILE = path.resolve("./storage/pollo-image-queue.json");
const POLLO_VIDEO_QUEUE_FILE = path.resolve("./storage/pollo-video-queue.json");
const PENDING_VIDEO_CONFIRMATIONS_COMFY_FILE = path.resolve(
  "./storage/pending-video-confirmations-comfy.json",
);
const FAILED_STORYBOARD_JOBS_COMFY_FILE = path.resolve(
  "./storage/failed-storyboard-jobs-comfy.json",
);
const COMFY_VIDEO_QUEUE_FILE = path.resolve("./storage/comfy-video-queue.json");

// Chỉ dữ liệu thuần (không callback/ctx) nên ghi được ra file — sống sót
// qua restart/crash. Job vẫn nằm trong mảng (và trong file) SUỐT lúc xử lý,
// chỉ gỡ ra sau khi thực sự xong (thành công/lỗi) — nếu bot crash giữa
// chừng lúc generate, job vẫn còn trong file để thử lại ở lần chạy sau.
//
// 3 hàng đợi ĐỘC LẬP — ẢNH (imageJobs), VIDEO (videoJobs) và ChatAI
// (chatAIJobs) — mỗi hàng đợi 1 mảng/1 file lưu/1 vòng xử lý riêng, theo yêu
// cầu người dùng: ảnh và video (cùng gen bằng AIVideo/hailuoai.video) KHÔNG
// còn xếp chung 1 hàng đợi nữa (trước đây phải xếp chung vì "cùng 1 browser
// tab", giờ mỗi hàng đợi tự mở tab riêng khi xử lý), để job ảnh không phải
// chờ video xử lý xong mới tới lượt và ngược lại. ChatAI vẫn tách riêng như
// cũ (browser context khác hẳn, khác domain/session).
const imageJobs: AIImageJob[] = [];
let imageProcessing = false;
const videoJobs: AIVideoJob[] = [];
let videoProcessing = false;
/**
 * Job VIDEO đang thực sự được xử lý (nếu có) — hàng đợi video dùng cơ chế
 * "quét tìm job sẵn sàng" (xem processVideoQueue/findNextReadyVideoJobIndex)
 * nên job đang chạy KHÔNG chắc chắn nằm ở index 0 như hàng đợi ảnh/ChatAI
 * (FIFO đơn thuần) — cần lưu lại THAM CHIẾU trực tiếp (so bằng object
 * reference, không phải index — index có thể lệch nếu stopAll() xoá bớt
 * phần tử khác trong lúc job này đang chạy) để stopAll() biết chính xác job
 * nào đang dở, không xoá nhầm.
 */
let currentVideoJob: AIVideoJob | null = null;
// GenerateScriptJob dùng CHUNG mảng/hàng đợi này với ChatAIJob (theo yêu cầu
// người dùng — xem docstring GenerateScriptJob, enqueueJob, processChatAIQueue)
// thay vì có mảng/file lưu/vòng xử lý RIÊNG.
const chatAIJobs: (ChatAIJob | GenerateScriptJob)[] = [];
let chatAIProcessing = false;
const scriptReferenceVideoJobs: ScriptReferenceVideoJob[] = [];
let scriptReferenceVideoProcessing = false;

/**
 * 2 hàng đợi ẢNH/VIDEO gen bằng pollo.ai — TÁCH RIÊNG hẳn khỏi imageJobs/
 * videoJobs (xem chú thích PolloImageJob/PolloVideoJob), cùng cơ chế
 * persist-ra-file/resume-sau-restart với các hàng đợi AIVideo ở trên.
 * currentPolloVideoJob cùng lý do với currentVideoJob (hàng đợi video Pollo
 * cũng dùng cơ chế quét job sẵn sàng, xem processPolloVideoQueue).
 */
const polloImageJobs: PolloImageJob[] = [];
let polloImageProcessing = false;
const polloVideoJobs: PolloVideoJob[] = [];
let polloVideoProcessing = false;
let currentPolloVideoJob: PolloVideoJob | null = null;

/**
 * Hàng đợi VIDEO gen bằng ComfyUI — cùng cơ chế persist-ra-file/resume-sau-restart
 * với polloVideoJobs. currentComfyVideoJob cùng lý do với currentPolloVideoJob.
 */
const comfyVideoJobs: ComfyVideoJob[] = [];
let comfyVideoProcessing = false;
let currentComfyVideoJob: ComfyVideoJob | null = null;
let telegram: Telegram | null = null;

/** 3 loại job storyboard AIVideo có thể lỗi/cần retry riêng — xem failedStoryboardJobs. */
type FailableStoryboardJob =
  | StoryboardVideoJob
  | StoryboardImagesAIVideoJob
  | StoryboardSceneImagesAIVideoJob;

/** GIỐNG FailableStoryboardJob HỆT nhưng 2 loại job Pollo — xem failedStoryboardJobsPollo (mảng RIÊNG, không dùng chung failedStoryboardJobs). */
type FailableStoryboardJobPollo =
  | StoryboardVideoPolloJob
  | StoryboardImagesPolloJob
  | StoryboardSceneImagesPolloJob;

/**
 * Lưu lại job "storyboardVideo"/"storyboardImagesAIVideo"/
 * "storyboardSceneImagesAIVideo" NGAY sau khi xử lý xong mà có ÍT NHẤT 1
 * entry lỗi (ảnh hoặc video) — xem notifyStoryboardVideoResult/
 * notifyStoryboardImagesResult. Ghi ra file (FAILED_STORYBOARD_JOBS_FILE)
 * SAU MỖI lần thêm — sống sót qua restart/crash, GIỐNG jobs/chatAIJobs —
 * dùng để tra cứu nhanh job nào vừa lỗi, xem getFailedStoryboardJobs().
 */
const failedStoryboardJobs: FailableStoryboardJob[] = [];

export function getFailedStoryboardJobs(): FailableStoryboardJob[] {
  return failedStoryboardJobs;
}

function loadPersistedFailedStoryboardJobs(): void {
  try {
    if (!fs.existsSync(FAILED_STORYBOARD_JOBS_FILE)) return;
    const restored: FailableStoryboardJob[] = JSON.parse(
      fs.readFileSync(FAILED_STORYBOARD_JOBS_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      failedStoryboardJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job storyboard lỗi từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file job storyboard lỗi đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistFailedStoryboardJobs(): void {
  try {
    fs.mkdirSync(path.dirname(FAILED_STORYBOARD_JOBS_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      FAILED_STORYBOARD_JOBS_FILE,
      JSON.stringify(failedStoryboardJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file job storyboard lỗi:", err);
  }
}

/**
 * Thêm job vào failedStoryboardJobs (rồi ghi file ngay) — bỏ qua nếu job
 * (CÙNG object reference) đã có sẵn trong mảng, tránh trùng lặp khi nhiều
 * chỗ cùng phát hiện lỗi cho CÙNG 1 job (vd sceneResult.failed > 0 VÀ
 * notifyStoryboardVideoResult cùng gọi hàm này cho job "storyboardVideo" đó).
 */
function recordFailedStoryboardJob(job: FailableStoryboardJob): void {
  if (failedStoryboardJobs.includes(job)) return;
  failedStoryboardJobs.push(job);
  persistFailedStoryboardJobs();
}

/**
 * GIỐNG failedStoryboardJobs/getFailedStoryboardJobs/
 * loadPersistedFailedStoryboardJobs/persistFailedStoryboardJobs/
 * recordFailedStoryboardJob HỆT nhưng mảng/file RIÊNG cho job Pollo — tránh
 * lẫn lộn với failedStoryboardJobs (AIVideo), đặc biệt tránh bug tiềm ẩn nếu
 * sau này có nút "Tiếp tục..." cho Pollo: continueFailedStoryboardJob tra
 * theo jsonPath KHÔNG lọc type triệt để, nếu dùng chung 1 mảng có thể vô tình
 * nhặt nhầm job Pollo rồi ép type thành AIVideo (hoặc ngược lại).
 */
const failedStoryboardJobsPollo: FailableStoryboardJobPollo[] = [];

export function getFailedStoryboardJobsPollo(): FailableStoryboardJobPollo[] {
  return failedStoryboardJobsPollo;
}

function loadPersistedFailedStoryboardJobsPollo(): void {
  try {
    if (!fs.existsSync(FAILED_STORYBOARD_JOBS_POLLO_FILE)) return;
    const restored: FailableStoryboardJobPollo[] = JSON.parse(
      fs.readFileSync(FAILED_STORYBOARD_JOBS_POLLO_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      failedStoryboardJobsPollo.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job storyboard (Pollo) lỗi từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file job storyboard (Pollo) lỗi đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistFailedStoryboardJobsPollo(): void {
  try {
    fs.mkdirSync(path.dirname(FAILED_STORYBOARD_JOBS_POLLO_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      FAILED_STORYBOARD_JOBS_POLLO_FILE,
      JSON.stringify(failedStoryboardJobsPollo, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      "[queue] Không ghi được file job storyboard (Pollo) lỗi:",
      err,
    );
  }
}

function recordFailedStoryboardJobPollo(job: FailableStoryboardJobPollo): void {
  if (failedStoryboardJobsPollo.includes(job)) return;
  failedStoryboardJobsPollo.push(job);
  persistFailedStoryboardJobsPollo();
}

/** GIỐNG failedStoryboardJobsPollo HỆT nhưng mảng/file RIÊNG cho job ComfyUI — chỉ 1 loại job (storyboardVideoComfy, không có bước "Tạo ảnh" riêng). */
type FailableStoryboardJobComfy = StoryboardVideoComfyJob;

const failedStoryboardJobsComfy: FailableStoryboardJobComfy[] = [];

export function getFailedStoryboardJobsComfy(): FailableStoryboardJobComfy[] {
  return failedStoryboardJobsComfy;
}

function loadPersistedFailedStoryboardJobsComfy(): void {
  try {
    if (!fs.existsSync(FAILED_STORYBOARD_JOBS_COMFY_FILE)) return;
    const restored: FailableStoryboardJobComfy[] = JSON.parse(
      fs.readFileSync(FAILED_STORYBOARD_JOBS_COMFY_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      failedStoryboardJobsComfy.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job storyboard (ComfyUI) lỗi từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file job storyboard (ComfyUI) lỗi đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistFailedStoryboardJobsComfy(): void {
  try {
    fs.mkdirSync(path.dirname(FAILED_STORYBOARD_JOBS_COMFY_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      FAILED_STORYBOARD_JOBS_COMFY_FILE,
      JSON.stringify(failedStoryboardJobsComfy, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      "[queue] Không ghi được file job storyboard (ComfyUI) lỗi:",
      err,
    );
  }
}

function recordFailedStoryboardJobComfy(job: FailableStoryboardJobComfy): void {
  if (failedStoryboardJobsComfy.includes(job)) return;
  failedStoryboardJobsComfy.push(job);
  persistFailedStoryboardJobsComfy();
}

/**
 * Dùng chung cho nút "Tiếp tục tạo video" (CONTINUE_VIDEO_BUTTON_LABEL, type
 * "storyboardVideo") VÀ nút "Tiếp tục gen scene frame"
 * (CONTINUE_SCENE_FRAME_BUTTON_LABEL, type "storyboardSceneImagesAIVideo") —
 * user nhập tên file json, tra trong failedStoryboardJobs xem có job ĐÚNG
 * type đang tìm mà jsonPath chứa tên đó không (nghĩa là ĐÃ generate ảnh/video
 * trước đó nhưng lỗi giữa chừng). Lọc theo type ngay từ bước tìm — 1 file
 * json có thể có NHIỀU loại job lỗi (CHARACTER/LOCATION, SCENE_SETTING, video
 * — mỗi loại 1 lượt job riêng), mỗi nút chỉ được retry ĐÚNG loại lỗi tương
 * ứng, tránh nhầm lẫn.
 * PHẢI thoả CẢ 2 điều kiện mới cho tiếp tục:
 * 1. Folder generated/<tên file>/ tồn tại trên đĩa (đã từng xử lý qua, không
 *    phải gõ nhầm tên file chưa tồn tại bao giờ).
 * 2. Có job ĐÚNG type trong failedStoryboardJobs khớp tên (đã lỗi, cần retry
 *    — job chưa từng lỗi hoặc đã xong rồi thì không có gì để "tiếp tục").
 *
 * Nếu thoả cả 2: xoá job đó khỏi failedStoryboardJobs rồi enqueue LẠI CHÍNH
 * job đó, GIỮ NGUYÊN type gốc (chatId/promptMessageId/jsonPath cũng giữ
 * nguyên) — mỗi job PHẢI retry lại ĐÚNG hàng đợi gốc (ảnh hay video) — đổi
 * type sai sẽ khiến job kẹt vĩnh viễn (vd job "storyboardSceneImagesAIVideo"
 * cũ mà gán nhầm type "storyboardVideo" thì generateVideosForFile không đụng
 * tới entry SCENE_SETTING nào cả, mà hàng đợi video lại luôn chờ đúng các
 * entry đó "success": true mới xử lý — xem processVideoQueue).
 * generateReferenceImagesForFileViaAIVideo/generateSceneImagesForFileViaAIVideo/
 * generateVideosForFile đều tự resume theo field "success" trên từng entry,
 * xem storyboardPipeline.ts. Trả về false nếu không thoả — caller
 * (handlers.ts) tự báo "chưa được xử lý, không thể tiếp tục".
 */
function continueFailedStoryboardJob(
  jsonFileName: string,
  type: FailableStoryboardJob["type"],
): boolean {
  const folderExists = fs.existsSync(generatedDirFor(jsonFileName));
  const failedIndex = failedStoryboardJobs.findIndex((j) =>
    j.jsonPath.includes(jsonFileName),
  );
  if (!folderExists || failedIndex === -1) {
    return false;
  }

  const [failedJob] = failedStoryboardJobs.splice(failedIndex, 1);
  failedJob.type = type;
  persistFailedStoryboardJobs();

  enqueueJob(failedJob);
  return true;
}

/** Nút "Tiếp tục tạo video" (xem CONTINUE_VIDEO_BUTTON_LABEL) — chỉ retry job "storyboardVideo" lỗi. */
export function continueFailedStoryboardVideo(jsonFileName: string): boolean {
  return continueFailedStoryboardJob(jsonFileName, "storyboardVideo");
}

/** Nút "Tiếp tục gen scene frame" (xem CONTINUE_SCENE_FRAME_BUTTON_LABEL) — chỉ retry job "storyboardSceneImagesAIVideo" (SCENE_SETTING) lỗi. */
export function continueFailedStoryboardImages(jsonFileName: string): boolean {
  return continueFailedStoryboardJob(
    jsonFileName,
    "storyboardSceneImagesAIVideo",
  );
}

/**
 * GIỐNG continueFailedStoryboardJob HỆT (cùng 2 điều kiện: folder generated/
 * tồn tại + có job ĐÚNG type khớp tên trong danh sách lỗi) nhưng thao tác
 * trên failedStoryboardJobsPollo/persistFailedStoryboardJobsPollo (mảng
 * RIÊNG của Pollo, không dùng chung failedStoryboardJobs) — theo đúng quy
 * ước "clone riêng, không share" đã áp dụng xuyên suốt cho toàn bộ pipeline
 * Pollo trong file này. enqueueJob đã tự biết route "storyboardVideoPollo"
 * vào đúng polloVideoJobs (xem enqueueJob).
 */
function continueFailedStoryboardJobPollo(
  jsonFileName: string,
  type: FailableStoryboardJobPollo["type"],
): boolean {
  const folderExists = fs.existsSync(generatedDirFor(jsonFileName));
  const failedIndex = failedStoryboardJobsPollo.findIndex(
    (j) => j.jsonPath.includes(jsonFileName),
  );
  if (!folderExists || failedIndex === -1) {
    return false;
  }

  const [failedJob] = failedStoryboardJobsPollo.splice(failedIndex, 1);
  persistFailedStoryboardJobsPollo();

  enqueueJob(failedJob);
  return true;
}

/** Bản Pollo của continueFailedStoryboardVideo — chỉ retry job "storyboardVideoPollo" lỗi (mảng failedStoryboardJobsPollo riêng). */
export function continueFailedStoryboardVideoPollo(jsonFileName: string): boolean {
  return continueFailedStoryboardJobPollo(jsonFileName, "storyboardVideoPollo");
}

/**
 * GIỐNG continueFailedStoryboardJobPollo HỆT nhưng thao tác trên
 * failedStoryboardJobsComfy/persistFailedStoryboardJobsComfy (mảng RIÊNG của
 * ComfyUI). CHƯA có nút "Tiếp tục..." gọi hàm này trong handlers.ts — cùng
 * tình trạng với continueFailedStoryboardVideoPollo (xem docstring
 * StoryboardImagesPolloJob) — export sẵn để dùng khi cần.
 */
function continueFailedStoryboardJobComfy(
  jsonFileName: string,
  type: FailableStoryboardJobComfy["type"],
): boolean {
  const folderExists = fs.existsSync(generatedDirFor(jsonFileName));
  const failedIndex = failedStoryboardJobsComfy.findIndex((j) =>
    j.jsonPath.includes(jsonFileName),
  );
  if (!folderExists || failedIndex === -1) {
    return false;
  }

  const [failedJob] = failedStoryboardJobsComfy.splice(failedIndex, 1);
  persistFailedStoryboardJobsComfy();

  enqueueJob(failedJob);
  return true;
}

/** Bản ComfyUI của continueFailedStoryboardVideo — chỉ retry job "storyboardVideoComfy" lỗi (mảng failedStoryboardJobsComfy riêng). */
export function continueFailedStoryboardVideoComfy(jsonFileName: string): boolean {
  return continueFailedStoryboardJobComfy(jsonFileName, "storyboardVideoComfy");
}

/** Gọi 1 lần lúc khởi động bot, trước khi có prompt nào được gửi. */
export function initQueue(botTelegram: Telegram): void {
  telegram = botTelegram;
  loadPersistedImageJobs();
  loadPersistedVideoJobs();
  loadPersistedChatAIJobs();
  loadPersistedScriptReferenceVideoJobs();
  loadPersistedPolloImageJobs();
  loadPersistedPolloVideoJobs();
  loadPersistedComfyVideoJobs();
  loadPersistedPendingVideoConfirmations();
  loadPersistedPendingImageConfirmations();
  loadPersistedPendingSceneConfirmations();
  loadPersistedPendingSceneConfirmationsPollo();
  loadPersistedPendingVideoConfirmationsPollo();
  loadPersistedPendingImageConfirmationsPollo();
  loadPersistedPendingVideoConfirmationsComfy();
  loadPersistedFailedStoryboardJobs();
  loadPersistedFailedStoryboardJobsPollo();
  loadPersistedFailedStoryboardJobsComfy();
  loadPersistedStopStoryboardRequests();
  void processImageQueue();
  void processVideoQueue();
  void processChatAIQueue();
  void processScriptReferenceVideoQueue();
  void processPolloImageQueue();
  void processPolloVideoQueue();
  void processComfyVideoQueue();
}

function loadPersistedImageJobs(): void {
  try {
    if (!fs.existsSync(IMAGE_QUEUE_FILE)) return;
    const restored: AIImageJob[] = JSON.parse(
      fs.readFileSync(IMAGE_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      imageJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job ảnh còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi ảnh đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistImageJobs(): void {
  try {
    fs.mkdirSync(path.dirname(IMAGE_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      IMAGE_QUEUE_FILE,
      JSON.stringify(imageJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi ảnh:", err);
  }
}

function loadPersistedVideoJobs(): void {
  try {
    if (!fs.existsSync(VIDEO_QUEUE_FILE)) return;
    const restored: AIVideoJob[] = JSON.parse(
      fs.readFileSync(VIDEO_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      videoJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job video còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi video đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistVideoJobs(): void {
  try {
    fs.mkdirSync(path.dirname(VIDEO_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      VIDEO_QUEUE_FILE,
      JSON.stringify(videoJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi video:", err);
  }
}

function loadPersistedPolloImageJobs(): void {
  try {
    if (!fs.existsSync(POLLO_IMAGE_QUEUE_FILE)) return;
    const restored: PolloImageJob[] = JSON.parse(
      fs.readFileSync(POLLO_IMAGE_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      polloImageJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job ảnh Pollo còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi ảnh Pollo đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistPolloImageJobs(): void {
  try {
    fs.mkdirSync(path.dirname(POLLO_IMAGE_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      POLLO_IMAGE_QUEUE_FILE,
      JSON.stringify(polloImageJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi ảnh Pollo:", err);
  }
}

function loadPersistedPolloVideoJobs(): void {
  try {
    if (!fs.existsSync(POLLO_VIDEO_QUEUE_FILE)) return;
    const restored: PolloVideoJob[] = JSON.parse(
      fs.readFileSync(POLLO_VIDEO_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      polloVideoJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job video Pollo còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi video Pollo đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistPolloVideoJobs(): void {
  try {
    fs.mkdirSync(path.dirname(POLLO_VIDEO_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      POLLO_VIDEO_QUEUE_FILE,
      JSON.stringify(polloVideoJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi video Pollo:", err);
  }
}

function loadPersistedComfyVideoJobs(): void {
  try {
    if (!fs.existsSync(COMFY_VIDEO_QUEUE_FILE)) return;
    const restored: ComfyVideoJob[] = JSON.parse(
      fs.readFileSync(COMFY_VIDEO_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      comfyVideoJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job video ComfyUI còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi video ComfyUI đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistComfyVideoJobs(): void {
  try {
    fs.mkdirSync(path.dirname(COMFY_VIDEO_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      COMFY_VIDEO_QUEUE_FILE,
      JSON.stringify(comfyVideoJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi video ComfyUI:", err);
  }
}

function loadPersistedChatAIJobs(): void {
  try {
    if (!fs.existsSync(CHATAI_QUEUE_FILE)) return;
    const restored: (ChatAIJob | GenerateScriptJob)[] = JSON.parse(
      fs.readFileSync(CHATAI_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      chatAIJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job ChatAI còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi ChatAI đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistChatAIJobs(): void {
  try {
    fs.mkdirSync(path.dirname(CHATAI_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(
      CHATAI_QUEUE_FILE,
      JSON.stringify(chatAIJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi ChatAI:", err);
  }
}

function loadPersistedScriptReferenceVideoJobs(): void {
  try {
    if (!fs.existsSync(SCRIPT_REFERENCE_VIDEO_QUEUE_FILE)) return;
    const restored: ScriptReferenceVideoJob[] = JSON.parse(
      fs.readFileSync(SCRIPT_REFERENCE_VIDEO_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      scriptReferenceVideoJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job "Tham chiếu kịch bản" còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file hàng đợi "Tham chiếu kịch bản" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistScriptReferenceVideoJobs(): void {
  try {
    fs.mkdirSync(path.dirname(SCRIPT_REFERENCE_VIDEO_QUEUE_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      SCRIPT_REFERENCE_VIDEO_QUEUE_FILE,
      JSON.stringify(scriptReferenceVideoJobs, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file hàng đợi "Tham chiếu kịch bản":',
      err,
    );
  }
}

/**
 * Kiểm tra hàng đợi ẢNH/VIDEO đã có job ĐÚNG type + jsonPath này chưa (đang
 * CHỜ hoặc đang XỬ LÝ — job đang xử lý dở vẫn còn nằm trong mảng tới lúc
 * finally mới bị xoá, xem processImageQueue/processVideoQueue) — dùng để
 * tránh enqueue TRÙNG (xem tryRegenerateStoryboardItem trong handlers.ts VÀ
 * onVideoEntriesReady trong processImageQueue): job storyboard "cả file"
 * luôn xử lý LẠI TOÀN BỘ entry "success" chưa true trong file (xem
 * storyboardPipeline.ts), nên nếu đã có 1 job cùng type+jsonPath trong hàng
 * đợi, job đó tự khắc nhặt luôn entry vừa đánh dấu lại khi tới lượt — không
 * cần thêm job thứ 2 (chỉ tổ chạy trùng, tốn gấp đôi thời gian/credit).
 * Resolve path trước khi so sánh — cùng 1 file có thể truyền vào dưới dạng
 * path tương đối/tuyệt đối khác nhau tuỳ nơi gọi.
 *
 * entryId (chỉ áp dụng cho type "storyboardVideo", job per-clip — xem
 * StoryboardVideoJob.entryIds): nếu truyền, so khớp CHÍNH XÁC entry đó thay
 * vì chỉ so type+jsonPath — 2 clip khác nhau CÙNG file phải được coi là 2
 * job KHÁC NHAU (không job nào "bao phủ" job kia), trừ khi gặp 1 job "cả
 * file" (entryIds rỗng/không có) đang chờ/xử lý — job đó chắc chắn sẽ xử lý
 * TỚI entry này nên coi như đã trùng, không cần thêm job per-clip nữa.
 */
export function isStoryboardJobQueued(
  type:
    | "storyboardImagesAIVideo"
    | "storyboardSceneImagesAIVideo"
    | "storyboardImagesPollo"
    | "storyboardVideoPollo"
    | "storyboardVideoComfy"
    | "storyboardVideo",
  jsonPath: string,
  entryId?: string,
): boolean {
  const resolvedPath = path.resolve(jsonPath);
  if (type === "storyboardVideo") {
    return videoJobs.some((job) => {
      if (job.type !== "storyboardVideo") return false;
      if (path.resolve(job.jsonPath) !== resolvedPath) return false;
      if (!entryId) return true;
      if (!job.entryIds || job.entryIds.length === 0) return true;
      return job.entryIds.includes(entryId);
    });
  }
  return imageJobs.some(
    (job) => job.type === type && path.resolve(job.jsonPath) === resolvedPath,
  );
}

/**
 * GIỐNG isStoryboardJobQueued HỆT (cùng logic resolve path/entryId) nhưng
 * quét polloImageJobs/polloVideoJobs (2 type Pollo) — hàm RIÊNG, KHÔNG dùng
 * chung với isStoryboardJobQueued (AIVideo), theo đúng yêu cầu
 * clone-logic-không-dùng-chung-function-cũ.
 */
export function isPolloStoryboardJobQueued(
  type: "storyboardImagesPollo" | "storyboardVideoPollo",
  jsonPath: string,
  entryId?: string,
): boolean {
  const resolvedPath = path.resolve(jsonPath);
  if (type === "storyboardVideoPollo") {
    return polloVideoJobs.some((job) => {
      if (job.type !== "storyboardVideoPollo") return false;
      if (path.resolve(job.jsonPath) !== resolvedPath) return false;
      if (!entryId) return true;
      if (!job.entryIds || job.entryIds.length === 0) return true;
      return job.entryIds.includes(entryId);
    });
  }
  return polloImageJobs.some(
    (job) => job.type === type && path.resolve(job.jsonPath) === resolvedPath,
  );
}

/**
 * GIỐNG isPolloStoryboardJobQueued (nhánh "storyboardVideoPollo") HỆT nhưng
 * quét comfyVideoJobs — dùng để tránh đẩy TRÙNG job "storyboardVideoComfy"
 * per-clip khi auto-push (xem onVideoEntriesReady trong processPolloImageQueue,
 * nhánh "storyboardScenePollo").
 */
function isComfyStoryboardJobQueued(jsonPath: string, entryId?: string): boolean {
  const resolvedPath = path.resolve(jsonPath);
  return comfyVideoJobs.some((job) => {
    if (path.resolve(job.jsonPath) !== resolvedPath) return false;
    if (!entryId) return true;
    if (!job.entryIds || job.entryIds.length === 0) return true;
    return job.entryIds.includes(entryId);
  });
}

/**
 * Đẩy job vào ĐÚNG hàng đợi theo loại — ảnh, video, ChatAI mỗi loại 1 hàng
 * đợi riêng (xem chú thích AIImageJob/AIVideoJob), chạy độc lập không phải
 * chờ nhau.
 */
export function enqueueJob(job: GenerationJob): void {
  // Theo yêu cầu người dùng: "generateScript" dùng CHUNG hàng đợi với
  // "chatAI" (chatAIJobs/processChatAIQueue) — KHÔNG có mảng/hàng đợi riêng
  // (xem docstring GenerateScriptJob).
  if (job.type === "chatAI" || job.type === "generateScript") {
    chatAIJobs.push(job);
    persistChatAIJobs();
    void processChatAIQueue();
    return;
  }
  if (job.type === "scriptReferenceVideo") {
    scriptReferenceVideoJobs.push(job);
    persistScriptReferenceVideoJobs();
    void processScriptReferenceVideoQueue();
    return;
  }
  if (
    job.type === "image" ||
    job.type === "storyboardImagesAIVideo" ||
    job.type === "storyboardSceneImagesAIVideo"
  ) {
    imageJobs.push(job);
    persistImageJobs();
    void processImageQueue();
    return;
  }
  if (job.type === "storyboardImagesPollo" || job.type === "storyboardScenePollo") {
    polloImageJobs.push(job);
    persistPolloImageJobs();
    void processPolloImageQueue();
    return;
  }
  if (job.type === "storyboardVideoPollo") {
    polloVideoJobs.push(job);
    persistPolloVideoJobs();
    void processPolloVideoQueue();
    return;
  }
  if (job.type === "storyboardVideoComfy") {
    comfyVideoJobs.push(job);
    persistComfyVideoJobs();
    void processComfyVideoQueue();
    return;
  }
  videoJobs.push(job);
  persistVideoJobs();
  void processVideoQueue();
}

export interface StopAllResult {
  cancelledChatAIJobs: number;
  /** Job "video" (characterImagePath, từ CHARACTER_REF_BUTTON_LABEL), "storyboardVideo" VÀ "storyboardImagesAIVideo" (nút "Tạo ảnh"/"Tạo video" xác nhận) còn đang chờ, đã huỷ. */
  cancelledVideoJobs: number;
}

/**
 * Nút "Stop All" (xem STOP_ALL_BUTTON_LABEL trong keyboard.ts) — dừng SỚM
 * các job của CHARACTER_REF_BUTTON_LABEL (job "video" có characterImagePath),
 * CHATAI_BUTTON_LABEL/CHATAI_CHECK_BUTTON_LABEL (toàn bộ hàng đợi ChatAI), VÀ
 * job "storyboardImagesAIVideo"/"storyboardVideo" (từ nút "Tạo ảnh"/"Tạo
 * video" xác nhận — cả 2 chế độ ChatAI giờ dùng chung luồng xác nhận này).
 *
 * Theo YÊU CẦU NGƯỜI DÙNG: CHỈ dừng job của ĐÚNG userId đã bấm nút — job của
 * user khác (dù đang chờ hay đang xử lý dở, kể cả đang ở index 0/
 * currentVideoJob) hoàn toàn KHÔNG bị đụng tới. Lọc theo `job.userId` ở MỌI
 * bước dưới đây thay vì xoá/dừng mù quáng toàn bộ hàng đợi như trước.
 *
 * 1. Nếu job ĐANG xử lý dở (index 0 hàng đợi ảnh / currentVideoJob hàng đợi
 *    video) là job storyboard (có jsonPath) VÀ thuộc đúng userId: gọi
 *    requestStopStoryboardPipeline(jsonPath) — báo hiệu ĐÚNG vòng lặp
 *    generateReferenceImagesForFileViaAIVideo/generateSceneImagesForFileViaAIVideo/
 *    generateVideosForFile của job đó dừng SAU KHI entry đang generate dở
 *    xong (không abort giữa chừng) — xem docstring hàm này trong
 *    storyboardPipeline.ts. Job storyboard đang chạy của user KHÁC không bị
 *    gọi hàm này nên không hề bị ảnh hưởng.
 * 2. Xoá các job ChatAI ĐÚNG userId còn đang CHỜ trong hàng đợi (chưa tới lượt
 *    xử lý) — job ChatAI ĐANG xử lý dở (index 0, nếu chatAIProcessing) không
 *    thể huỷ giữa chừng askChatAI dù có đúng userId hay không.
 * 3. Xoá job "storyboardImagesAIVideo"/"storyboardSceneImagesAIVideo" ĐÚNG
 *    userId còn đang CHỜ trong hàng đợi ẢNH — job ĐANG xử lý dở (index 0, nếu
 *    imageProcessing) không thể huỷ giữa chừng generateImage trên AIVideo, để
 *    chạy xong/lỗi tự nhiên (vòng lặp gen nhiều entry bên trong nó vẫn dừng
 *    sớm được qua bước 1 ở trên NẾU đúng userId).
 * 4. Xoá job "video" có characterImagePath (từ CHARACTER_REF_BUTTON_LABEL) VÀ
 *    "storyboardVideo" ĐÚNG userId còn đang CHỜ trong hàng đợi VIDEO — job
 *    ĐANG xử lý dở (currentVideoJob, KHÔNG CHẮC ở index 0 vì hàng đợi video
 *    dùng cơ chế quét/bỏ qua, xem processVideoQueue) không thể huỷ giữa
 *    chừng, để chạy xong/lỗi tự nhiên.
 *
 * Báo cho từng user có job bị huỷ biết (reply đúng tin nhắn prompt gốc).
 */
export function stopAll(userId: number): StopAllResult {
  const currentImageJob = imageProcessing ? imageJobs[0] : undefined;
  if (
    currentImageJob &&
    currentImageJob.userId === userId &&
    (currentImageJob.type === "storyboardImagesAIVideo" ||
      currentImageJob.type === "storyboardSceneImagesAIVideo")
  ) {
    requestStopStoryboardPipeline(currentImageJob.jsonPath);
  }
  if (
    currentVideoJob &&
    currentVideoJob.userId === userId &&
    currentVideoJob.type === "storyboardVideo"
  ) {
    requestStopStoryboardPipeline(currentVideoJob.jsonPath);
  }

  // Cùng cơ chế với hàng đợi AIVideo ở trên, áp dụng cho hàng đợi Pollo
  // (xem chú thích PolloImageJob/PolloVideoJob) — job storyboard đang xử lý
  // dở CỦA ĐÚNG user thì báo dừng sớm, không đụng job của user khác.
  const currentPolloImageJob = polloImageProcessing
    ? polloImageJobs[0]
    : undefined;
  if (currentPolloImageJob && currentPolloImageJob.userId === userId) {
    requestStopStoryboardPipeline(currentPolloImageJob.jsonPath);
  }
  if (currentPolloVideoJob && currentPolloVideoJob.userId === userId) {
    requestStopStoryboardPipeline(currentPolloVideoJob.jsonPath);
  }
  if (currentComfyVideoJob && currentComfyVideoJob.userId === userId) {
    requestStopStoryboardPipeline(currentComfyVideoJob.jsonPath);
  }

  const cancelledChatAIJobs: (
    | ChatAIJob
    | ScriptReferenceVideoJob
    | GenerateScriptJob
  )[] = [];
  const chatAIStartIndex = chatAIProcessing ? 1 : 0;
  for (let i = chatAIJobs.length - 1; i >= chatAIStartIndex; i--) {
    if (chatAIJobs[i].userId === userId) {
      cancelledChatAIJobs.push(chatAIJobs[i]);
      chatAIJobs.splice(i, 1);
    }
  }
  if (cancelledChatAIJobs.length > 0) persistChatAIJobs();

  // Cùng cơ chế với hàng đợi ChatAI ở trên, áp dụng cho job "Tham chiếu kịch
  // bản" (xem ScriptReferenceVideoJob) — job ĐANG xử lý dở (index 0) không
  // bị huỷ, chỉ huỷ job còn đang CHỜ của đúng userId.
  const scriptReferenceVideoStartIndex = scriptReferenceVideoProcessing
    ? 1
    : 0;
  for (
    let i = scriptReferenceVideoJobs.length - 1;
    i >= scriptReferenceVideoStartIndex;
    i--
  ) {
    if (scriptReferenceVideoJobs[i].userId === userId) {
      const [cancelled] = scriptReferenceVideoJobs.splice(i, 1);
      cancelledChatAIJobs.push(cancelled);
      fsp.unlink(cancelled.videoPath).catch(() => {});
    }
  }
  if (
    cancelledChatAIJobs.some((job) => job.type === "scriptReferenceVideo")
  ) {
    persistScriptReferenceVideoJobs();
  }

  // KHÔNG cần đoạn riêng cho "Tạo kịch bản mới" (GenerateScriptJob) — job
  // này dùng CHUNG mảng chatAIJobs với "chatAI" (xem enqueueJob) nên vòng
  // lặp huỷ chatAIJobs ở trên đã tự bao phủ luôn.

  const cancelledOtherJobs: (
    | AIImageJob
    | AIVideoJob
    | PolloImageJob
    | PolloVideoJob
    | ComfyVideoJob
  )[] = [];

  const imageStartIndex = imageProcessing ? 1 : 0;
  for (let i = imageJobs.length - 1; i >= imageStartIndex; i--) {
    const job = imageJobs[i];
    if (
      (job.type === "storyboardImagesAIVideo" ||
        job.type === "storyboardSceneImagesAIVideo") &&
      job.userId === userId
    ) {
      cancelledOtherJobs.push(job);
      imageJobs.splice(i, 1);
    }
  }
  persistImageJobs();

  for (let i = videoJobs.length - 1; i >= 0; i--) {
    const job = videoJobs[i];
    if (job === currentVideoJob) continue;
    if (
      ((job.type === "video" && job.characterImagePath) ||
        job.type === "storyboardVideo") &&
      job.userId === userId
    ) {
      cancelledOtherJobs.push(job);
      videoJobs.splice(i, 1);
    }
  }
  persistVideoJobs();

  const polloImageStartIndex = polloImageProcessing ? 1 : 0;
  for (let i = polloImageJobs.length - 1; i >= polloImageStartIndex; i--) {
    const job = polloImageJobs[i];
    if (job.userId === userId) {
      cancelledOtherJobs.push(job);
      polloImageJobs.splice(i, 1);
    }
  }
  persistPolloImageJobs();

  for (let i = polloVideoJobs.length - 1; i >= 0; i--) {
    const job = polloVideoJobs[i];
    if (job === currentPolloVideoJob) continue;
    if (job.userId === userId) {
      cancelledOtherJobs.push(job);
      polloVideoJobs.splice(i, 1);
    }
  }
  persistPolloVideoJobs();

  for (let i = comfyVideoJobs.length - 1; i >= 0; i--) {
    const job = comfyVideoJobs[i];
    if (job === currentComfyVideoJob) continue;
    if (job.userId === userId) {
      cancelledOtherJobs.push(job);
      comfyVideoJobs.splice(i, 1);
    }
  }
  persistComfyVideoJobs();

  for (const job of [...cancelledChatAIJobs, ...cancelledOtherJobs]) {
    void notifyJobCancelled(job);
  }

  return {
    cancelledChatAIJobs: cancelledChatAIJobs.length,
    cancelledVideoJobs: cancelledOtherJobs.length,
  };
}

async function notifyJobCancelled(job: GenerationJob): Promise<void> {
  if (!telegram) return;
  // await telegram
  //   .sendMessage(job.chatId, "🛑 Đã huỷ theo yêu cầu Stop All.", {
  //     reply_parameters: { message_id: job.promptMessageId },
  //   })
  //   .catch(() => {});
  // await deleteStatusMessage(job);
}

interface PendingVideoConfirmation {
  jsonPath: string;
  chatId: number;
  userId: number;
  promptMessageId: number;
}

// Ghi ra file (PENDING_VIDEO_CONFIRMATIONS_FILE) SAU MỖI lần thêm/xoá — sống
// sót qua restart/crash, GIỐNG jobs/chatAIJobs: nếu bot restart trước khi
// user bấm nút "Tạo video", nút bấm ở tin nhắn CŨ (đã gửi trước đó) vẫn còn
// hiệu lực sau khi bot khởi động lại, không cần hỏi ChatAI lại từ đầu.
const pendingVideoConfirmations = new Map<string, PendingVideoConfirmation>();

function loadPersistedPendingVideoConfirmations(): void {
  try {
    if (!fs.existsSync(PENDING_VIDEO_CONFIRMATIONS_FILE)) return;
    const restored: [string, PendingVideoConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_VIDEO_CONFIRMATIONS_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingVideoConfirmations.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo video" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo video" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingVideoConfirmations(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_VIDEO_CONFIRMATIONS_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_VIDEO_CONFIRMATIONS_FILE,
      JSON.stringify(Array.from(pendingVideoConfirmations.entries()), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo video":',
      err,
    );
  }
}

/** Tạo 1 lượt chờ xác nhận "Tạo video" cho jsonPath, trả về id ngắn dùng làm callback_data của nút (xem handlers.ts). */
export function createVideoConfirmation(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingVideoConfirmations.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingVideoConfirmations();
  return confirmId;
}

/**
 * User bấm nút "Tạo video" — tra lại jsonPath theo confirmId rồi đẩy job
 * "storyboardVideo" vào hàng đợi AIVideo (xem StoryboardVideoJob).
 * Trả về false nếu confirmId không tồn tại/đã dùng (vd bấm 2 lần) — caller
 * (handlers.ts) tự báo lỗi phù hợp.
 */
export function confirmVideoGeneration(confirmId: string): boolean {
  const pending = pendingVideoConfirmations.get(confirmId);
  if (!pending) return false;
  pendingVideoConfirmations.delete(confirmId);
  persistPendingVideoConfirmations();
  enqueueJob({
    type: "storyboardVideo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

/**
 * GIỐNG PendingVideoConfirmation/pendingVideoConfirmations/
 * loadPersistedPendingVideoConfirmations/persistPendingVideoConfirmations/
 * createVideoConfirmation HỆT nhưng map/file RIÊNG cho Pollo — KHÔNG dùng
 * chung pendingVideoConfirmations (AIVideo) nữa, theo đúng yêu cầu
 * clone-logic-không-dùng-chung-function-cũ.
 */
const pendingVideoConfirmationsPollo = new Map<
  string,
  PendingVideoConfirmation
>();

function loadPersistedPendingVideoConfirmationsPollo(): void {
  try {
    if (!fs.existsSync(PENDING_VIDEO_CONFIRMATIONS_POLLO_FILE)) return;
    const restored: [string, PendingVideoConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_VIDEO_CONFIRMATIONS_POLLO_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingVideoConfirmationsPollo.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo video (Pollo)" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo video (Pollo)" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingVideoConfirmationsPollo(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_VIDEO_CONFIRMATIONS_POLLO_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_VIDEO_CONFIRMATIONS_POLLO_FILE,
      JSON.stringify(
        Array.from(pendingVideoConfirmationsPollo.entries()),
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo video (Pollo)":',
      err,
    );
  }
}

/** GIỐNG createVideoConfirmation hệt nhưng ghi vào pendingVideoConfirmationsPollo (map riêng) — dùng cho nút "Tạo video (Pollo)". */
export function createVideoConfirmationPollo(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingVideoConfirmationsPollo.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingVideoConfirmationsPollo();
  return confirmId;
}

/**
 * GIỐNG confirmVideoGeneration hệt nhưng đẩy job "storyboardVideoPollo" (dùng
 * pollo.ai) thay vì "storyboardVideo" (AIVideo), đọc từ
 * pendingVideoConfirmationsPollo (map RIÊNG, KHÔNG dùng chung
 * pendingVideoConfirmations của AIVideo nữa).
 */
export function confirmVideoGenerationPollo(confirmId: string): boolean {
  const pending = pendingVideoConfirmationsPollo.get(confirmId);
  if (!pending) return false;
  pendingVideoConfirmationsPollo.delete(confirmId);
  persistPendingVideoConfirmationsPollo();
  enqueueJob({
    type: "storyboardVideoPollo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

// GIỐNG pendingVideoConfirmationsPollo HỆT nhưng map RIÊNG cho nút "Tạo
// video (Comfy)" — dùng chung interface PendingVideoConfirmation (cùng field).
const pendingVideoConfirmationsComfy = new Map<
  string,
  PendingVideoConfirmation
>();

function loadPersistedPendingVideoConfirmationsComfy(): void {
  try {
    if (!fs.existsSync(PENDING_VIDEO_CONFIRMATIONS_COMFY_FILE)) return;
    const restored: [string, PendingVideoConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_VIDEO_CONFIRMATIONS_COMFY_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingVideoConfirmationsComfy.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo video (Comfy)" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo video (Comfy)" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingVideoConfirmationsComfy(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_VIDEO_CONFIRMATIONS_COMFY_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_VIDEO_CONFIRMATIONS_COMFY_FILE,
      JSON.stringify(
        Array.from(pendingVideoConfirmationsComfy.entries()),
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo video (Comfy)":',
      err,
    );
  }
}

/** GIỐNG createVideoConfirmationPollo hệt nhưng ghi vào pendingVideoConfirmationsComfy (map riêng) — dùng cho nút "Tạo video (Comfy)". */
export function createVideoConfirmationComfy(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingVideoConfirmationsComfy.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingVideoConfirmationsComfy();
  return confirmId;
}

/**
 * GIỐNG confirmVideoGenerationPollo hệt nhưng đẩy job "storyboardVideoComfy"
 * (dùng ComfyUI) thay vì "storyboardVideoPollo", đọc từ
 * pendingVideoConfirmationsComfy (map RIÊNG).
 */
export function confirmVideoGenerationComfy(confirmId: string): boolean {
  const pending = pendingVideoConfirmationsComfy.get(confirmId);
  if (!pending) return false;
  pendingVideoConfirmationsComfy.delete(confirmId);
  persistPendingVideoConfirmationsComfy();
  enqueueJob({
    type: "storyboardVideoComfy",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

interface PendingImageConfirmation {
  jsonPath: string;
  chatId: number;
  userId: number;
  promptMessageId: number;
}

// Cùng cơ chế/lý do với pendingVideoConfirmations ở trên (ghi ra file, sống
// sót qua restart).
const pendingImageConfirmations = new Map<string, PendingImageConfirmation>();

function loadPersistedPendingImageConfirmations(): void {
  try {
    if (!fs.existsSync(PENDING_IMAGE_CONFIRMATIONS_FILE)) return;
    const restored: [string, PendingImageConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_IMAGE_CONFIRMATIONS_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingImageConfirmations.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo ảnh" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo ảnh" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingImageConfirmations(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_IMAGE_CONFIRMATIONS_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_IMAGE_CONFIRMATIONS_FILE,
      JSON.stringify(Array.from(pendingImageConfirmations.entries()), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo ảnh":',
      err,
    );
  }
}

/** Tạo 1 lượt chờ xác nhận "Tạo ảnh" cho jsonPath, trả về id ngắn dùng làm callback_data của nút (xem handlers.ts). */
export function createImageConfirmation(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingImageConfirmations.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingImageConfirmations();
  return confirmId;
}

/**
 * User bấm nút "Tạo ảnh" — tra lại jsonPath theo confirmId rồi đẩy job
 * "storyboardImagesAIVideo" vào hàng đợi AIVideo (xem StoryboardImagesAIVideoJob).
 * Trả về false nếu confirmId không tồn tại/đã dùng, cùng lý do với
 * confirmVideoGeneration.
 */
export function confirmImageGeneration(confirmId: string): boolean {
  const pending = pendingImageConfirmations.get(confirmId);
  if (!pending) return false;
  pendingImageConfirmations.delete(confirmId);
  persistPendingImageConfirmations();
  enqueueJob({
    type: "storyboardImagesAIVideo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

/**
 * GIỐNG PendingImageConfirmation/pendingImageConfirmations/
 * loadPersistedPendingImageConfirmations/persistPendingImageConfirmations/
 * createImageConfirmation HỆT nhưng map/file RIÊNG cho Pollo — KHÔNG dùng
 * chung pendingImageConfirmations (AIVideo) nữa.
 */
const pendingImageConfirmationsPollo = new Map<
  string,
  PendingImageConfirmation
>();

function loadPersistedPendingImageConfirmationsPollo(): void {
  try {
    if (!fs.existsSync(PENDING_IMAGE_CONFIRMATIONS_POLLO_FILE)) return;
    const restored: [string, PendingImageConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_IMAGE_CONFIRMATIONS_POLLO_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingImageConfirmationsPollo.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo ảnh (Pollo)" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo ảnh (Pollo)" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingImageConfirmationsPollo(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_IMAGE_CONFIRMATIONS_POLLO_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_IMAGE_CONFIRMATIONS_POLLO_FILE,
      JSON.stringify(
        Array.from(pendingImageConfirmationsPollo.entries()),
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo ảnh (Pollo)":',
      err,
    );
  }
}

/** GIỐNG createImageConfirmation hệt nhưng ghi vào pendingImageConfirmationsPollo (map riêng) — dùng cho nút "Tạo ảnh (Pollo)", xem runStoryboardPipelinePollo. */
export function createImageConfirmationPollo(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingImageConfirmationsPollo.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingImageConfirmationsPollo();
  return confirmId;
}

/** GIỐNG confirmImageGeneration hệt nhưng đẩy job "storyboardImagesPollo" (dùng pollo.ai), đọc từ pendingImageConfirmationsPollo (map RIÊNG, KHÔNG dùng chung pendingImageConfirmations của AIVideo nữa). */
export function confirmImageGenerationPollo(confirmId: string): boolean {
  const pending = pendingImageConfirmationsPollo.get(confirmId);
  if (!pending) return false;
  pendingImageConfirmationsPollo.delete(confirmId);
  persistPendingImageConfirmationsPollo();
  enqueueJob({
    type: "storyboardImagesPollo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

interface PendingSceneConfirmation {
  jsonPath: string;
  chatId: number;
  userId: number;
  promptMessageId: number;
}

// Cùng cơ chế/lý do với pendingVideoConfirmations/pendingImageConfirmations ở
// trên (ghi ra file, sống sót qua restart).
const pendingSceneConfirmations = new Map<string, PendingSceneConfirmation>();

function loadPersistedPendingSceneConfirmations(): void {
  try {
    if (!fs.existsSync(PENDING_SCENE_CONFIRMATIONS_FILE)) return;
    const restored: [string, PendingSceneConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_SCENE_CONFIRMATIONS_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingSceneConfirmations.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo ảnh scene" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo ảnh scene" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingSceneConfirmations(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_SCENE_CONFIRMATIONS_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_SCENE_CONFIRMATIONS_FILE,
      JSON.stringify(Array.from(pendingSceneConfirmations.entries()), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo ảnh scene":',
      err,
    );
  }
}

/** Tạo 1 lượt chờ xác nhận "Tạo ảnh scene" cho jsonPath, trả về id ngắn dùng làm callback_data của nút (xem handlers.ts). */
export function createSceneConfirmation(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingSceneConfirmations.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingSceneConfirmations();
  return confirmId;
}

/**
 * User bấm nút "Tạo ảnh scene" — tra lại jsonPath theo confirmId rồi đẩy job
 * "storyboardSceneImagesAIVideo" vào hàng đợi AIVideo (xem
 * StoryboardSceneImagesAIVideoJob). Trả về false nếu confirmId không tồn
 * tại/đã dùng, cùng lý do với confirmVideoGeneration/confirmImageGeneration.
 */
export function confirmSceneGeneration(confirmId: string): boolean {
  const pending = pendingSceneConfirmations.get(confirmId);
  if (!pending) return false;
  pendingSceneConfirmations.delete(confirmId);
  persistPendingSceneConfirmations();
  enqueueJob({
    type: "storyboardSceneImagesAIVideo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

// GIỐNG pendingSceneConfirmations HỆT nhưng map RIÊNG cho nút "Tạo ảnh scene"
// (Pollo) — dùng chung interface PendingSceneConfirmation (cùng field).
const pendingSceneConfirmationsPollo = new Map<
  string,
  PendingSceneConfirmation
>();

function loadPersistedPendingSceneConfirmationsPollo(): void {
  try {
    if (!fs.existsSync(PENDING_SCENE_CONFIRMATIONS_POLLO_FILE)) return;
    const restored: [string, PendingSceneConfirmation][] = JSON.parse(
      fs.readFileSync(PENDING_SCENE_CONFIRMATIONS_POLLO_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const [id, pending] of restored) {
        pendingSceneConfirmationsPollo.set(id, pending);
      }
      console.log(
        `[queue] Khôi phục ${restored.length} lượt chờ xác nhận "Tạo ảnh scene (Pollo)" từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      '[queue] Không đọc được file lượt chờ xác nhận "Tạo ảnh scene (Pollo)" đã lưu, bỏ qua:',
      err,
    );
  }
}

function persistPendingSceneConfirmationsPollo(): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_SCENE_CONFIRMATIONS_POLLO_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      PENDING_SCENE_CONFIRMATIONS_POLLO_FILE,
      JSON.stringify(
        Array.from(pendingSceneConfirmationsPollo.entries()),
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error(
      '[queue] Không ghi được file lượt chờ xác nhận "Tạo ảnh scene (Pollo)":',
      err,
    );
  }
}

/** GIỐNG createSceneConfirmation hệt nhưng ghi vào pendingSceneConfirmationsPollo (map riêng) — dùng cho nút "Tạo ảnh scene" của Pollo. */
export function createSceneConfirmationPollo(
  chatId: number,
  userId: number,
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingSceneConfirmationsPollo.set(confirmId, {
    jsonPath,
    chatId,
    userId,
    promptMessageId,
  });
  persistPendingSceneConfirmationsPollo();
  return confirmId;
}

/**
 * User bấm nút "Tạo ảnh scene" (Pollo) — tra lại jsonPath theo confirmId rồi
 * đẩy job "storyboardScenePollo" vào hàng đợi ảnh Pollo (xem
 * StoryboardSceneImagesPolloJob). Trả về false nếu confirmId không tồn
 * tại/đã dùng, cùng lý do với confirmSceneGeneration.
 */
export function confirmSceneGenerationPollo(confirmId: string): boolean {
  const pending = pendingSceneConfirmationsPollo.get(confirmId);
  if (!pending) return false;
  pendingSceneConfirmationsPollo.delete(confirmId);
  persistPendingSceneConfirmationsPollo();
  enqueueJob({
    type: "storyboardScenePollo",
    chatId: pending.chatId,
    userId: pending.userId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}


/** Tổng số job ảnh + video (AIVideo) còn đang chờ/xử lý dở, gộp cả 2 hàng đợi. */
export function getPendingCount(): number {
  return imageJobs.length + videoJobs.length;
}

/** Tổng số job ảnh + video (Pollo) còn đang chờ/xử lý dở — TÁCH riêng với getPendingCount() (AIVideo), xem chú thích PolloImageJob/PolloVideoJob. */
export function getPolloPendingCount(): number {
  return polloImageJobs.length + polloVideoJobs.length;
}

export function getChatAIPendingCount(): number {
  return chatAIJobs.length + (chatAIProcessing ? 1 : 0);
}

/**
 * Đọc jsonPath, kiểm tra TOÀN BỘ entry type "SCENE_SETTING_START"/
 * "SCENE_SETTING_END" đã "success": true chưa — dùng để hàng đợi VIDEO biết 1
 * job "storyboardVideo" đã SẴN SÀNG lấy ra xử lý hay chưa (xem
 * findNextReadyVideoJobIndex). Schema JSON mới (xem format_output.txt) tách 1
 * type "SCENE_SETTING" cũ thành 2 type boundary START/END — cả 2 đều phải
 * xong thì VIDEO mới đủ cả start lẫn end frame để gen. Không có entry
 * boundary nào (mảng rỗng sau filter) coi như ĐÃ sẵn sàng (every() trên mảng
 * rỗng trả về true) — không chặn oan storyboard không dùng SCENE_SETTING.
 * Đọc/parse lỗi (file đang ghi dở, chưa tồn tại...) coi là CHƯA sẵn sàng, thử
 * lại ở lượt quét sau — KHÔNG throw, tránh làm hỏng cả vòng quét.
 */
function isJsonSceneSettingReady(jsonPath: string): boolean {
  try {
    const entries: StoryboardEntry[] = JSON.parse(
      fs.readFileSync(jsonPath, "utf-8"),
    );
    if (!Array.isArray(entries)) return false;
    return entries
      .filter(
        (e) =>
          e?.type === "SCENE_SETTING_START" || e?.type === "SCENE_SETTING_END",
      )
      .every((e) => e?.success === true);
  } catch {
    return false;
  }
}

/**
 * Quét videoJobs theo đúng thứ tự FIFO (từ đầu mảng), trả về index đầu tiên
 * SẴN SÀNG xử lý:
 * - job "video" thường: luôn sẵn sàng.
 * - job "storyboardVideo" PER-CLIP (có "entryIds", xem StoryboardVideoJob):
 *   luôn sẵn sàng — đã tự xác nhận đủ ref TRƯỚC khi enqueue (xem
 *   findVideoEntriesReadyAfterEnd), không cần chờ isJsonSceneSettingReady của
 *   CẢ FILE (clip khác trong CÙNG file có thể vẫn đang gen ảnh scene dở).
 * - job "storyboardVideo" CẢ FILE (không có "entryIds", từ nút "Tạo video"
 *   thủ công): chỉ sẵn sàng khi isJsonSceneSettingReady(jsonPath) — tức job
 *   "storyboardImagesAIVideo"/"storyboardSceneImagesAIVideo" tương ứng (ở
 *   hàng đợi ẢNH) đã gen xong HẾT SCENE_SETTING.
 * Job CHƯA sẵn sàng bị BỎ QUA (không xoá/không đổi thứ tự trong mảng) để xét
 * job kế tiếp — theo đúng yêu cầu người dùng. Trả về -1 nếu không có job nào
 * sẵn sàng (hàng đợi rỗng, hoặc mọi job storyboardVideo cả-file còn lại đều
 * đang chờ ảnh SCENE_SETTING xong).
 */
function findNextReadyVideoJobIndex(): number {
  for (let i = 0; i < videoJobs.length; i++) {
    const job = videoJobs[i];
    if (
      job.type === "video" ||
      (job.type === "storyboardVideo" &&
        job.entryIds &&
        job.entryIds.length > 0) ||
      isJsonSceneSettingReady(job.jsonPath)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Hàng đợi ẢNH (gen bằng AIVideo) — xử lý job "image" thường,
 * "storyboardImagesAIVideo" (CHARACTER/LOCATION, xem docstring
 * StoryboardImagesAIVideoJob) và "storyboardSceneImagesAIVideo"
 * (SCENE_SETTING, xem docstring StoryboardSceneImagesAIVideoJob) — 2 job
 * storyboard RIÊNG TYPE dù cùng ở bước "Tạo ảnh", để retry được độc lập (xem
 * failedStoryboardJobs). FIFO đơn thuần (luôn lấy jobs[0]) — không có job
 * nào phải "chờ" job khác trong hàng đợi này nên không cần cơ chế quét/bỏ
 * qua như hàng đợi video.
 */
async function processImageQueue(): Promise<void> {
  if (imageProcessing || !telegram) return;
  imageProcessing = true;
  try {
    while (imageJobs.length > 0) {
      const job = imageJobs[0];
      const jobId = randomUUID();
      try {
        if (job.type === "storyboardImagesAIVideo") {
          const errorFolderName = path.basename(generatedImageDirFor(job.jsonPath));
          const sendImageNow = async (imagePath: string): Promise<void> => {
            const caption = buildResultCaption(folderNameOf(imagePath), imagePath);
            await sendGeneratedImage(
              job.chatId,
              imagePath,
              caption,
              job.promptMessageId,
              `${caption}${path.extname(imagePath)}`,
            );
          };
          const notifyImageError = async (
            id: string,
            errorMessage: string,
          ): Promise<void> => {
            try {
              const itemId = buildResultCaption(errorFolderName, id);
              const message = itemId + " 404";
              await notifyAdmins(itemId + ": " + errorMessage);
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          };

          // CHARACTER/LOCATION qua AIVideo.
          const refResult = await generateReferenceImagesForFileViaAIVideo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
          );
          const readyForScene =
            refResult.failed === 0 && refResult.succeeded > 0;

          // Xong không lỗi — hỏi xác nhận qua nút "Tạo ảnh scene" (job
          // "storyboardSceneImagesAIVideo", RIÊNG type — xem docstring
          // StoryboardSceneImagesAIVideoJob) — KHÔNG tự động đẩy job.
          if (readyForScene) {
            const confirmId = createSceneConfirmation(
              job.chatId,
              job.userId,
              job.promptMessageId,
              job.jsonPath,
            );
            await telegram!.sendMessage(job.chatId, "Xác nhận tạo ảnh scene", {
              reply_parameters: { message_id: job.promptMessageId },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Tạo ảnh scene",
                      callback_data: `confirmScene:${confirmId}`,
                    },
                  ],
                ],
              },
            });
          }

          if (refResult.failed > 0) {
            recordFailedStoryboardJob(job);
          }
          await notifyStoryboardImagesAIVideoResult(job, {
            failedEntries: refResult.failedEntries,
            readyForNext: readyForScene,
          });
        } else if (job.type === "storyboardSceneImagesAIVideo") {
          const errorFolderName = path.basename(generatedImageDirFor(job.jsonPath));
          const sendImageNow = async (imagePath: string): Promise<void> => {
            const caption = buildResultCaption(folderNameOf(imagePath), imagePath);
            await sendGeneratedImage(
              job.chatId,
              imagePath,
              caption,
              job.promptMessageId,
              `${caption}${path.extname(imagePath)}`,
            );
          };
          const notifyImageError = async (id: string): Promise<void> => {
            try {
              const message = buildResultCaption(errorFolderName, id) + " 404";
              await notifyAdmins(message);
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          };

          // Ngay khi 1 entry SCENE_SETTING_END vừa xong VÀ (các) entry VIDEO
          // tương ứng đã đủ ref (xem findVideoEntriesReadyAfterEnd trong
          // storyboardPipeline.ts), tự đẩy NGAY job "storyboardVideo"
          // PER-CLIP cho đúng entry đó — không cần chờ hết cả file (xem
          // docstring StoryboardVideoJob). isStoryboardJobQueued tránh đẩy
          // trùng nếu clip này đã có job (per-clip hoặc cả-file) đang
          // chờ/xử lý rồi.
          const onVideoEntriesReady = async (
            readyEntryIds: string[],
          ): Promise<void> => {
            for (const entryId of readyEntryIds) {
              if (
                isStoryboardJobQueued("storyboardVideo", job.jsonPath, entryId)
              ) {
                continue;
              }
              enqueueJob({
                type: "storyboardVideo",
                chatId: job.chatId,
                userId: job.userId,
                prompt: "",
                promptMessageId: job.promptMessageId,
                jsonPath: job.jsonPath,
                entryIds: [entryId],
              });
            }
          };

          const sceneResult = await generateSceneImagesForFileViaAIVideo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
            onVideoEntriesReady,
          );
          const readyForVideo =
            sceneResult.failed === 0 && sceneResult.succeeded > 0;

          // Ảnh xong không lỗi — LUÔN hỏi xác nhận qua nút "Tạo video" (2 chế
          // độ ChatAI giờ xác nhận giống nhau, xem docstring
          // StoryboardSceneImagesAIVideoJob) — KHÔNG tự động đẩy job
          // "storyboardVideo".
          // if (readyForVideo) {
          //   const confirmId = createVideoConfirmation(
          //     job.chatId,
          //     job.userId,
          //     job.promptMessageId,
          //     job.jsonPath,
          //   );
          //   await telegram!.sendMessage(job.chatId, "Xác nhận tạo video", {
          //     reply_parameters: { message_id: job.promptMessageId },
          //     reply_markup: {
          //       inline_keyboard: [
          //         [
          //           {
          //             text: "Tạo video",
          //             callback_data: `confirmVideo:${confirmId}`,
          //           },
          //         ],
          //       ],
          //     },
          //   });
          // }

          if (sceneResult.failed > 0) {
            recordFailedStoryboardJob(job);
          }
          await notifyStoryboardImagesAIVideoResult(job, {
            failedEntries: sceneResult.failedEntries,
            readyForNext: readyForVideo,
          });

          // Đánh thức hàng đợi VIDEO — có thể đang có job "storyboardVideo"
          // bị bỏ qua (chưa sẵn sàng) vì đợi ĐÚNG file json này, xem
          // findNextReadyVideoJobIndex. No-op nếu không có gì sẵn sàng.
          void processVideoQueue();
        } else if (job.type === "image") {
          const filePaths = await generateImage(
            job.prompt,
            { model: job.model, referenceImagePaths: job.referenceImagePaths },
            jobId,
          );
          await notifyImageSuccess(job, filePaths);
          for (const p of filePaths) await fsp.unlink(p).catch(() => {});
        }
      } catch (err) {
        await notifyError(job, err);
      } finally {
        if (job.type === "image") {
          for (const p of job.referenceImagePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
        } else if (
          job.type === "storyboardImagesAIVideo" ||
          job.type === "storyboardSceneImagesAIVideo"
        ) {
          // Reset cờ "Stop All" của ĐÚNG jsonPath này SAU KHI job (có thể
          // đang bị dừng sớm) đã thực sự thoát hẳn — không reset thì job MỚI
          // sau đó dùng LẠI đúng jsonPath này (vd bấm "Tiếp tục...") sẽ bị
          // chặn nhầm ngay từ đầu (xem stopAll()/requestStopStoryboardPipeline).
          clearStopStoryboardRequest(job.jsonPath);
        }
        imageJobs.shift();
        persistImageJobs();
      }
    }
    // Hàng đợi rỗng hẳn (while thoát bình thường, không phải do lỗi) — đóng
    // Chrome ngay để giải phóng RAM thay vì giữ sống chờ job kế tiếp không
    // biết bao giờ mới tới (xem docstring BrowserContextGetter.close, xác
    // nhận qua đo đạc thật: VPS 3.8GB dễ chạm ngưỡng crash khi nhiều queue
    // cùng giữ browser sống).
    await getImageBrowserContext.close();
  } finally {
    imageProcessing = false;
  }
}

/**
 * GIỐNG processImageQueue nhưng xử lý 2 job "storyboardImagesPollo" (dùng
 * pollo.ai, CHARACTER/LOCATION) và "storyboardScenePollo" (SCENE_SETTING_START/
 * END) — hàng đợi RIÊNG (polloImageJobs), chạy song song độc lập với
 * processImageQueue.
 *
 * SỬA (khôi phục schema SCENE_SETTING_START/END — xem format_output.txt):
 * VIDEO.ref giờ chỉ trỏ tới SCENE_SETTING_START/END (không còn CHARACTER/
 * LOCATION trực tiếp), nên pipeline Pollo cần LẠI bước "Tạo ảnh scene" —
 * GIỐNG HỆT cấu trúc AIVideo (3 lượt xác nhận nối tiếp: "Tạo ảnh" → "Tạo ảnh
 * scene" → "Tạo video"):
 * - "storyboardImagesPollo": CHARACTER/LOCATION xong không lỗi → gửi nút "Tạo
 *   ảnh scene" (createSceneConfirmationPollo, KHÔNG tự đẩy job scene).
 * - "storyboardScenePollo": SCENE_SETTING xong → tự động đẩy NGAY job
 *   "storyboardVideoComfy" PER-CLIP cho từng clip vừa đủ ref (xem
 *   onVideoEntriesReady), ĐỒNG THỜI gửi nút "Tạo video" (cả file, thủ công —
 *   theo yêu cầu người dùng, nút này CŨNG đẩy job "storyboardVideoComfy",
 *   KHÔNG phải "storyboardVideoPollo" — dùng chung 1 provider Comfy cho cả
 *   auto-push lẫn xác nhận thủ công ở bước này; entry đã auto-push xong
 *   ("success": true) tự bị bỏ qua khi bấm nút, không sinh trùng).
 */
async function processPolloImageQueue(): Promise<void> {
  if (polloImageProcessing || !telegram) return;
  polloImageProcessing = true;
  try {
    while (polloImageJobs.length > 0) {
      const job = polloImageJobs[0];
      try {
        const errorFolderName = path.basename(generatedImageDirFor(job.jsonPath));
        const sendImageNow = async (imagePath: string): Promise<void> => {
          const caption = buildResultCaption(folderNameOf(imagePath), imagePath);
          await sendGeneratedImage(
            job.chatId,
            imagePath,
            caption,
            job.promptMessageId,
            `${caption}${path.extname(imagePath)}`,
          );
        };
        const notifyImageError = async (
          id: string,
          errorMessage: string,
        ): Promise<void> => {
          try {
            const itemId = buildResultCaption(errorFolderName, id);
            const message = itemId + " 404";
            await notifyAdmins(itemId + ": " + errorMessage);
            await telegram!.sendMessage(job.chatId, message, {
              reply_parameters: { message_id: job.promptMessageId },
            });
          } catch (err) {}
        };

        if (job.type === "storyboardImagesPollo") {
          const refResult = await generateReferenceImagesForFileViaPollo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
          );
          // const readyForScene =
          //   refResult.failed === 0 && refResult.succeeded > 0;

          // if (readyForScene) {
          //   const confirmId = createSceneConfirmationPollo(
          //     job.chatId,
          //     job.userId,
          //     job.promptMessageId,
          //     job.jsonPath,
          //   );
          //   await telegram!.sendMessage(job.chatId, "Xác nhận tạo ảnh scene", {
          //     reply_parameters: { message_id: job.promptMessageId },
          //     reply_markup: {
          //       inline_keyboard: [
          //         [
          //           {
          //             text: "Tạo ảnh scene",
          //             callback_data: `confirmScenePollo:${confirmId}`,
          //           },
          //         ],
          //       ],
          //     },
          //   });
          // }
          const readyForVideo =
            refResult.failed === 0 && refResult.succeeded > 0;

          if (readyForVideo) {
            // SỬA (theo yêu cầu người dùng): nút xác nhận "cả file" sau bước
            // scene giờ đẩy job "storyboardVideoComfy" (KHÔNG phải
            // "storyboardVideoPollo" như trước) — khớp với chính provider
            // đang được auto-push per-clip ở trên (onVideoEntriesReady),
            // tránh lẫn 2 provider khác nhau ở cùng 1 bước xác nhận. Entry đã
            // auto-push xong ("success": true) sẽ tự bị generateVideosForFileComfyUI
            // bỏ qua, không sinh trùng.
            const confirmId = createVideoConfirmationComfy(
              job.chatId,
              job.userId,
              job.promptMessageId,
              job.jsonPath,
            );
            await telegram!.sendMessage(job.chatId, "Xác nhận tạo video", {
              reply_parameters: { message_id: job.promptMessageId },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Tạo video",
                      callback_data: `confirmVideoComfy:${confirmId}`,
                    },
                  ],
                ],
              },
            });
          }

          if (refResult.failed > 0) {
            recordFailedStoryboardJobPollo(job);
          }
          await notifyStoryboardImagesResultPollo(job, {
            failedEntries: refResult.failedEntries,
            readyForNext: readyForVideo,
          });
        } else if (job.type === "storyboardScenePollo") {
          // Tự đẩy NGAY job "storyboardVideoComfy" PER-CLIP cho (các) entry
          // VIDEO vừa đủ ref, KHÔNG cần xác nhận — CHỦ Ý CHỈ auto-push cho
          // Comfy (không tốn credit, khác Pollo — xem docstring hàm này).
          const onVideoEntriesReady = async (
            readyEntryIds: string[],
          ): Promise<void> => {
            for (const entryId of readyEntryIds) {
              if (isComfyStoryboardJobQueued(job.jsonPath, entryId)) {
                continue;
              }
              enqueueJob({
                type: "storyboardVideoComfy",
                chatId: job.chatId,
                userId: job.userId,
                prompt: "",
                promptMessageId: job.promptMessageId,
                jsonPath: job.jsonPath,
                entryIds: [entryId],
              });
            }
          };

          const sceneResult = await generateSceneImagesForFileViaPollo(
            job.jsonPath,
            sendImageNow,
            async (id: string) => {
              await notifyImageError(id, "Lỗi tạo ảnh scene (Pollo)");
            },
            onVideoEntriesReady,
          );
          const readyForVideo =
            sceneResult.failed === 0 && sceneResult.succeeded > 0;

          if (readyForVideo) {
            // SỬA (theo yêu cầu người dùng): nút xác nhận "cả file" sau bước
            // scene giờ đẩy job "storyboardVideoComfy" (KHÔNG phải
            // "storyboardVideoPollo" như trước) — khớp với chính provider
            // đang được auto-push per-clip ở trên (onVideoEntriesReady),
            // tránh lẫn 2 provider khác nhau ở cùng 1 bước xác nhận. Entry đã
            // auto-push xong ("success": true) sẽ tự bị generateVideosForFileComfyUI
            // bỏ qua, không sinh trùng.
            const confirmId = createVideoConfirmationComfy(
              job.chatId,
              job.userId,
              job.promptMessageId,
              job.jsonPath,
            );
            await telegram!.sendMessage(job.chatId, "Xác nhận tạo video", {
              reply_parameters: { message_id: job.promptMessageId },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Tạo video",
                      callback_data: `confirmVideoComfy:${confirmId}`,
                    },
                  ],
                ],
              },
            });
          }

          if (sceneResult.failed > 0) {
            recordFailedStoryboardJobPollo(job);
          }
          await notifyStoryboardImagesResultPollo(job, {
            failedEntries: sceneResult.failedEntries,
            readyForNext: readyForVideo,
          });
        }
      } catch (err) {
        await notifyError(job, err);
      } finally {
        clearStopStoryboardRequest(job.jsonPath);
        polloImageJobs.shift();
        persistPolloImageJobs();
      }
    }
    await getPolloImageBrowserContext.close();
  } finally {
    polloImageProcessing = false;
  }
}

/**
 * Hàng đợi VIDEO (gen bằng AIVideo) — xử lý job "video" thường và
 * "storyboardVideo" (CHỈ generateVideosForFile, xem docstring
 * StoryboardVideoJob). KHÔNG lấy jobs[0] cố định như hàng đợi ảnh — dùng
 * findNextReadyVideoJobIndex() quét tìm job ĐẦU TIÊN (theo thứ tự FIFO) đã
 * sẵn sàng, bỏ qua (giữ nguyên vị trí) job "storyboardVideo" nào có
 * SCENE_SETTING chưa xong hết — theo đúng yêu cầu người dùng. Nếu không có
 * job nào sẵn sàng, dừng vòng lặp (không phải hàng đợi rỗng — có thể vẫn còn
 * job storyboardVideo đang chờ) — processImageQueue sẽ gọi lại hàm này khi
 * 1 job "storyboardImagesAIVideo" gen SCENE_SETTING xong, đánh thức lại vòng
 * quét.
 */
async function processVideoQueue(): Promise<void> {
  if (videoProcessing || !telegram) return;
  videoProcessing = true;
  try {
    while (true) {
      const index = findNextReadyVideoJobIndex();
      if (index === -1) break;
      const job = videoJobs[index];
      currentVideoJob = job;
      const jobId = randomUUID();
      try {
        if (job.type === "video") {
          const filePath = await generateVideo(
            job.prompt,
            {
              resolution: job.resolution,
              model: job.model,
              duration: job.duration,
              startFramePath: job.startFramePath,
              referenceImagePaths: job.referenceImagePaths,
              characterImagePath: job.characterImagePath,
              omniReferencePaths: job.omniReferencePaths,
            },
            jobId,
          );
          await notifyVideoSuccess(job, filePath);
          await fsp.unlink(filePath).catch(() => {});
        } else if (job.type === "storyboardVideo") {
          const errorFolderName = path.basename(generatedDirFor(job.jsonPath));
          const videoResult = await generateVideosForFile(
            job.jsonPath,
            async (videoPath) => {
              const caption = buildResultCaption(folderNameOf(videoPath), videoPath);
              await sendGeneratedVideo(
                job.chatId,
                videoPath,
                caption,
                job.promptMessageId,
                `${caption}${path.extname(videoPath)}`,
              );
            },
            async (id: string, errorMessage: string): Promise<void> => {
              try {
                const itemId = buildResultCaption(errorFolderName, id);
                const message = itemId + " 404";
                await notifyAdmins(itemId + ": " + errorMessage);
                await telegram!.sendMessage(job.chatId, message, {
                  reply_parameters: { message_id: job.promptMessageId },
                });
              } catch (err) {}
            },
            job.entryIds,
          );

          await notifyStoryboardVideoResult(job, videoResult);
        }
      } catch (err) {
        await notifyError(job, err);
      } finally {
        if (job.type === "video") {
          if (job.startFramePath)
            await fsp.unlink(job.startFramePath).catch(() => {});
          if (job.characterImagePath)
            await fsp.unlink(job.characterImagePath).catch(() => {});
          for (const p of job.referenceImagePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
          for (const p of job.omniReferencePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
        } else if (job.type === "storyboardVideo") {
          // Reset cờ "Stop All" của ĐÚNG jsonPath — cùng lý do đã giải thích ở processImageQueue.
          clearStopStoryboardRequest(job.jsonPath);
        }
        currentVideoJob = null;
        videoJobs.splice(index, 1);
        persistVideoJobs();
      }
    }
    // Vòng lặp có thể thoát vì hàng đợi THẬT SỰ rỗng, HOẶC vì còn job
    // storyboardVideo đang "chờ" (chưa sẵn sàng, xem findNextReadyVideoJobIndex)
    // — chỉ đóng Chrome khi rỗng hẳn, không phải lúc nào loop thoát cũng đóng
    // (đóng nhầm lúc còn job chờ sẽ phải khởi động lại Chrome ngay khi job đó
    // sẵn sàng, phí công vô ích).
    if (videoJobs.length === 0) {
      await getVideoBrowserContext.close();
    }
  } finally {
    videoProcessing = false;
  }
}

/**
 * GIỐNG processVideoQueue nhưng xử lý job "storyboardVideoPollo" (dùng
 * generateVideosForFilePollo) — hàng đợi RIÊNG (polloVideoJobs), chạy song
 * song độc lập với processVideoQueue.
 *
 * KHÁC processVideoQueue: FIFO ĐƠN THUẦN (luôn lấy jobs[0], KHÔNG quét tìm
 * job "sẵn sàng" như findNextReadyVideoJobIndex) — pipeline Pollo không còn
 * bước "Tạo ảnh scene" nên không có khái niệm "chờ SCENE_SETTING xong" nữa
 * (xem StoryboardImagesPolloJob): job "storyboardVideoPollo" chỉ được tạo
 * SAU KHI user đã bấm xác nhận "Tạo video (Pollo)" (tức CHARACTER/LOCATION
 * đã chắc chắn xong), nên LUÔN sẵn sàng ngay khi tới lượt.
 */
async function processPolloVideoQueue(): Promise<void> {
  if (polloVideoProcessing || !telegram) return;
  polloVideoProcessing = true;
  try {
    while (polloVideoJobs.length > 0) {
      const job = polloVideoJobs[0];
      currentPolloVideoJob = job;
      try {
        const errorFolderName = path.basename(generatedDirFor(job.jsonPath));
        const videoResult = await generateVideosForFilePollo(
          job.jsonPath,
          async (videoPath) => {
            const caption = buildResultCaption(folderNameOf(videoPath), videoPath);
            await sendGeneratedVideo(
              job.chatId,
              videoPath,
              caption,
              job.promptMessageId,
              `${caption}${path.extname(videoPath)}`,
            );
          },
          async (id: string, errorMessage: string): Promise<void> => {
            try {
              const itemId = buildResultCaption(errorFolderName, id);
              const message = itemId + " 404";
              await notifyAdmins(itemId + ": " + errorMessage);
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          },
          job.entryIds,
        );

        await notifyStoryboardVideoResultPollo(job, videoResult);
      } catch (err) {
        await notifyError(job, err);
      } finally {
        clearStopStoryboardRequest(job.jsonPath);
        currentPolloVideoJob = null;
        polloVideoJobs.shift();
        persistPolloVideoJobs();
      }
    }
    await getPolloBrowserContext.close();
  } finally {
    polloVideoProcessing = false;
  }
}

/**
 * GIỐNG processPolloVideoQueue HỆT (FIFO đơn thuần, không cần chờ
 * SCENE_SETTING) nhưng xử lý job "storyboardVideoComfy" (dùng
 * generateVideosForFileComfyUI) — hàng đợi RIÊNG (comfyVideoJobs). KHÔNG có
 * browser context nào để đóng (ComfyUI gọi thẳng REST API, xem comfyui.ts) —
 * khác processPolloVideoQueue/processVideoQueue ở điểm này.
 */
async function processComfyVideoQueue(): Promise<void> {
  if (comfyVideoProcessing || !telegram) return;
  comfyVideoProcessing = true;
  try {
    while (comfyVideoJobs.length > 0) {
      const job = comfyVideoJobs[0];
      currentComfyVideoJob = job;
      try {
        const errorFolderName = path.basename(generatedDirFor(job.jsonPath));
        const videoResult = await generateVideosForFileComfyUI(
          job.jsonPath,
          async (videoPath) => {
            const caption = buildResultCaption(folderNameOf(videoPath), videoPath);
            await sendGeneratedVideo(
              job.chatId,
              videoPath,
              caption,
              job.promptMessageId,
              `${caption}${path.extname(videoPath)}`,
            );
          },
          async (id: string, errorMessage: string): Promise<void> => {
            try {
              const itemId = buildResultCaption(errorFolderName, id);
              const message = itemId + " 404";
              await notifyAdmins(itemId + ": " + errorMessage);
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          },
          job.entryIds,
        );

        await notifyStoryboardVideoResultComfy(job, videoResult);
      } catch (err) {
        await notifyError(job, err);
      } finally {
        clearStopStoryboardRequest(job.jsonPath);
        currentComfyVideoJob = null;
        comfyVideoJobs.shift();
        persistComfyVideoJobs();
      }
    }
  } finally {
    comfyVideoProcessing = false;
  }
}

async function processChatAIQueue(): Promise<void> {
  if (chatAIProcessing || !telegram) return;
  chatAIProcessing = true;
  try {
    while (chatAIJobs.length > 0) {
      const job = chatAIJobs[0];
      const jobId = randomUUID();
      try {
        // Theo yêu cầu người dùng: xử lý job BẰNG askChatAI (upload file lên
        // composer ChatGPT — nhanh/ổn định hơn ở đa số trường hợp bình
        // thường) TRƯỚC, CHỈ fallback sang askChatAIWithInlineContent (dán
        // thẳng nội dung file vào tin nhắn, né công cụ đọc file — chậm hơn,
        // nhiều lượt hơn, nhưng cứu được đúng lúc công cụ đọc file của
        // ChatGPT đang hỏng) khi askChatAI báo rõ ChatAIError.fileAccessError
        // (xem askChatAI: throw riêng field này khi ChatGPT báo lỗi công cụ
        // đọc file LẶP LẠI tới hết lượt, không phải mọi lỗi khác).
        let downloadedFiles: string[];
        try {
          ({ downloadedFiles } = await askChatAI(
            job.prompt,
            jobId,
            job.promptFileName,
            job.promptAttachmentPath,
          ));
        } catch (err) {
          if (!(err instanceof ChatAIError) || !err.fileAccessError) throw err;
          console.warn(
            `[queue] askChatAI dính fileAccessError (job ${jobId}) — fallback sang askChatAIWithInlineContent:`,
            err.message,
          );
          ({ downloadedFiles } = await askChatAIWithInlineContent(
            job.prompt,
            jobId,
            job.promptFileName,
            job.promptAttachmentPath,
          ));
        }

        // "Tạo kịch bản mới" (job.type === "generateScript", dùng CHUNG hàng
        // đợi này với "chatAI" — xem docstring GenerateScriptJob) cần 2 bước
        // RIÊNG trước khi gửi JSON cho user: (1) hậu kiểm bằng CODE đối
        // chiếu CHARACTER/LOCATION/PROP/OBJECT xuyên các file tập, ghi đè
        // cho khớp bản canonical nếu ChatGPT lỡ viết lệch mô tả (xem
        // docstring reconcileAssetLedgerAcrossFiles trong
        // storyboardPipeline.ts); (2) xác định job.generatedFolderName (tên
        // phim, rút từ OUTPUT_BASENAME chung mà master prompt bắt buộc đặt
        // trong tên MỌI file tập) để runStoryboardPipelinePollo bên dưới
        // dùng CHUNG 1 folder generated/<tên phim>/ cho mọi tập (xem docstring
        // generatedFolderName trong BaseJob) thay vì mỗi tập 1 folder riêng
        // (hành vi mặc định cho job "chatAI" bình thường).
        if (job.type === "generateScript") {
          const jsonFiles = downloadedFiles.filter(
            (f) => path.extname(f).toLowerCase() === ".json",
          );
          if (jsonFiles.length > 1) {
            const { fixedCount, details } =
              await reconcileAssetLedgerAcrossFiles(jsonFiles);
            if (details.length > 0) {
              console.log(
                `[queue] Hậu kiểm Asset Ledger (job ${jobId}, "Tạo kịch bản mới"):\n${details.join("\n")}`,
              );
            }
            if (fixedCount > 0) {
              await telegram
                .sendMessage(
                  job.chatId,
                  `🔧 Đã tự động đồng bộ ${fixedCount} chỗ mô tả nhân vật/bối cảnh/đạo cụ/vật thể bị lệch giữa các tập (hậu kiểm Asset Ledger).`,
                  { reply_parameters: { message_id: job.promptMessageId } },
                )
                .catch(() => {});
            }
          }
          if (jsonFiles.length > 0) {
            const firstJsonWithoutExt = path
              .basename(jsonFiles[0])
              .replace(/\.json$/i, "");
            const match = firstJsonWithoutExt.match(/^(.*?)_tap\d+.*$/i);
            job.generatedFolderName = (
              match ? match[1] : firstJsonWithoutExt
            ).trim();
          }
        }

        // Gửi NGAY file JSON storyboard vừa tải về cho user, TRƯỚC KHI bắt
        // đầu gen ảnh/video (có thể mất rất lâu) — theo yêu cầu người dùng,
        // để user xem/kiểm tra được kịch bản ngay, không phải đợi hết cả
        // pipeline. Lỗi gửi (vd Telegram lỗi) KHÔNG chặn pipeline tiếp theo.
        for (const filePath of downloadedFiles) {
          if (path.extname(filePath).toLowerCase() !== ".json") continue;
          await sendDocumentMaybeSplit(
            job.chatId,
            filePath,
            `✅ prompts`,
            job.promptMessageId,
          ).catch((err) => {
            console.error(
              `[queue] Gửi file JSON "${filePath}" thất bại (không chặn pipeline):`,
              err,
            );
          });
        }
        // const result = await runStoryboardPipeline(downloadedFiles, job);
        // Gửi THÊM 1 lượt xác nhận riêng cho Pollo (nút "Tạo ảnh (Pollo)") —
        // xem docstring runStoryboardPipelinePollo. Kết quả của lượt này
        // KHÔNG dùng cho notifyChatAISuccess (processedJsonCount giống hệt
        // result ở trên, cùng đếm trên CHÍNH downloadedFiles).
        const result = await runStoryboardPipelinePollo(downloadedFiles, job);
        await notifyChatAISuccess(job, result);
      } catch (err) {
        await notifyError(job, err);
      } finally {
        if (job.promptAttachmentPath) {
          await fsp.unlink(job.promptAttachmentPath).catch(() => {});
        }
        chatAIJobs.shift();
        persistChatAIJobs();
        // KHÔNG cần clearStopStoryboardRequest() ở đây — job "chatAI" (chỉ
        // gọi askChatAI) không có jsonPath và không hề tự gọi
        // generateReferenceImagesForFileViaAIVideo/generateSceneImagesForFileViaAIVideo/
        // generateVideosForFile (những hàm đó chỉ chạy ở job
        // "storyboardImagesAIVideo"/"storyboardSceneImagesAIVideo"/
        // "storyboardVideo", xem processImageQueue/processVideoQueue) — cờ
        // "Stop All" theo jsonPath không áp dụng cho job này.
        // Chờ giữa các lần gọi gen json (askChatAI) liên tiếp — tránh gửi
        // request quá nhanh lên ChatAI (theo yêu cầu người dùng). Chỉ
        // chờ khi còn job kế tiếp, tránh delay vô ích lúc hàng đợi đã hết.
        if (chatAIJobs.length > 0) {
          await sleep(30000);
        }
      }
    }
    await getChatAIBrowserContext.close();
  } finally {
    chatAIProcessing = false;
  }
}

/**
 * SỬA theo yêu cầu người dùng: sau khi gửi file JSON, giờ cũng gửi nút xác
 * nhận "Tạo ảnh (Pollo)" GIỐNG HỆT processChatAIQueue (gọi chung
 * runStoryboardPipelinePollo + notifyChatAISuccess) — trước đây job này chỉ
 * gửi JSON rồi dừng, không cho tạo ảnh tiếp. Vẫn KHÁC processChatAIQueue ở
 * chỗ nguồn là video (askChatAIAboutReferenceVideo) thay vì askChatAI.
 */
async function processScriptReferenceVideoQueue(): Promise<void> {
  if (scriptReferenceVideoProcessing || !telegram) return;
  scriptReferenceVideoProcessing = true;
  try {
    while (scriptReferenceVideoJobs.length > 0) {
      const job = scriptReferenceVideoJobs[0];
      const jobId = randomUUID();
      try {
        const { downloadedFiles } = await askChatAIAboutReferenceVideo(
          job.videoPath,
          jobId,
          job.videoFileName,
          job.extraInstruction,
          job.masterPromptPath,
        );
        for (const filePath of downloadedFiles) {
          if (path.extname(filePath).toLowerCase() !== ".json") continue;
          await sendDocumentMaybeSplit(
            job.chatId,
            filePath,
            "✅ prompts",
            job.promptMessageId,
          ).catch((err) => {
            console.error(
              `[queue] Gửi file JSON "${filePath}" (Tham chiếu kịch bản) thất bại:`,
              err,
            );
          });
        }
        if (job.skipImageConfirmation) {
          // "Tham chiếu video" — CHỈ dừng ở bước gửi JSON, không tạo folder
          // generated/, không gửi nút xác nhận "Tạo ảnh" (theo yêu cầu
          // người dùng, khác "Tham chiếu kịch bản" ở nhánh else bên dưới).
          const jsonCount = downloadedFiles.filter(
            (f) => path.extname(f).toLowerCase() === ".json",
          ).length;
          if (jsonCount === 0) {
            await telegram.sendMessage(
              job.chatId,
              "✅ ChatAI đã trả lời xong (không có file JSON đính kèm nào).",
              { 
                reply_parameters: { message_id: job.promptMessageId },
                ...promptMenu,
              },
            );
          }
          await deleteStatusMessage(job);
        } else {
          // "Tham chiếu kịch bản" — job KHÁC "chatAI" nên
          // runStoryboardPipelinePollo dùng CHUNG 1 folder generated/<tên
          // phim>/ cho MỌI file JSON của job này (xem docstring
          // generatedFolderName trong BaseJob) — "tên phim" lấy từ chính
          // tên video gốc user đã upload (job.videoFileName), bỏ đuôi file.
          job.generatedFolderName = path.basename(
            job.videoFileName,
            path.extname(job.videoFileName),
          );
          const result = await runStoryboardPipelinePollo(
            downloadedFiles,
            job,
          );
          await notifyChatAISuccess(job, result);
        }
      } catch (err) {
        await notifyError(job, err);
      } finally {
        await fsp.unlink(job.videoPath).catch(() => {});
        scriptReferenceVideoJobs.shift();
        persistScriptReferenceVideoJobs();
        // Cùng lý do chờ giữa các lượt gọi ChatAI liên tiếp như
        // processChatAIQueue — tránh gửi request quá nhanh lên ChatAI.
        if (scriptReferenceVideoJobs.length > 0) {
          await sleep(30000);
        }
      }
    }
    await getChatAIBrowserContext.close();
  } finally {
    scriptReferenceVideoProcessing = false;
  }
}

interface ChatAIPipelineResult {
  /** Số file JSON storyboard THẬT SỰ được xử lý (bỏ qua file không phải .json) — dùng phân biệt "không có file đính kèm" với "có file nhưng chưa gen ảnh". */
  processedJsonCount: number;
  /** Số file JSON đã tạo folder generated/ + gửi nút "Tạo ảnh" xác nhận (xem createImageConfirmation trong runStoryboardPipeline). */
  confirmPromptsSent: number;
}

/** "<tên file json>__<tên file>" — quy ước caption/tên file dùng chung cho ảnh VÀ video gửi về user, xem processImageQueue/processVideoQueue (nhánh "storyboardImagesAIVideo"/"storyboardVideo"). */
function buildResultCaption(
  jsonBaseName: string,
  resultFilePath: string,
): string {
  return `${jsonBaseName}__${path.parse(resultFilePath).name}`;
}

/**
 * Theo yêu cầu người dùng: caption khi gen ẢNH/VIDEO THÀNH CÔNG dùng tên
 * FOLDER thật sự đang chứa file kết quả (resultFilePath) thay vì
 * jsonBaseName (tên file JSON gốc) — 2 cái này có thể KHÁC nhau khi nhiều
 * tập dùng CHUNG 1 folder theo tên phim (ảnh lưu ở cấp phim, video lưu
 * RIÊNG theo từng tập — xem generatedImageDirFor/generatedDirFor trong
 * storyboardPipeline.ts). Chỉ áp dụng cho caption THÀNH CÔNG (có file thật
 * để lấy folder) — caption LỖI (404, không có file) vẫn giữ nguyên dùng
 * jsonBaseName như cũ.
 */
function folderNameOf(resultFilePath: string): string {
  return path.basename(path.dirname(resultFilePath));
}

/**
 * Với MỖI file JSON storyboard ChatAI tải về (thường chỉ 1, vd meta.json — file
 * KHÔNG phải .json bị bỏ qua, không xử lý): tạo NGAY folder
 * generated/<tên file>/ + copy JSON vào đó (xem
 * ensureGeneratedFolder — để user có thể upload ảnh/JSON thay thế
 * trong lúc chờ, xem tryReplaceGeneratedFile trong handlers.ts), rồi gửi nút
 * "Tạo ảnh" hỏi xác nhận (xem createImageConfirmation) — KHÔNG tự gen ảnh/
 * video ở đây. Cả 2 chế độ ChatAI (CHATAI_BUTTON_LABEL/CHATAI_CHECK_BUTTON_LABEL)
 * dùng CHUNG hàm này, xác nhận giống hệt nhau (Tạo ảnh → Tạo video, xem
 * StoryboardImagesAIVideoJob/StoryboardVideoJob).
 */
async function runStoryboardPipeline(
  downloadedFiles: string[],
  job: ChatAIJob,
): Promise<ChatAIPipelineResult> {
  let processedJsonCount = 0;
  let confirmPromptsSent = 0;

  for (const filePath of downloadedFiles) {
    if (path.extname(filePath).toLowerCase() !== ".json") {
      continue;
    }
    processedJsonCount++;

    // Từ đây về sau dùng đường dẫn file json TRONG generated/ (bản đã copy),
    // KHÔNG dùng path gốc lúc ChatAI tải về (vd storage/chatai-results/) —
    // đây mới là nơi generateReferenceImagesForFileViaAIVideo/
    // generateSceneImagesForFileViaAIVideo/generateVideosForFile đọc/ghi lại
    // "success" cho từng entry (xem storyboardPipeline.ts), và cũng là nơi
    // user upload ảnh/JSON thay thế (xem tryReplaceGeneratedFile/
    // tryHandleReferenceJsonUpload trong handlers.ts).
    const generatedDir = await ensureGeneratedFolder(filePath);
    const generatedFilePath = path.join(generatedDir, path.basename(filePath));

    const confirmId = createImageConfirmation(
      job.chatId,
      job.userId,
      job.promptMessageId,
      generatedFilePath,
    );
    await telegram!.sendMessage(job.chatId, "Xác nhận tạo ảnh", {
      reply_parameters: { message_id: job.promptMessageId },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Tạo ảnh",
              callback_data: `confirmImages:${confirmId}`,
            },
          ],
        ],
      },
    });
    confirmPromptsSent++;
  }

  return { processedJsonCount, confirmPromptsSent };
}

/**
 * GIỐNG runStoryboardPipeline HỆT (cùng lọc file .json, cùng
 * ensureGeneratedFolder, cùng quy ước ChatAIPipelineResult) nhưng gửi nút
 * "Tạo ảnh (Pollo)" (callback_data "confirmImagesPollo:<id>", xem
 * confirmImageGenerationPollo) THAY VÌ "Tạo ảnh" (AIVideo) — hàm RIÊNG,
 * KHÔNG sửa runStoryboardPipeline, theo đúng quy ước clone-theo-provider đã
 * dùng xuyên suốt (generateReferenceImagesForFileViaPollo, selectDurationIfNeeded,
 * v.v.) — không gộp chung 1 hàm rồi rẽ nhánh bên trong.
 *
 * Gọi RIÊNG (thêm 1 lượt sendMessage nữa) từ processChatAIQueue, SAU
 * runStoryboardPipeline — kết quả là 2 tin nhắn xác nhận tách biệt cho mỗi
 * file JSON (1 nút AIVideo, 1 nút Pollo) thay vì gộp 2 nút vào 1 tin nhắn.
 * Dùng createImageConfirmationPollo (map pendingImageConfirmationsPollo
 * RIÊNG, KHÔNG chung với pendingImageConfirmations của runStoryboardPipeline)
 * nên confirmId của 2 hàm là 2 id ĐỘC LẬP — user có thể bấm CẢ 2 nút (cả
 * AIVideo lẫn Pollo) nếu muốn, không loại trừ lẫn nhau.
 */
async function runStoryboardPipelinePollo(
  downloadedFiles: string[],
  /** Cũng nhận ScriptReferenceVideoJob/GenerateScriptJob — processScriptReferenceVideoQueue/processChatAIQueue (job "generateScript" dùng CHUNG hàng đợi với "chatAI") tái dùng HÀM NÀY để gửi nút "Tạo ảnh (Pollo)", chỉ cần các field chung của BaseJob (chatId/userId/promptMessageId). */
  job: ChatAIJob | ScriptReferenceVideoJob | GenerateScriptJob,
): Promise<ChatAIPipelineResult> {
  let processedJsonCount = 0;
  let confirmPromptsSent = 0;

  // Theo yêu cầu người dùng: job "chatAI" GIỮ NGUYÊN hành vi CŨ — MỖI file
  // JSON có folder RIÊNG theo đúng tên file đó (ensureGeneratedFolder/
  // generatedDirFor, nhánh else bên dưới): storage/generated/<file>/<file>.json.
  // Job KHÁC "chatAI" (ScriptReferenceVideoJob/GenerateScriptJob) dùng CHUNG 1
  // folder generated/<tên phim>/ cho MỌI file JSON của job
  // (job.generatedFolderName, set bởi processScriptReferenceVideoQueue/
  // processChatAIQueue ngay khi biết downloadedFiles) — chỉ archive/mkdir
  // folder phim này 1 LẦN DUY NHẤT trước khi lặp (xem
  // ensureGeneratedFolderForName), KHÔNG lặp lại cho từng file, nếu không sẽ
  // archive away chính (các) file tập trước vừa copy vào TRONG CÙNG batch.
  //
  // SỬA (theo yêu cầu người dùng): mỗi file JSON vẫn có 1 folder RIÊNG cùng
  // tên NẰM BÊN TRONG folder phim — storage/generated/<tên phim>/<file>/<file>.json
  // (KHÔNG copy phẳng thẳng vào gốc folder phim nữa) — để
  // generatedDirFor(jsonPath) (thư mục VIDEO) vẫn trỏ đúng riêng từng tập,
  // trong khi generatedImageDirFor(jsonPath) (thư mục ẢNH, xem
  // storyboardPipeline.ts) tự động trỏ lên đúng folder phim dùng CHUNG.
  const sharedFilmDir =
    job.type !== "chatAI" && job.generatedFolderName
      ? await ensureGeneratedFolderForName(job.generatedFolderName)
      : null;

  for (const filePath of downloadedFiles) {
    if (path.extname(filePath).toLowerCase() !== ".json") {
      continue;
    }
    processedJsonCount++;

    let generatedFilePath: string;
    if (sharedFilmDir) {
      const perTapDir = path.join(
        sharedFilmDir,
        path.basename(filePath, path.extname(filePath)),
      );
      await fsp.mkdir(perTapDir, { recursive: true });
      generatedFilePath = path.join(perTapDir, path.basename(filePath));
      await fsp.copyFile(filePath, generatedFilePath);
    } else {
      const generatedDir = await ensureGeneratedFolder(filePath);
      generatedFilePath = path.join(generatedDir, path.basename(filePath));
    }
    // Theo yêu cầu người dùng: sau khi đã COPY xong vào generated/, xoá luôn
    // bản gốc trong config.chatAIResultsDir (nơi askChatAI/downloadAttachedFiles
    // tải file JSON về ban đầu) — bản trong generated/ mới là bản chính thức
    // dùng cho pipeline gen ảnh/video từ đây trở đi, giữ lại bản gốc chỉ tổ
    // trùng lặp/rác. Không chặn job nếu xoá lỗi (best-effort).
    await fsp.unlink(filePath).catch((err) => {
      console.warn(
        `[queue] Không xoá được file gốc "${filePath}" trong chatai-results sau khi đã copy vào generated/:`,
        err,
      );
    });

    const confirmId = createImageConfirmationPollo(
      job.chatId,
      job.userId,
      job.promptMessageId,
      generatedFilePath,
    );
    // Theo yêu cầu người dùng: kèm tên file JSON (generated/) trong tin nhắn
    // xác nhận — nhiều tập/nhiều file cùng job (ScriptReferenceVideoJob/
    // GenerateScriptJob) sẽ gửi NHIỀU tin nhắn "Xác nhận tạo ảnh" liên tiếp,
    // không có tên file thì không phân biệt được nút nào ứng với tập nào.
    await telegram!.sendMessage(
      job.chatId,
      `Xác nhận tạo ảnh (${path.basename(generatedFilePath)})`,
      {
        reply_parameters: { message_id: job.promptMessageId },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Tạo ảnh",
                callback_data: `confirmImagesPollo:${confirmId}`,
              },
            ],
          ],
        },
      },
    );
    confirmPromptsSent++;
  }

  return { processedJsonCount, confirmPromptsSent };
}

function formatFailedEntries(entries: FailedEntry[]): string {
  return entries.map((e) => `- [${e.type}] ${e.id}`).join("\n");
}

async function notifyVideoSuccess(
  job: VideoGenerationJob,
  filePath: string,
): Promise<void> {
  if (!telegram) return;
  try {
    await telegram.sendVideo(
      job.chatId,
      { source: filePath },
      {
        caption: `✅ Video cho prompt: "${job.prompt.split(" ").slice(0, 20).join(" ")}"`,
        reply_parameters: { message_id: job.promptMessageId },
      },
    );
  } catch (err) {
    console.error("[queue] Gửi video thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * Báo cáo tổng kết job "storyboardVideo" (tạo video SAU KHI user bấm nút
 * "Tạo video" xác nhận, xem confirmVideoGeneration) — từng video đã được gửi
 * NGAY lúc tạo xong rồi (xem onEntryDone callback ở processVideoQueue), hàm
 * này chỉ còn báo lỗi/tổng kết.
 */
async function notifyStoryboardVideoResult(
  job: StoryboardVideoJob,
  result: GenerateVideosResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      recordFailedStoryboardJob(job);
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được video cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    if (result.succeeded > 0 && result.failed === 0) {
      await telegram.sendMessage(job.chatId, `✅ Đã tạo video xong`, {
        reply_parameters: { message_id: job.promptMessageId },
      });
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo video (xác nhận) thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * GIỐNG notifyStoryboardVideoResult HỆT nhưng cho job "storyboardVideoPollo"
 * (dùng pollo.ai) — hàm RIÊNG, gọi recordFailedStoryboardJobPollo (mảng
 * failedStoryboardJobsPollo RIÊNG) thay vì recordFailedStoryboardJob, theo
 * đúng yêu cầu clone-logic-không-dùng-chung-function-cũ.
 */
async function notifyStoryboardVideoResultPollo(
  job: StoryboardVideoPolloJob,
  result: GenerateVideosResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      recordFailedStoryboardJobPollo(job);
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được video cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    if (result.succeeded > 0 && result.failed === 0) {
      await telegram.sendMessage(job.chatId, `✅ Đã tạo video xong`, {
        reply_parameters: { message_id: job.promptMessageId },
      });
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo video (Pollo) thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * GIỐNG notifyStoryboardVideoResultPollo HỆT nhưng cho job
 * "storyboardVideoComfy" (dùng ComfyUI) — gọi recordFailedStoryboardJobComfy
 * (mảng failedStoryboardJobsComfy RIÊNG) thay vì recordFailedStoryboardJobPollo.
 */
async function notifyStoryboardVideoResultComfy(
  job: StoryboardVideoComfyJob,
  result: GenerateVideosResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      recordFailedStoryboardJobComfy(job);
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được video cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
      
    }
    if (result.succeeded > 0 && result.failed === 0) {
      await telegram.sendMessage(job.chatId, `✅ Đã tạo video xong`, {
        reply_parameters: { message_id: job.promptMessageId },
        ...promptMenu
      });
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo video (Comfy) thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * Báo cáo tổng kết job "storyboardImagesAIVideo" (CHARACTER/LOCATION) HOẶC
 * "storyboardSceneImagesAIVideo" (SCENE_SETTING) — 2 type RIÊNG dùng chung 1
 * hàm báo cáo vì cùng cấu trúc kết quả (xem generateReferenceImagesForFileViaAIVideo/
 * generateSceneImagesForFileViaAIVideo) — từng ảnh đã được gửi NGAY lúc tạo
 * xong rồi (xem onEntryDone callback ở processImageQueue), hàm này chỉ còn
 * báo lỗi/tổng kết.
 */
interface StoryboardImagesAIVideoResult {
  failedEntries: FailedEntry[];
  /** true nếu bước ảnh NÀY xong không lỗi — nút xác nhận bước tiếp theo ("Tạo ảnh scene" hoặc "Tạo video") đã gửi ở nơi gọi (processImageQueue), không cần báo thêm ở đây. */
  readyForNext: boolean;
}

async function notifyStoryboardImagesAIVideoResult(
  job: StoryboardImagesAIVideoJob | StoryboardSceneImagesAIVideoJob,
  result: StoryboardImagesAIVideoResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      recordFailedStoryboardJob(job);
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được ảnh cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    // readyForNext: nút xác nhận bước tiếp theo đã gửi ở nơi gọi
    // (processImageQueue) rồi, không cần báo thêm ở đây.
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo ảnh (aiVideo) thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * GIỐNG notifyStoryboardImagesAIVideoResult HỆT nhưng cho job
 * "storyboardImagesPollo"/"storyboardScenePollo" (dùng pollo.ai) — hàm RIÊNG,
 * gọi recordFailedStoryboardJobPollo thay vì recordFailedStoryboardJob, theo
 * đúng yêu cầu clone-logic-không-dùng-chung-function-cũ.
 */
async function notifyStoryboardImagesResultPollo(
  job: StoryboardImagesPolloJob | StoryboardSceneImagesPolloJob,
  result: StoryboardImagesAIVideoResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      recordFailedStoryboardJobPollo(job);
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được ảnh cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo ảnh (Pollo) thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

async function notifyImageSuccess(
  job: ImageGenerationJob,
  filePaths: string[],
): Promise<void> {
  if (!telegram) return;
  try {
    await sendGeneratedImages(job, filePaths);
  } catch (err) {
    console.error("[queue] Gửi ảnh thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * Mỗi lần generate trả về CẢ CỤM ảnh (thực tế xác nhận: 4 ảnh/lần) — gửi
 * chung 1 album (sendMediaGroup) để không spam nhiều tin nhắn rời. Nếu
 * album lỗi (vd 1 ảnh trong cụm bị Telegram từ chối), fallback gửi RIÊNG
 * từng ảnh bằng sendPhoto, rồi sendDocument nếu sendPhoto vẫn báo
 * "400: Bad Request: IMAGE_PROCESS_FAILED" (Telegram không xử lý/nén được
 * ảnh AI tạo ra) — sendDocument gửi file gốc nên đáng tin cậy hơn.
 */
async function sendGeneratedImages(
  job: ImageGenerationJob,
  filePaths: string[],
): Promise<void> {
  const caption = `✅ Ảnh cho prompt: "${job.prompt.split(" ").slice(0, 20).join(" ")}"`;
  try {
    await telegram!.sendMediaGroup(
      job.chatId,
      filePaths.map((filePath, i) => ({
        type: "photo" as const,
        media: { source: filePath },
        caption: i === 0 ? caption : undefined,
      })),
      { reply_parameters: { message_id: job.promptMessageId } },
    );
  } catch (err) {
    // console.warn("[queue] sendMediaGroup thất bại, gửi lần lượt từng ảnh:", err);
    for (const filePath of filePaths) {
      await sendGeneratedImage(
        job.chatId,
        filePath,
        caption,
        job.promptMessageId,
      );
    }
  }
}

async function sendGeneratedImage(
  chatId: number,
  filePath: string,
  caption: string,
  promptMessageId: number,
  /** Tên file THẬT hiện ra khi user tải về (tuỳ chọn) — không truyền thì Telegram dùng tên file gốc trên đĩa. */
  fileName?: string,
): Promise<void> {
  try {
    await telegram!.sendPhoto(
      chatId,
      { source: filePath, filename: fileName },
      {
        caption,
        reply_parameters: { message_id: promptMessageId },
      },
    );
  } catch (err) {
    await telegram!.sendDocument(
      chatId,
      { source: filePath, filename: fileName },
      {
        caption,
        reply_parameters: { message_id: promptMessageId },
      },
    );
  }
}

export async function sendNotifyError(
  chatId: number,
  jsonPath: string,
  fileId: string,
  promptMessageId: number,
): Promise<void> {
  try {
    const jsonBaseName = path.basename(jsonPath, path.extname(jsonPath));
    const message = buildResultCaption(jsonBaseName, fileId);
    await telegram!.sendMessage(chatId, message, {
      reply_parameters: { message_id: promptMessageId },
    });
  } catch (err) {}
}

/** Gửi 1 video đã tạo — dùng chung cho gửi NGAY lúc tạo (runStoryboardPipeline) và job "storyboardVideo" xác nhận (notifyStoryboardVideoResult). */
async function sendGeneratedVideo(
  chatId: number,
  filePath: string,
  caption: string,
  promptMessageId: number,
  fileName: string,
): Promise<void> {
  await telegram!.sendVideo(
    chatId,
    { source: filePath, filename: fileName },
    {
      caption,
      reply_parameters: { message_id: promptMessageId },
    },
  );
}

// Giới hạn upload THẬT của Telegram Bot API cho sendDocument là 50MB — xác
// nhận qua lỗi thật "413 Request Entity Too Large" khi gửi file zip video lớn
// (generated/.../videos.zip có thể vượt xa 50MB với nhiều video). Chừa
// dư 1MB làm an toàn (overhead multipart/form-data).
const TELEGRAM_MAX_DOCUMENT_BYTES = 49 * 1024 * 1024;

/**
 * Chia 1 file thành nhiều phần <= maxPartBytes, đặt tên
 * "<tên file>.part001", "<tên file>.part002", ... Đọc/ghi tuần tự bằng
 * buffer cố định — không load nguyên file zip video (có thể rất lớn) vào bộ
 * nhớ cùng lúc.
 */
async function splitFileIntoParts(
  filePath: string,
  maxPartBytes: number,
): Promise<string[]> {
  const partPaths: string[] = [];
  const fd = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxPartBytes);
    let partIndex = 1;
    while (true) {
      const { bytesRead } = await fd.read(buffer, 0, maxPartBytes, null);
      if (bytesRead === 0) break;
      const partPath = `${filePath}.part${String(partIndex).padStart(3, "0")}`;
      await fsp.writeFile(partPath, buffer.subarray(0, bytesRead));
      partPaths.push(partPath);
      partIndex++;
    }
  } finally {
    await fd.close();
  }
  return partPaths;
}

/**
 * Gửi 1 file qua sendDocument — nếu file vượt giới hạn upload thật của
 * Telegram Bot API (xem TELEGRAM_MAX_DOCUMENT_BYTES), KHÔNG gọi sendDocument
 * trực tiếp (chắc chắn lỗi 413) mà chia file thành nhiều phần rồi gửi từng
 * phần kèm hướng dẫn ghép lại — Bot API không có cách nào khác để gửi file
 * lớn hơn giới hạn này (trừ khi tự host Local Bot API Server, ngoài phạm vi ở
 * đây). Các file phần chỉ là tạm, xoá ngay sau khi gửi xong.
 */
async function sendDocumentMaybeSplit(
  chatId: number,
  filePath: string,
  caption: string,
  replyToMessageId: number,
): Promise<void> {
  const { size } = await fsp.stat(filePath);
  if (size <= TELEGRAM_MAX_DOCUMENT_BYTES) {
    await telegram!.sendDocument(
      chatId,
      { source: filePath },
      {
        caption,
        reply_parameters: { message_id: replyToMessageId },
        ...promptMenu,
      },
    );
    return;
  }

  const fileName = path.basename(filePath);
  const partPaths = await splitFileIntoParts(
    filePath,
    TELEGRAM_MAX_DOCUMENT_BYTES,
  );
  try {
    await telegram!.sendMessage(
      chatId,
      `📦 File "${fileName}" nặng ${(size / 1024 / 1024).toFixed(1)}MB, vượt giới hạn 50MB của Telegram Bot API — chia thành ${partPaths.length} phần. Tải hết các phần rồi ghép lại bằng lệnh (Linux/macOS):\ncat ${fileName}.part* > ${fileName}`,
      { reply_parameters: { message_id: replyToMessageId } },
    );
    for (const [idx, partPath] of partPaths.entries()) {
      await telegram!.sendDocument(
        chatId,
        { source: partPath },
        {
          caption: `${caption} (phần ${idx + 1}/${partPaths.length})`,
          reply_parameters: { message_id: replyToMessageId },
        },
      );
    }
  } finally {
    await Promise.all(partPaths.map((p) => fsp.unlink(p).catch(() => {})));
  }
}

/**
 * Job ChatAI giờ CHỈ hỏi ChatAI + gửi JSON + tạo folder generated/ +
 * gửi nút "Tạo ảnh" xác nhận (xem runStoryboardPipeline) — KHÔNG còn gen ảnh/
 * video đồng bộ trong job này nữa. Ảnh/video/lỗi tự báo riêng khi job
 * "storyboardImagesAIVideo"/"storyboardVideo" tới lượt xử lý SAU KHI user bấm
 * xác nhận (xem notifyStoryboardImagesAIVideoResult/notifyStoryboardVideoResult).
 * Hàm này chỉ còn báo "đã gửi nút xác nhận" hoặc "không có file đính kèm".
 */
async function notifyChatAISuccess(
  job: ChatAIJob | ScriptReferenceVideoJob | GenerateScriptJob,
  result: ChatAIPipelineResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.processedJsonCount === 0) {
      // ChatAI trả lời xong nhưng không có file JSON storyboard nào — không coi là lỗi.
      try {
        await telegram.sendMessage(
          job.chatId,
          `✅ ChatAI đã trả lời xong" (không có file đính kèm).`,
          {
            reply_parameters: { message_id: job.promptMessageId },
            ...promptMenu
          },
        );
      } catch (e) {}
    }
    // confirmPromptsSent > 0: nút "Tạo ảnh" đã gửi ở runStoryboardPipeline
    // rồi, không cần báo thêm ở đây.
  } catch (err) {
    console.error("[queue] Gửi kết quả ChatAI thất bại:", err);
    try {
      await telegram.sendMessage(job.chatId, "404", {
        reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
      });
    } catch (e) {}
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

function jobTypeLabel(type: GenerationJob["type"]): string {
  if (
    type === "video" ||
    type === "storyboardVideo" ||
    type === "storyboardVideoPollo" ||
    type === "storyboardVideoComfy"
  )
    return "video";
  if (
    type === "image" ||
    type === "storyboardImagesAIVideo" ||
    type === "storyboardSceneImagesAIVideo" ||
    type === "storyboardImagesPollo" ||
    type === "storyboardScenePollo"
  )
    return "ảnh";
  return "ChatAI";
}

async function notifyError(job: GenerationJob, err: unknown): Promise<void> {
  if (!telegram) return;

  console.error(`[queue] Tạo ${jobTypeLabel(job.type)} thất bại:`, err);
  await notifyAdmins(err);
  try {
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
      ...promptMenu,
    });
  } catch (e) {}
  await deleteStatusMessage(job);
}

async function deleteStatusMessage(job: GenerationJob): Promise<void> {
  if (job.statusMessageId) {
    await telegram!
      .deleteMessage(job.chatId, job.statusMessageId)
      .catch(() => {});
  }
}

async function notifyAdmins(err: unknown): Promise<void> {
  if (!config.adminsNotify) return;
  try {
    const message = err instanceof Error ? err.message : String(err);
    await telegram!.sendMessage(config.adminsNotify, message).catch(() => {});
  } catch (e) {}
}

