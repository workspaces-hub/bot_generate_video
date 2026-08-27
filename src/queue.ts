import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Telegraf, type Telegram } from "telegraf";
import { config } from "./config";
import { generateVideo } from "./automation/aiVideo";
import { generateImage } from "./automation/aiVideoImage";
import { askChatAI } from "./automation/chatAI";
import {
  clearStopStoryboardRequest,
  ensureGeneratedFolder,
  generatedDirFor,
  generateReferenceImagesForFileViaAIVideo,
  generateSceneImagesForFileViaAIVideo,
  generateVideosForFile,
  loadPersistedStopStoryboardRequests,
  requestStopStoryboardPipeline,
  sleep,
  type FailedEntry,
  type GenerateVideosResult,
  type StoryboardEntry,
} from "./automation/storyboardPipeline";

interface BaseJob {
  chatId: number;
  /** Telegram user id của người bấm/gõ tạo ra job này — dùng để "Stop All" chỉ dừng ĐÚNG job của user đã bấm, xem stopAll(). */
  userId: number;
  prompt: string;
  /** Tin nhắn prompt gốc — dùng để reply kết quả/404 vào đúng chỗ. */
  promptMessageId: number;
  /** Tin nhắn "⏳ Đang tạo..." — xoá đi khi job xong (nếu còn tồn tại). */
  statusMessageId?: number;
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
  /** Tên file .txt user upload làm prompt (nếu có) — dùng đặt tên lại file ChatAI trả về (xem askChatAI) thay vì tên ChatAI tự đặt. */
  promptFileName?: string;
  /** Path local file prompt (nếu user gửi qua upload file thay vì gõ text) — UPLOAD file này lên ChatAI, "prompt" lúc này chỉ là câu ngắn yêu cầu ChatAI đọc file (xem handlers.ts/askChatAI). Xoá file này sau khi job xong (finally trong processChatAIQueue). */
  promptAttachmentPath?: string;
}

/**
 * Job "tạo video" cho 1 file JSON storyboard — chỉ được tạo SAU KHI user bấm
 * nút "Tạo video" xác nhận (xem createVideoConfirmation/
 * confirmVideoGeneration), tránh tự động tốn credit AIVideo/ChatAI khi ảnh
 * chưa được user duyệt. Nằm trong hàng đợi VIDEO riêng (videoJobs) — KHÔNG
 * tự gen ảnh SCENE_SETTING nữa (việc đó thuộc về job
 * "storyboardImagesAIVideo" trong hàng đợi ẢNH, xem docstring job đó), job
 * này CHỈ gọi generateVideosForFile. Trước khi thực sự xử lý, hàng đợi video
 * LUÔN kiểm tra jsonPath: TOÀN BỘ entry type SCENE_SETTING phải đã
 * "success": true thì mới lấy ra xử lý — nếu chưa, bỏ qua (giữ nguyên vị trí
 * trong hàng đợi) và xét job tiếp theo, xem processVideoQueue.
 */
export interface StoryboardVideoJob extends BaseJob {
  type: "storyboardVideo";
  /** Path file JSON storyboard (ảnh CHARACTER/LOCATION/SCENE_SETTING phải đã xong) — truyền cho generateVideosForFile. */
  jsonPath: string;
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

export type GenerationJob = AIImageJob | AIVideoJob | ChatAIJob;

const IMAGE_QUEUE_FILE = path.resolve("./storage/image-queue.json");
const VIDEO_QUEUE_FILE = path.resolve("./storage/video-queue.json");
const CHATAI_QUEUE_FILE = path.resolve("./storage/chatai-queue.json");
const PENDING_VIDEO_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-video-confirmations.json",
);
const PENDING_IMAGE_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-image-confirmations.json",
);
const PENDING_SCENE_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-scene-confirmations.json",
);
const FAILED_STORYBOARD_JOBS_FILE = path.resolve(
  "./storage/failed-storyboard-jobs.json",
);

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
const chatAIJobs: ChatAIJob[] = [];
let chatAIProcessing = false;
let telegram: Telegram | null = null;

/** 3 loại job storyboard có thể lỗi/cần retry riêng — xem failedStoryboardJobs. */
type FailableStoryboardJob =
  | StoryboardVideoJob
  | StoryboardImagesAIVideoJob
  | StoryboardSceneImagesAIVideoJob;

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

/** Gọi 1 lần lúc khởi động bot, trước khi có prompt nào được gửi. */
export function initQueue(botTelegram: Telegram): void {
  telegram = botTelegram;
  loadPersistedImageJobs();
  loadPersistedVideoJobs();
  loadPersistedChatAIJobs();
  loadPersistedPendingVideoConfirmations();
  loadPersistedPendingImageConfirmations();
  loadPersistedPendingSceneConfirmations();
  loadPersistedFailedStoryboardJobs();
  loadPersistedStopStoryboardRequests();
  void processImageQueue();
  void processVideoQueue();
  void processChatAIQueue();
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

function loadPersistedChatAIJobs(): void {
  try {
    if (!fs.existsSync(CHATAI_QUEUE_FILE)) return;
    const restored: ChatAIJob[] = JSON.parse(
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

/**
 * Kiểm tra hàng đợi ẢNH/VIDEO đã có job ĐÚNG type + jsonPath này chưa (đang
 * CHỜ hoặc đang XỬ LÝ — job đang xử lý dở vẫn còn nằm trong mảng tới lúc
 * finally mới bị xoá, xem processImageQueue/processVideoQueue) — dùng để
 * tránh enqueue TRÙNG (xem tryRegenerateStoryboardItem trong handlers.ts):
 * job storyboard luôn xử lý LẠI TOÀN BỘ entry "success" chưa true trong file
 * (xem storyboardPipeline.ts), nên nếu đã có 1 job cùng type+jsonPath trong
 * hàng đợi, job đó tự khắc nhặt luôn entry vừa đánh dấu lại khi tới lượt —
 * không cần thêm job thứ 2 (chỉ tổ chạy trùng, tốn gấp đôi thời gian/credit).
 * Resolve path trước khi so sánh — cùng 1 file có thể truyền vào dưới dạng
 * path tương đối/tuyệt đối khác nhau tuỳ nơi gọi.
 */
export function isStoryboardJobQueued(
  type:
    | "storyboardImagesAIVideo"
    | "storyboardSceneImagesAIVideo"
    | "storyboardVideo",
  jsonPath: string,
): boolean {
  const resolvedPath = path.resolve(jsonPath);
  if (type === "storyboardVideo") {
    return videoJobs.some(
      (job) =>
        job.type === "storyboardVideo" &&
        path.resolve(job.jsonPath) === resolvedPath,
    );
  }
  return imageJobs.some(
    (job) => job.type === type && path.resolve(job.jsonPath) === resolvedPath,
  );
}

/**
 * Đẩy job vào ĐÚNG hàng đợi theo loại — ảnh, video, ChatAI mỗi loại 1 hàng
 * đợi riêng (xem chú thích AIImageJob/AIVideoJob), chạy độc lập không phải
 * chờ nhau.
 */
export function enqueueJob(job: GenerationJob): void {
  if (job.type === "chatAI") {
    chatAIJobs.push(job);
    persistChatAIJobs();
    void processChatAIQueue();
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

  const cancelledChatAIJobs: ChatAIJob[] = [];
  const chatAIStartIndex = chatAIProcessing ? 1 : 0;
  for (let i = chatAIJobs.length - 1; i >= chatAIStartIndex; i--) {
    if (chatAIJobs[i].userId === userId) {
      cancelledChatAIJobs.push(chatAIJobs[i]);
      chatAIJobs.splice(i, 1);
    }
  }
  if (cancelledChatAIJobs.length > 0) persistChatAIJobs();

  const cancelledOtherJobs: (AIImageJob | AIVideoJob)[] = [];

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

/** Tổng số job ảnh + video (AIVideo) còn đang chờ/xử lý dở, gộp cả 2 hàng đợi. */
export function getPendingCount(): number {
  return imageJobs.length + videoJobs.length;
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
 * SẴN SÀNG xử lý: job "video" thường luôn sẵn sàng; job "storyboardVideo"
 * chỉ sẵn sàng khi isJsonSceneSettingReady(jsonPath) — tức job
 * "storyboardImagesAIVideo" tương ứng (ở hàng đợi ẢNH) đã gen xong SCENE_
 * SETTING. Job CHƯA sẵn sàng bị BỎ QUA (không xoá/không đổi thứ tự trong
 * mảng) để xét job kế tiếp — theo đúng yêu cầu người dùng. Trả về -1 nếu
 * không có job nào sẵn sàng (hàng đợi rỗng, hoặc mọi job storyboardVideo còn
 * lại đều đang chờ ảnh SCENE_SETTING xong).
 */
function findNextReadyVideoJobIndex(): number {
  for (let i = 0; i < videoJobs.length; i++) {
    const job = videoJobs[i];
    if (job.type === "video" || isJsonSceneSettingReady(job.jsonPath)) {
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
          const jsonBaseName = path.basename(
            job.jsonPath,
            path.extname(job.jsonPath),
          );
          const sendImageNow = async (imagePath: string): Promise<void> => {
            const caption = buildResultCaption(jsonBaseName, imagePath);
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
              const message = buildResultCaption(jsonBaseName, id) + " 404";
              await notifyAdmins(message);
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
          const jsonBaseName = path.basename(
            job.jsonPath,
            path.extname(job.jsonPath),
          );
          const sendImageNow = async (imagePath: string): Promise<void> => {
            const caption = buildResultCaption(jsonBaseName, imagePath);
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
              const message = buildResultCaption(jsonBaseName, id) + " 404";
              await notifyAdmins(message);
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          };

          // SCENE_SETTING qua AIVideo — hàng đợi VIDEO (processVideoQueue)
          // chờ ĐÚNG field "success" của các entry SCENE_SETTING này để biết
          // job "storyboardVideo" tương ứng đã sẵn sàng xử lý chưa.
          const sceneResult = await generateSceneImagesForFileViaAIVideo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
          );
          const readyForVideo = sceneResult.failed === 0;

          // Ảnh xong không lỗi — LUÔN hỏi xác nhận qua nút "Tạo video" (2 chế
          // độ ChatAI giờ xác nhận giống nhau, xem docstring
          // StoryboardSceneImagesAIVideoJob) — KHÔNG tự động đẩy job
          // "storyboardVideo".
          if (readyForVideo) {
            const confirmId = createVideoConfirmation(
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
                      callback_data: `confirmVideo:${confirmId}`,
                    },
                  ],
                ],
              },
            });
          }

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
  } finally {
    imageProcessing = false;
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
          const jsonBaseName = path.basename(
            job.jsonPath,
            path.extname(job.jsonPath),
          );
          const videoResult = await generateVideosForFile(
            job.jsonPath,
            async (videoPath) => {
              const caption = buildResultCaption(jsonBaseName, videoPath);
              await sendGeneratedVideo(
                job.chatId,
                videoPath,
                caption,
                job.promptMessageId,
                `${caption}${path.extname(videoPath)}`,
              );
            },
            async (id: string): Promise<void> => {
              try {
                const message = buildResultCaption(jsonBaseName, id) + " 404";
                await notifyAdmins(message);
                await telegram!.sendMessage(job.chatId, message, {
                  reply_parameters: { message_id: job.promptMessageId },
                });
              } catch (err) {}
            },
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
  } finally {
    videoProcessing = false;
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
        const { downloadedFiles } = await askChatAI(
          job.prompt,
          jobId,
          job.promptFileName,
          job.promptAttachmentPath,
        );
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
        const result = await runStoryboardPipeline(downloadedFiles, job);
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
  } finally {
    chatAIProcessing = false;
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
  job: ChatAIJob,
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
      });
    } catch (e) {}
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

function jobTypeLabel(type: GenerationJob["type"]): string {
  if (type === "video" || type === "storyboardVideo") return "video";
  if (type === "image" || type === "storyboardImagesAIVideo") return "ảnh";
  return "ChatAI";
}

async function notifyError(job: GenerationJob, err: unknown): Promise<void> {
  if (!telegram) return;

  console.error(`[queue] Tạo ${jobTypeLabel(job.type)} thất bại:`, err);
  await notifyAdmins(err);
  try {
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
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
