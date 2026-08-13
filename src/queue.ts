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
  requestStopStoryboardPipeline,
  sleep,
  type FailedEntry,
  type GenerateVideosResult,
} from "./automation/storyboardPipeline";

interface BaseJob {
  chatId: number;
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
 * Job "tạo video" cho 1 file JSON storyboard ĐÃ gen xong ảnh CHARACTER/
 * LOCATION (job "storyboardImagesAIVideo") — chỉ được tạo SAU KHI user bấm
 * nút "Tạo video" xác nhận (xem createVideoConfirmation/
 * confirmVideoGeneration), tránh tự động tốn credit AIVideo/ChatAI khi ảnh
 * chưa được user duyệt. Job này tự gen SCENE_SETTING (qua AIVideo, xem
 * generateSceneImagesForFileViaAIVideo) TRƯỚC, rồi mới tạo video — dời từ
 * job "storyboardImagesAIVideo" sang đây để cả 2 chế độ ChatAI (Tạo video từ
 * kịch bản/Check prompt kịch bản) đều hỏi xác nhận GIỐNG NHAU 2 bước (Tạo
 * ảnh CHARACTER/LOCATION → Tạo video, trong đó SCENE_SETTING đi kèm bước
 * video). Dùng chung hàng đợi `jobs` (AIVideoJob) với video/ảnh thường —
 * CÙNG browser context AIVideo, phải xếp hàng tuần tự như nhau (xem
 * docstring AIVideoJob).
 */
export interface StoryboardVideoJob extends BaseJob {
  type: "storyboardVideo";
  /** Path file JSON storyboard (đã gen ảnh CHARACTER/LOCATION xong) — truyền cho generateSceneImagesForFileViaAIVideo rồi generateVideosForFile. */
  jsonPath: string;
}

/**
 * Job "tạo ảnh CHARACTER/LOCATION cho 1 file JSON storyboard" qua AIVideo
 * (generateReferenceImagesForFileViaAIVideo) — chỉ được tạo SAU KHI user bấm
 * nút "Tạo ảnh" xác nhận (xem createImageConfirmation/confirmImageGeneration),
 * GIỐNG NHAU cho cả 2 chế độ ChatAI (Tạo video từ kịch bản/Check prompt kịch
 * bản — xem processChatAIQueue). Ảnh xong không lỗi thì hỏi tiếp xác nhận
 * "Tạo video" (xem createVideoConfirmation) — KHÔNG tự động đẩy job
 * "storyboardVideo". Dùng chung hàng đợi `jobs` (AIVideoJob) với video/ảnh/
 * storyboardVideo thường — CÙNG browser context AIVideo, phải xếp hàng tuần
 * tự như nhau (xem docstring AIVideoJob).
 */
export interface StoryboardImagesAIVideoJob extends BaseJob {
  type: "storyboardImagesAIVideo";
  /** Path file JSON storyboard — truyền cho generateReferenceImagesForFileViaAIVideo. */
  jsonPath: string;
}

/** Job dùng chung 1 browser context (AIVideo) — video/ảnh/storyboardVideo/storyboardImagesAIVideo cùng site nên phải xếp hàng tuần tự. */
type AIVideoJob =
  | VideoGenerationJob
  | ImageGenerationJob
  | StoryboardVideoJob
  | StoryboardImagesAIVideoJob;

export type GenerationJob = AIVideoJob | ChatAIJob;

const QUEUE_FILE = path.resolve("./storage/queue.json");
const CHATAI_QUEUE_FILE = path.resolve("./storage/chatai-queue.json");
const PENDING_VIDEO_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-video-confirmations.json",
);
const PENDING_IMAGE_CONFIRMATIONS_FILE = path.resolve(
  "./storage/pending-image-confirmations.json",
);
const FAILED_STORYBOARD_JOBS_FILE = path.resolve(
  "./storage/failed-storyboard-jobs.json",
);

// Chỉ dữ liệu thuần (không callback/ctx) nên ghi được ra file — sống sót
// qua restart/crash. Job vẫn nằm trong mảng (và trong file) SUỐT lúc xử lý,
// chỉ gỡ ra sau khi thực sự xong (thành công/lỗi) — nếu bot crash giữa
// chừng lúc generate, job vẫn còn trong file để thử lại ở lần chạy sau.
//
// ChatAI dùng browser context RIÊNG (ChatAI, khác domain/session với
// AIVideo) nên KHÔNG cần xếp chung hàng đợi với video/ảnh — tách
// thành 2 hàng đợi độc lập (2 mảng, 2 file lưu, 2 vòng xử lý riêng) để job
// ChatAI không phải chờ video/ảnh xử lý xong mới tới lượt, và ngược lại.
const jobs: AIVideoJob[] = [];
let processing = false;
const chatAIJobs: ChatAIJob[] = [];
let chatAIProcessing = false;
let telegram: Telegram | null = null;

/**
 * Lưu lại job "storyboardVideo"/"storyboardImagesAIVideo" NGAY sau khi xử lý
 * xong mà có ÍT NHẤT 1 entry lỗi (ảnh hoặc video) — xem
 * notifyStoryboardVideoResult/notifyStoryboardImagesAIVideoResult. Ghi ra
 * file (FAILED_STORYBOARD_JOBS_FILE) SAU MỖI lần thêm — sống sót qua
 * restart/crash, GIỐNG jobs/chatAIJobs — dùng để tra cứu nhanh job nào vừa
 * lỗi, xem getFailedStoryboardJobs().
 */
const failedStoryboardJobs: (StoryboardVideoJob | StoryboardImagesAIVideoJob)[] =
  [];

export function getFailedStoryboardJobs(): (
  | StoryboardVideoJob
  | StoryboardImagesAIVideoJob
)[] {
  return failedStoryboardJobs;
}

function loadPersistedFailedStoryboardJobs(): void {
  try {
    if (!fs.existsSync(FAILED_STORYBOARD_JOBS_FILE)) return;
    const restored: (StoryboardVideoJob | StoryboardImagesAIVideoJob)[] =
      JSON.parse(fs.readFileSync(FAILED_STORYBOARD_JOBS_FILE, "utf-8"));
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
 * Nút "Tiếp tục tạo video" (xem CONTINUE_VIDEO_BUTTON_LABEL) — user nhập tên
 * file json, tra trong failedStoryboardJobs xem có job nào jsonPath chứa tên
 * đó không (nghĩa là ĐÃ generate ảnh/video trước đó nhưng lỗi giữa chừng).
 * PHẢI thoả CẢ 2 điều kiện mới cho tiếp tục:
 * 1. Folder generated/<tên file>/ tồn tại trên đĩa (đã từng xử lý qua, không
 *    phải gõ nhầm tên file chưa tồn tại bao giờ).
 * 2. Có job trong failedStoryboardJobs khớp tên (đã lỗi, cần retry — job
 *    chưa từng lỗi hoặc đã xong rồi thì không có gì để "tiếp tục").
 *
 * Nếu thoả cả 2: xoá job đó khỏi failedStoryboardJobs rồi enqueue LẠI CHÍNH
 * job đó với type "storyboardVideo" (giữ nguyên chatId/promptMessageId/
 * jsonPath — dù job cũ là "storyboardImagesAIVideo" (lỗi ở bước ảnh
 * CHARACTER/LOCATION) hay "storyboardVideo" (lỗi ở bước SCENE_SETTING/video),
 * chuyển sang "storyboardVideo" đều xử lý lại được TOÀN BỘ ảnh/video còn dở
 * — generateReferenceImagesForFileViaAIVideo/generateSceneImagesForFileViaAIVideo/
 * generateVideosForFile đều tự resume theo field "success" trên từng entry,
 * xem storyboardPipeline.ts). Trả về false nếu không thoả — caller
 * (handlers.ts) tự báo "chưa được xử lý, không thể tiếp tục".
 */
export function continueFailedStoryboardVideo(jsonFileName: string): boolean {
  const folderExists = fs.existsSync(generatedDirFor(jsonFileName));
  const failedIndex = failedStoryboardJobs.findIndex((j) =>
    j.jsonPath.includes(jsonFileName),
  );
  if (!folderExists || failedIndex === -1) {
    return false;
  }

  const [failedJob] = failedStoryboardJobs.splice(failedIndex, 1);
  persistFailedStoryboardJobs();

  enqueueJob({
    type: "storyboardVideo",
    chatId: failedJob.chatId,
    prompt: failedJob.prompt,
    promptMessageId: failedJob.promptMessageId,
    jsonPath: failedJob.jsonPath,
  });
  return true;
}

/** Gọi 1 lần lúc khởi động bot, trước khi có prompt nào được gửi. */
export function initQueue(botTelegram: Telegram): void {
  telegram = botTelegram;
  loadPersistedJobs();
  loadPersistedChatAIJobs();
  loadPersistedPendingVideoConfirmations();
  loadPersistedPendingImageConfirmations();
  loadPersistedFailedStoryboardJobs();
  void processQueue();
  void processChatAIQueue();
}

function loadPersistedJobs(): void {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const restored: AIVideoJob[] = JSON.parse(
      fs.readFileSync(QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      jobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job video/ảnh còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi video/ảnh đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistJobs(): void {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobs, null, 2), "utf-8");
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi video/ảnh:", err);
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
 * Đẩy job vào ĐÚNG hàng đợi theo loại — video/ảnh dùng chung 1 hàng đợi (1
 * browser context AIVideo, 1 job tại một thời điểm để tránh nhiều tab
 * cùng thao tác trên cùng tài khoản), ChatAI dùng hàng đợi riêng (browser
 * context khác hẳn, chạy độc lập không phải chờ video/ảnh).
 */
export function enqueueJob(job: GenerationJob): void {
  if (job.type === "chatAI") {
    chatAIJobs.push(job);
    persistChatAIJobs();
    void processChatAIQueue();
    return;
  }
  jobs.push(job);
  persistJobs();
  void processQueue();
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
 * 1. requestStopStoryboardPipeline(): báo hiệu vòng lặp generateReferenceImagesForFile/
 *    generateReferenceImagesForFileViaAIVideo/generateSceneImagesForFile/
 *    generateVideosForFile ĐANG CHẠY (nếu có, từ 1 job "storyboardImagesAIVideo"
 *    hoặc 1 job "storyboardVideo") dừng SAU KHI entry đang generate dở xong
 *    (không abort giữa chừng) — xem docstring hàm này trong
 *    storyboardPipeline.ts.
 * 2. Xoá TOÀN BỘ job ChatAI còn đang CHỜ trong hàng đợi (chưa tới lượt xử lý) —
 *    job ChatAI ĐANG xử lý dở (index 0, nếu chatAIProcessing) không thể huỷ giữa
 *    chừng askChatAI, chỉ dừng sớm được các vòng lặp gen ảnh/video bên trong
 *    nó qua bước 1.
 * 3. Xoá job "video" có characterImagePath (từ CHARACTER_REF_BUTTON_LABEL),
 *    "storyboardVideo" VÀ "storyboardImagesAIVideo" còn đang CHỜ trong hàng
 *    đợi video/ảnh — job ĐANG xử lý dở (index 0, nếu processing) không thể
 *    huỷ giữa chừng generateVideo/generateImage trên AIVideo, để chạy
 *    xong/lỗi tự nhiên (vòng lặp gen nhiều entry bên trong nó vẫn dừng sớm
 *    được qua bước 1 ở trên).
 *
 * Báo cho từng user có job bị huỷ biết (reply đúng tin nhắn prompt gốc).
 */
export function stopAll(): StopAllResult {
  requestStopStoryboardPipeline();

  const chatAIStartIndex = chatAIProcessing ? 1 : 0;
  const cancelledChatAIJobs = chatAIJobs.splice(chatAIStartIndex);
  if (cancelledChatAIJobs.length > 0) persistChatAIJobs();

  const jobsStartIndex = processing ? 1 : 0;
  const cancelledVideoJobs: AIVideoJob[] = [];
  for (let i = jobs.length - 1; i >= jobsStartIndex; i--) {
    const job = jobs[i];
    if (
      job.type === "storyboardVideo" ||
      job.type === "storyboardImagesAIVideo"
    ) {
      cancelledVideoJobs.push(job);
      jobs.splice(i, 1);
    }
  }
  if (cancelledVideoJobs.length > 0) persistJobs();

  for (const job of [...cancelledChatAIJobs, ...cancelledVideoJobs]) {
    void notifyJobCancelled(job);
  }

  return {
    cancelledChatAIJobs: cancelledChatAIJobs.length,
    cancelledVideoJobs: cancelledVideoJobs.length,
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
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingVideoConfirmations.set(confirmId, {
    jsonPath,
    chatId,
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
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

interface PendingImageConfirmation {
  jsonPath: string;
  chatId: number;
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
  promptMessageId: number,
  jsonPath: string,
): string {
  const confirmId = randomUUID();
  pendingImageConfirmations.set(confirmId, {
    jsonPath,
    chatId,
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
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

export function getPendingCount(): number {
  return jobs.length + (processing ? 1 : 0);
}

export function getChatAIPendingCount(): number {
  return chatAIJobs.length + (chatAIProcessing ? 1 : 0);
}

async function processQueue(): Promise<void> {
  if (processing || !telegram) return;
  processing = true;
  try {
    while (jobs.length > 0) {
      const job = jobs[0];
      const jobId = randomUUID();
      try {
        if (job.type === "video") {
          const filePath = await generateVideo(
            job.prompt,
            {
              resolution: job.resolution,
              model: job.model,
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
              await telegram!.sendMessage(config.adminsNotify, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          };

          // Bước 1: SCENE_SETTING qua AIVideo — dời từ job
          // "storyboardImagesAIVideo" sang đây (SAU khi user đã bấm "Tạo
          // video" xác nhận), xem docstring StoryboardVideoJob.
          const sceneResult = await generateSceneImagesForFileViaAIVideo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
          );

          // Bước 2: chỉ tạo video khi SCENE_SETTING không lỗi entry nào.
          let videoResult: GenerateVideosResult = {
            outputDir: sceneResult.outputDir,
            succeeded: 0,
            failed: 0,
            failedEntries: [],
          };
          if (sceneResult.failed === 0) {
            videoResult = await generateVideosForFile(
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
            );
          }

          await notifyStoryboardVideoResult(job, {
            outputDir: videoResult.outputDir,
            succeeded: videoResult.succeeded,
            failed: sceneResult.failed + videoResult.failed,
            failedEntries: [
              ...sceneResult.failedEntries,
              ...videoResult.failedEntries,
            ],
          });
        } else if (job.type === "storyboardImagesAIVideo") {
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

          // CHARACTER/LOCATION qua AIVideo (thay ChatAI) — SCENE_SETTING dời
          // sang job "storyboardVideo" (xem docstring 2 job này).
          const imagesResult = await generateReferenceImagesForFileViaAIVideo(
            job.jsonPath,
            sendImageNow,
            notifyImageError,
          );
          const readyForVideo = imagesResult.failed === 0;

          // Ảnh xong không lỗi — LUÔN hỏi xác nhận qua nút "Tạo video" (2 chế
          // độ ChatAI giờ xác nhận giống nhau, xem docstring
          // StoryboardImagesAIVideoJob) — KHÔNG còn tự động đẩy job
          // "storyboardVideo".
          if (readyForVideo) {
            const confirmId = createVideoConfirmation(
              job.chatId,
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

          await notifyStoryboardImagesAIVideoResult(job, {
            failedEntries: imagesResult.failedEntries,
            readyForVideo,
          });
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
        } else if (job.type === "image") {
          for (const p of job.referenceImagePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
        }
        if (
          job.type === "storyboardVideo" ||
          job.type === "storyboardImagesAIVideo"
        ) {
          // Reset cờ "Stop All" SAU KHI job này (có thể đang bị dừng sớm) đã
          // thực sự thoát hẳn — không reset thì job storyboardVideo/
          // storyboardImagesAIVideo/ChatAI MỚI sau đó sẽ bị chặn nhầm ngay từ đầu
          // (xem stopAll()/requestStopStoryboardPipeline, cùng lý do đã xử lý
          // ở processChatAIQueue).
          clearStopStoryboardRequest();
        }
        jobs.shift();
        persistJobs();
      }
    }
  } finally {
    processing = false;
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
        // Reset cờ "Stop All" SAU KHI job này (có thể đang bị dừng sớm) đã
        // thực sự thoát hẳn — không reset thì job ChatAI MỚI sau đó sẽ bị chặn
        // nhầm ngay từ đầu (xem stopAll()/requestStopStoryboardPipeline).
        clearStopStoryboardRequest();
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

/** "<tên file json>__<tên file>" — quy ước caption/tên file dùng chung cho ảnh VÀ video gửi về user, xem processQueue (nhánh "storyboardImagesAIVideo"/"storyboardVideo"). */
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
 * NGAY lúc tạo xong rồi (xem onEntryDone callback ở processQueue), hàm này
 * chỉ còn báo lỗi/tổng kết.
 */
async function notifyStoryboardVideoResult(
  job: StoryboardVideoJob,
  result: GenerateVideosResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      failedStoryboardJobs.push(job);
      persistFailedStoryboardJobs();
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được video cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    if (result.succeeded === 0) {
      await telegram.sendMessage(
        job.chatId,
        `✅ Đã xử lý xong nhưng không tạo được video nào.`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
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
 * Báo cáo tổng kết job "storyboardImagesAIVideo" (gen ảnh CHARACTER/LOCATION
 * qua AIVideo thay vì ChatAI, xem generateReferenceImagesForFileViaAIVideo)
 * — từng ảnh đã được gửi NGAY lúc tạo xong rồi (xem onEntryDone callback ở
 * processQueue), hàm này chỉ còn báo lỗi/tổng kết.
 */
interface StoryboardImagesAIVideoResult {
  failedEntries: FailedEntry[];
  /** true nếu ảnh xong không lỗi — nút "Tạo video" đã gửi (xem nơi gọi trong processQueue). */
  readyForVideo: boolean;
}

async function notifyStoryboardImagesAIVideoResult(
  job: StoryboardImagesAIVideoJob,
  result: StoryboardImagesAIVideoResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      failedStoryboardJobs.push(job);
      persistFailedStoryboardJobs();
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được ảnh cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    // readyForVideo: nút "Tạo video" đã gửi ở nơi gọi (processQueue) rồi,
    // không cần báo thêm ở đây.
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
      await telegram.sendMessage(
        job.chatId,
        `✅ ChatAI đã trả lời xong" (không có file đính kèm).`,
        {
          reply_parameters: { message_id: job.promptMessageId },
        },
      );
    }
    // confirmPromptsSent > 0: nút "Tạo ảnh" đã gửi ở runStoryboardPipeline
    // rồi, không cần báo thêm ở đây.
  } catch (err) {
    console.error("[queue] Gửi kết quả ChatAI thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
    });
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
  await telegram.sendMessage(job.chatId, "404", {
    reply_parameters: { message_id: job.promptMessageId },
  });
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
  const message = err instanceof Error ? err.message : String(err);
  await telegram!.sendMessage(config.adminsNotify, message).catch(() => {});
}
