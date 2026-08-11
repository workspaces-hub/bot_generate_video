import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Telegraf, type Telegram } from "telegraf";
import { config } from "./config";
import { generateVideo } from "./automation/hailuo";
import { generateImage } from "./automation/hailuoImage";
import { askChatGpt } from "./automation/chatgpt";
import {
  clearStopStoryboardRequest,
  generateReferenceImagesForFileViaHailuo,
  generateSceneImagesForFile,
  generateSceneImagesForFileViaHailuo,
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

export interface GptJob extends BaseJob {
  type: "gpt";
  /** true = chỉ hỏi GPT rồi gửi lại NGUYÊN file tải về (vd JSON storyboard) để check nhanh — KHÔNG chạy runStoryboardPipeline (không gen ảnh/video). */
  skipPipeline?: boolean;
  /** Tên file .txt user upload làm prompt (nếu có) — dùng đặt tên lại file GPT trả về (xem askChatGpt) thay vì tên GPT tự đặt. */
  promptFileName?: string;
  /** Path local file prompt (nếu user gửi qua upload file thay vì gõ text) — UPLOAD file này lên chatgpt.com, "prompt" lúc này chỉ là câu ngắn yêu cầu GPT đọc file (xem handlers.ts/askChatGpt). Xoá file này sau khi job xong (finally trong processGptQueue). */
  promptAttachmentPath?: string;
}

/**
 * Job "tạo video" cho 1 file JSON storyboard ĐÃ gen xong ảnh CHARACTER/
 * LOCATION/SCENE_SETTING (từ luồng "Check prompt kịch bản") — chỉ được tạo
 * SAU KHI user bấm nút "Tạo video" xác nhận (xem createVideoConfirmation/
 * confirmVideoGeneration), tránh tự động tốn credit hailuoai.video khi ảnh
 * chưa được user duyệt. Dùng chung hàng đợi `jobs` (HailuoJob) với video/ảnh
 * thường — CÙNG browser context hailuoai.video, phải xếp hàng tuần tự như
 * nhau (xem docstring HailuoJob).
 */
export interface StoryboardVideoJob extends BaseJob {
  type: "storyboardVideo";
  /** Path file JSON storyboard (đã gen ảnh xong) — truyền cho generateVideosForFile. */
  jsonPath: string;
}

/**
 * Job "tạo ảnh cho 1 file JSON storyboard" — CHARACTER/LOCATION qua
 * hailuoai.video (generateReferenceImagesForFileViaHailuo) THAY VÌ hỏi GPT,
 * rồi SCENE_SETTING qua GPT (generateSceneImagesForFile — chưa có bản hailuo)
 * — dùng chung hàng đợi `jobs` (HailuoJob) với video/ảnh/storyboardVideo
 * thường, CÙNG cơ chế/lý do với StoryboardVideoJob: generateImage()
 * (hailuoImage.ts) dùng CHUNG browser context hailuoai.video với
 * generateVideo(), nên phải xếp hàng tuần tự qua CÙNG 1 hàng đợi để tránh 2
 * tab thao tác đồng thời trên cùng tài khoản (chấp nhận việc bước
 * SCENE_SETTING — dùng chatgpt.com, không thật sự cần xếp hàng với
 * hailuoai.video — vẫn chiếm lượt trong hàng đợi này, đổi lấy 1 hàng đợi duy
 * nhất đơn giản hơn, theo yêu cầu người dùng).
 */
export interface StoryboardImagesHailuoJob extends BaseJob {
  type: "storyboardImagesHailuo";
  /** Path file JSON storyboard — truyền cho generateReferenceImagesForFileViaHailuo/generateSceneImagesForFile. */
  jsonPath: string;
  /** true = luồng "Tạo video từ kịch bản" (GptJob.skipPipeline=false) — ảnh xong (không lỗi) tự đẩy job "storyboardVideo" luôn. false = luồng "Check prompt kịch bản" (GptJob.skipPipeline=true) — ảnh xong chỉ hỏi xác nhận qua nút "Tạo video" (xem createVideoConfirmation). */
  autoQueueVideo: boolean;
}

/** Job dùng chung 1 browser context (hailuoai.video) — video/ảnh/storyboardVideo/storyboardImagesHailuo cùng site nên phải xếp hàng tuần tự. */
type HailuoJob =
  | VideoGenerationJob
  | ImageGenerationJob
  | StoryboardVideoJob
  | StoryboardImagesHailuoJob;

export type GenerationJob = HailuoJob | GptJob;

const QUEUE_FILE = path.resolve("./storage/queue.json");
const GPT_QUEUE_FILE = path.resolve("./storage/gpt-queue.json");

// Chỉ dữ liệu thuần (không callback/ctx) nên ghi được ra file — sống sót
// qua restart/crash. Job vẫn nằm trong mảng (và trong file) SUỐT lúc xử lý,
// chỉ gỡ ra sau khi thực sự xong (thành công/lỗi) — nếu bot crash giữa
// chừng lúc generate, job vẫn còn trong file để thử lại ở lần chạy sau.
//
// GPT dùng browser context RIÊNG (chatgpt.com, khác domain/session với
// hailuoai.video) nên KHÔNG cần xếp chung hàng đợi với video/ảnh — tách
// thành 2 hàng đợi độc lập (2 mảng, 2 file lưu, 2 vòng xử lý riêng) để job
// GPT không phải chờ video/ảnh xử lý xong mới tới lượt, và ngược lại.
const jobs: HailuoJob[] = [];
let processing = false;
const gptJobs: GptJob[] = [];
let gptProcessing = false;
let telegram: Telegram | null = null;

/** Gọi 1 lần lúc khởi động bot, trước khi có prompt nào được gửi. */
export function initQueue(botTelegram: Telegram): void {
  telegram = botTelegram;
  loadPersistedJobs();
  loadPersistedGptJobs();
  void processQueue();
  void processGptQueue();
}

function loadPersistedJobs(): void {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const restored: HailuoJob[] = JSON.parse(
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

function loadPersistedGptJobs(): void {
  try {
    if (!fs.existsSync(GPT_QUEUE_FILE)) return;
    const restored: GptJob[] = JSON.parse(
      fs.readFileSync(GPT_QUEUE_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      gptJobs.push(...restored);
      console.log(
        `[queue] Khôi phục ${restored.length} job GPT còn dang dở từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[queue] Không đọc được file hàng đợi GPT đã lưu, bỏ qua:",
      err,
    );
  }
}

function persistGptJobs(): void {
  try {
    fs.mkdirSync(path.dirname(GPT_QUEUE_FILE), { recursive: true });
    fs.writeFileSync(GPT_QUEUE_FILE, JSON.stringify(gptJobs, null, 2), "utf-8");
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi GPT:", err);
  }
}

/**
 * Đẩy job vào ĐÚNG hàng đợi theo loại — video/ảnh dùng chung 1 hàng đợi (1
 * browser context hailuoai.video, 1 job tại một thời điểm để tránh nhiều tab
 * cùng thao tác trên cùng tài khoản), GPT dùng hàng đợi riêng (browser
 * context khác hẳn, chạy độc lập không phải chờ video/ảnh).
 */
export function enqueueJob(job: GenerationJob): void {
  if (job.type === "gpt") {
    gptJobs.push(job);
    persistGptJobs();
    void processGptQueue();
    return;
  }
  jobs.push(job);
  persistJobs();
  void processQueue();
}

export interface StopAllResult {
  cancelledGptJobs: number;
  /** Job "video" (characterImagePath, từ CHARACTER_REF_BUTTON_LABEL), "storyboardVideo" (nút "Tạo video" xác nhận) VÀ "storyboardImagesHailuo" có autoQueueVideo=true (từ GPT_BUTTON_LABEL, xem runStoryboardPipeline) còn đang chờ, đã huỷ. */
  cancelledVideoJobs: number;
}

/**
 * Nút "Stop All" (xem STOP_ALL_BUTTON_LABEL trong keyboard.ts) — dừng SỚM
 * các job của CHARACTER_REF_BUTTON_LABEL (job "video" có characterImagePath),
 * GPT_BUTTON_LABEL (toàn bộ hàng đợi GPT + job "storyboardImagesHailuo" có
 * autoQueueVideo=true mà nó đẩy ra), VÀ job "storyboardVideo" (video gen từ
 * nút "Tạo video" xác nhận sau "Check prompt kịch bản"). "storyboardImagesHailuo"
 * có autoQueueVideo=false (từ Check prompt kịch bản) KHÔNG bị huỷ — ngoài
 * phạm vi CHARACTER_REF_BUTTON_LABEL/GPT_BUTTON_LABEL yêu cầu ban đầu.
 *
 * 1. requestStopStoryboardPipeline(): báo hiệu vòng lặp generateReferenceImagesForFile/
 *    generateReferenceImagesForFileViaHailuo/generateSceneImagesForFile/
 *    generateVideosForFile ĐANG CHẠY (nếu có, từ 1 job GPT không skipPipeline,
 *    1 job "storyboardImagesHailuo", hoặc 1 job "storyboardVideo") dừng SAU
 *    KHI entry đang generate dở xong (không abort giữa chừng) — xem docstring
 *    hàm này trong storyboardPipeline.ts.
 * 2. Xoá TOÀN BỘ job GPT còn đang CHỜ trong hàng đợi (chưa tới lượt xử lý) —
 *    job GPT ĐANG xử lý dở (index 0, nếu gptProcessing) không thể huỷ giữa
 *    chừng askChatGpt, chỉ dừng sớm được các vòng lặp gen ảnh/video bên trong
 *    nó qua bước 1.
 * 3. Xoá job "video" có characterImagePath (từ CHARACTER_REF_BUTTON_LABEL),
 *    "storyboardVideo" (từ nút "Tạo video" xác nhận), VÀ "storyboardImagesHailuo"
 *    có autoQueueVideo=true còn đang CHỜ trong hàng đợi video/ảnh — job ĐANG
 *    xử lý dở (index 0, nếu processing) không thể huỷ giữa chừng
 *    generateVideo/generateImage trên hailuoai.video, để chạy xong/lỗi tự
 *    nhiên (vòng lặp gen nhiều entry bên trong nó vẫn dừng sớm được qua bước
 *    1 ở trên).
 *
 * Báo cho từng user có job bị huỷ biết (reply đúng tin nhắn prompt gốc).
 */
export function stopAll(): StopAllResult {
  requestStopStoryboardPipeline();

  const gptStartIndex = gptProcessing ? 1 : 0;
  const cancelledGptJobs = gptJobs.splice(gptStartIndex);
  if (cancelledGptJobs.length > 0) persistGptJobs();

  const jobsStartIndex = processing ? 1 : 0;
  const cancelledVideoJobs: HailuoJob[] = [];
  for (let i = jobs.length - 1; i >= jobsStartIndex; i--) {
    const job = jobs[i];
    if (
      (job.type === "video" && job.characterImagePath) ||
      job.type === "storyboardVideo" ||
      (job.type === "storyboardImagesHailuo" && job.autoQueueVideo)
    ) {
      cancelledVideoJobs.push(job);
      jobs.splice(i, 1);
    }
  }
  if (cancelledVideoJobs.length > 0) persistJobs();

  for (const job of [...cancelledGptJobs, ...cancelledVideoJobs]) {
    void notifyJobCancelled(job);
  }

  return {
    cancelledGptJobs: cancelledGptJobs.length,
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

// In-memory (không ghi ra file như jobs/gptJobs) — chỉ sống trong lúc bot
// đang chạy, cùng quy ước với các Map "pending" khác trong handlers.ts (vd
// pendingOmniRefBuffers). Nếu bot restart trước khi user bấm nút, phải hỏi
// GPT lại — chấp nhận được vì đây chỉ là bước xác nhận ngắn hạn, không phải
// job cần sống sót qua crash như jobs/gptJobs.
const pendingVideoConfirmations = new Map<string, PendingVideoConfirmation>();

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
  return confirmId;
}

/**
 * User bấm nút "Tạo video" — tra lại jsonPath theo confirmId rồi đẩy job
 * "storyboardVideo" vào hàng đợi hailuoai.video (xem StoryboardVideoJob).
 * Trả về false nếu confirmId không tồn tại/đã dùng (vd bấm 2 lần, hoặc bot đã
 * restart mất state) — caller (handlers.ts) tự báo lỗi phù hợp.
 */
export function confirmVideoGeneration(confirmId: string): boolean {
  const pending = pendingVideoConfirmations.get(confirmId);
  if (!pending) return false;
  pendingVideoConfirmations.delete(confirmId);
  enqueueJob({
    type: "storyboardVideo",
    chatId: pending.chatId,
    prompt: "",
    promptMessageId: pending.promptMessageId,
    jsonPath: pending.jsonPath,
  });
  return true;
}

/**
 * Đẩy job "gen ảnh CHARACTER/LOCATION qua hailuoai.video thay vì GPT" cho 1
 * file JSON storyboard vào hàng đợi `jobs` (xem StoryboardImagesHailuoJob) —
 * hàm export sẵn để nơi khác (vd handlers.ts, khi cần thêm entry point cho
 * user) gọi tới, chưa gắn UI/nút bấm nào.
 */
export function enqueueStoryboardImagesHailuo(
  chatId: number,
  promptMessageId: number,
  jsonPath: string,
  autoQueueVideo: boolean,
): void {
  enqueueJob({
    type: "storyboardImagesHailuo",
    chatId,
    prompt: "",
    promptMessageId,
    jsonPath,
    autoQueueVideo,
  });
}

export function getPendingCount(): number {
  return jobs.length + (processing ? 1 : 0);
}

export function getGptPendingCount(): number {
  return gptJobs.length + (gptProcessing ? 1 : 0);
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
          const result = await generateVideosForFile(
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
          await notifyStoryboardVideoResult(job, result);
        } else if (job.type === "storyboardImagesHailuo") {
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
          const notifyError = async (id: string): Promise<void> => {
            try {
              const message = buildResultCaption(jsonBaseName, id) + " 404";
              await telegram!.sendMessage(job.chatId, message, {
                reply_parameters: { message_id: job.promptMessageId },
              });
            } catch (err) {}
          };

          // Bước 1: CHARACTER/LOCATION qua hailuoai.video (thay GPT).
          const failedEntries: FailedEntry[] = [];
          const imagesResult = await generateReferenceImagesForFileViaHailuo(
            job.jsonPath,
            sendImageNow,
            notifyError,
          );
          failedEntries.push(...imagesResult.failedEntries);

          // Bước 2: SCENE_SETTING vẫn qua GPT (chưa có bản hailuo) — chỉ
          // chạy tiếp khi bước 1 không lỗi entry nào.
          let readyForVideo = false;
          if (imagesResult.failed === 0) {
            const sceneResult = await generateSceneImagesForFileViaHailuo(
              job.jsonPath,
              sendImageNow,
              notifyError,
            );
            failedEntries.push(...sceneResult.failedEntries);
            readyForVideo = sceneResult.failed === 0;
          }

          // Bước 3: ảnh xong hết — tự tạo video luôn (luồng "Tạo video từ
          // kịch bản") hoặc hỏi xác nhận qua nút (luồng "Check prompt kịch
          // bản") — xem docstring StoryboardImagesHailuoJob.
          if (readyForVideo) {
            if (job.autoQueueVideo) {
              enqueueJob({
                type: "storyboardVideo",
                chatId: job.chatId,
                prompt: "",
                promptMessageId: job.promptMessageId,
                jsonPath: job.jsonPath,
              });
            } else {
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
          }

          await notifyStoryboardImagesHailuoResult(job, {
            failedEntries,
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
          job.type === "storyboardImagesHailuo"
        ) {
          // Reset cờ "Stop All" SAU KHI job này (có thể đang bị dừng sớm) đã
          // thực sự thoát hẳn — không reset thì job storyboardVideo/
          // storyboardImagesHailuo/GPT MỚI sau đó sẽ bị chặn nhầm ngay từ đầu
          // (xem stopAll()/requestStopStoryboardPipeline, cùng lý do đã xử lý
          // ở processGptQueue).
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

async function processGptQueue(): Promise<void> {
  if (gptProcessing || !telegram) return;
  gptProcessing = true;
  try {
    while (gptJobs.length > 0) {
      const job = gptJobs[0];
      const jobId = randomUUID();
      try {
        const { downloadedFiles } = await askChatGpt(
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
        if (job.skipPipeline) {
          const checkResult = await runGptCheckImagePipeline(
            downloadedFiles,
            job,
          );
          await notifyGptCheckSuccess(job, checkResult);
        } else {
          const result = await runStoryboardPipeline(downloadedFiles, job);
          await notifyGptSuccess(job, result);
        }
      } catch (err) {
        await notifyError(job, err);
      } finally {
        if (job.promptAttachmentPath) {
          await fsp.unlink(job.promptAttachmentPath).catch(() => {});
        }
        gptJobs.shift();
        persistGptJobs();
        // Reset cờ "Stop All" SAU KHI job này (có thể đang bị dừng sớm) đã
        // thực sự thoát hẳn — không reset thì job GPT MỚI sau đó sẽ bị chặn
        // nhầm ngay từ đầu (xem stopAll()/requestStopStoryboardPipeline).
        clearStopStoryboardRequest();
        // Chờ giữa các lần gọi gen json (askChatGpt) liên tiếp — tránh gửi
        // request quá nhanh lên chatgpt.com (theo yêu cầu người dùng). Chỉ
        // chờ khi còn job kế tiếp, tránh delay vô ích lúc hàng đợi đã hết.
        if (gptJobs.length > 0) {
          await sleep(15000);
        }
      }
    }
  } finally {
    gptProcessing = false;
  }
}

interface GptPipelineResult {
  /** Số file JSON storyboard THẬT SỰ được xử lý (bỏ qua file không phải .json) — dùng phân biệt "không có file đính kèm" với "có file nhưng chưa gen ảnh". */
  processedJsonCount: number;
  /** Số file JSON đã đẩy job "storyboardImagesHailuo" vào hàng đợi hailuoai.video (xem enqueueJob trong runStoryboardPipeline) — ảnh/video tạo/gửi SAU, KHÔNG đồng bộ với job GPT này. */
  queuedImageFiles: number;
}

/** "<tên file json>__<tên file>" — quy ước caption/tên file dùng chung cho ảnh VÀ video gửi về user, xem processQueue (nhánh "storyboardImagesHailuo"/"storyboardVideo"). */
function buildResultCaption(
  jsonBaseName: string,
  resultFilePath: string,
): string {
  return `${jsonBaseName}__${path.parse(resultFilePath).name}`;
}

/**
 * Với MỖI file JSON storyboard GPT tải về (thường chỉ 1, vd meta.json — file
 * KHÔNG phải .json bị bỏ qua, không xử lý): đẩy job "storyboardImagesHailuo"
 * (autoQueueVideo=true) vào hàng đợi hailuoai.video (xem StoryboardImagesHailuoJob)
 * — KHÔNG tự gen ảnh/video ở đây nữa. Lý do: hàm này chạy BÊN TRONG job GPT
 * (hàng đợi riêng, xem processGptQueue), trong khi việc gen ảnh/video dùng
 * browser context hailuoai.video CHUNG với hàng đợi `jobs`
 * (video/ảnh/storyboardVideo/storyboardImagesHailuo) — gọi trực tiếp ở đây
 * có thể chạy CÙNG LÚC với 1 job khác đang xử lý ở hàng đợi kia, mở 2 tab
 * thao tác đồng thời trên cùng 1 tài khoản, dễ xung đột/crash. Đẩy vào hàng
 * đợi `jobs` đảm bảo LUÔN xếp hàng tuần tự. Job "storyboardImagesHailuo" tự
 * gen CHARACTER/LOCATION (hailuoai.video) → SCENE_SETTING (GPT) → tự đẩy
 * tiếp job "storyboardVideo" khi cả 2 bước ảnh xong không lỗi, gửi kết quả
 * riêng (xem processQueue) — KHÔNG đồng bộ/không nằm trong kết quả trả về
 * của hàm này.
 */
async function runStoryboardPipeline(
  downloadedFiles: string[],
  job: GptJob,
): Promise<GptPipelineResult> {
  let processedJsonCount = 0;
  let queuedImageFiles = 0;

  for (const filePath of downloadedFiles) {
    if (path.extname(filePath).toLowerCase() !== ".json") {
      continue;
    }
    processedJsonCount++;

    enqueueJob({
      type: "storyboardImagesHailuo",
      chatId: job.chatId,
      prompt: "",
      promptMessageId: job.promptMessageId,
      jsonPath: filePath,
      autoQueueVideo: true,
    });
    queuedImageFiles++;
  }

  return { processedJsonCount, queuedImageFiles };
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
 * Báo cáo tổng kết job "storyboardImagesHailuo" (gen ảnh CHARACTER/LOCATION
 * qua hailuoai.video thay vì GPT, xem generateReferenceImagesForFileViaHailuo)
 * — từng ảnh đã được gửi NGAY lúc tạo xong rồi (xem onEntryDone callback ở
 * processQueue), hàm này chỉ còn báo lỗi/tổng kết.
 */
interface StoryboardImagesHailuoResult {
  /** Gộp lỗi từ CẢ 2 bước: CHARACTER/LOCATION (hailuo) VÀ SCENE_SETTING (GPT). */
  failedEntries: FailedEntry[];
  /** true nếu cả 2 bước ảnh đều xong không lỗi — job "storyboardVideo" đã được đẩy vào hàng đợi HOẶC nút "Tạo video" đã gửi (xem nơi gọi trong processQueue). */
  readyForVideo: boolean;
}

async function notifyStoryboardImagesHailuoResult(
  job: StoryboardImagesHailuoJob,
  result: StoryboardImagesHailuoResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.failedEntries.length > 0) {
      await telegram.sendMessage(
        job.chatId,
        `⚠️ Không tạo được ảnh cho ${result.failedEntries.length} entry:\n${formatFailedEntries(result.failedEntries)}`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    } else if (result.readyForVideo && job.autoQueueVideo) {
      await telegram.sendMessage(
        job.chatId,
        `✅ Đã tạo xong ảnh — đã đưa vào hàng đợi tạo video, sẽ gửi video ngay khi xong.`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
    // readyForVideo && !autoQueueVideo: nút "Tạo video" đã gửi ở nơi gọi
    // (processQueue) rồi, không cần báo thêm ở đây.
  } catch (err) {
    console.error("[queue] Gửi kết quả tạo ảnh (hailuo) thất bại:", err);
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
// (reference-images/.../videos.zip có thể vượt xa 50MB với nhiều video). Chừa
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

interface GptCheckPipelineResult {
  /** File JSON storyboard GPT trả về — gửi lại nguyên bản để user kiểm tra nội dung. */
  jsonFiles: string[];
  /** Số file JSON đã đẩy job "storyboardImagesHailuo" (autoQueueVideo=false) vào hàng đợi hailuoai.video — ảnh/nút xác nhận tạo video tự gửi SAU, KHÔNG đồng bộ với job GPT này. */
  queuedImageFiles: number;
}

/**
 * Dùng cho job "Check prompt kịch bản" (GptJob.skipPipeline = true): với mỗi
 * file JSON storyboard GPT trả về, đẩy job "storyboardImagesHailuo"
 * (autoQueueVideo=false — xem StoryboardImagesHailuoJob) vào hàng đợi
 * hailuoai.video — KHÔNG tự gen ảnh ở đây nữa, CÙNG lý do/cơ chế với
 * runStoryboardPipeline (tránh 2 tab thao tác đồng thời trên cùng tài
 * khoản). Job đó tự gen CHARACTER/LOCATION (hailuoai.video) → SCENE_SETTING
 * (GPT) rồi hỏi xác nhận qua nút "Tạo video" khi cả 2 bước xong không lỗi.
 */
async function runGptCheckImagePipeline(
  downloadedFiles: string[],
  job: GptJob,
): Promise<GptCheckPipelineResult> {
  const jsonFiles: string[] = [];
  let queuedImageFiles = 0;

  for (const filePath of downloadedFiles) {
    if (path.extname(filePath).toLowerCase() !== ".json") continue;
    jsonFiles.push(filePath);

    enqueueJob({
      type: "storyboardImagesHailuo",
      chatId: job.chatId,
      prompt: "",
      promptMessageId: job.promptMessageId,
      jsonPath: filePath,
      autoQueueVideo: false,
    });
    queuedImageFiles++;
  }

  return { jsonFiles, queuedImageFiles };
}

/**
 * Dùng cho job "Check prompt kịch bản" (GptJob.skipPipeline = true) — job
 * GPT giờ CHỈ hỏi GPT + gửi JSON + đẩy job "storyboardImagesHailuo" (xem
 * runGptCheckImagePipeline), KHÔNG gen ảnh đồng bộ trong job này nữa. Ảnh/
 * nút xác nhận tạo video/lỗi tự báo riêng khi job đó tới lượt xử lý (xem
 * notifyStoryboardImagesHailuoResult). Hàm này chỉ còn báo "đã đưa vào hàng
 * đợi" hoặc "không có file đính kèm".
 */
async function notifyGptCheckSuccess(
  job: GptJob,
  result: GptCheckPipelineResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.jsonFiles.length === 0) {
      await telegram.sendMessage(
        job.chatId,
        `✅ GPT đã trả lời xong (không có file đính kèm).`,
        {
          reply_parameters: { message_id: job.promptMessageId },
        },
      );
    } else if (result.queuedImageFiles > 0) {
      await telegram.sendMessage(
        job.chatId,
        `✅ Đã đưa ${result.queuedImageFiles} file vào hàng đợi tạo ảnh (hailuoai.video).`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả check GPT thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

/**
 * Job GPT giờ CHỈ hỏi GPT + gửi JSON + đẩy job "storyboardImagesHailuo" vào
 * hàng đợi hailuoai.video (xem runStoryboardPipeline) — KHÔNG còn gen ảnh/
 * video đồng bộ trong job này nữa. Ảnh/video/lỗi tự báo riêng khi job đó tới
 * lượt xử lý (xem notifyStoryboardImagesHailuoResult/notifyStoryboardVideoResult).
 * Hàm này chỉ còn báo "đã đưa vào hàng đợi" hoặc "không có file đính kèm".
 */
async function notifyGptSuccess(
  job: GptJob,
  result: GptPipelineResult,
): Promise<void> {
  if (!telegram) return;
  try {
    if (result.processedJsonCount === 0) {
      // GPT trả lời xong nhưng không có file JSON storyboard nào — không coi là lỗi.
      await telegram.sendMessage(
        job.chatId,
        `✅ GPT đã trả lời xong" (không có file đính kèm).`,
        {
          reply_parameters: { message_id: job.promptMessageId },
        },
      );
    } else if (result.queuedImageFiles > 0) {
      await telegram.sendMessage(
        job.chatId,
        `✅ Đã đưa ${result.queuedImageFiles} file vào hàng đợi tạo ảnh (hailuoai.video), sẽ tự tạo video sau khi ảnh xong.`,
        { reply_parameters: { message_id: job.promptMessageId } },
      );
    }
  } catch (err) {
    console.error("[queue] Gửi kết quả GPT thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

function jobTypeLabel(type: GenerationJob["type"]): string {
  if (type === "video" || type === "storyboardVideo") return "video";
  if (type === "image" || type === "storyboardImagesHailuo") return "ảnh";
  return "GPT";
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

// runGptCheckImagePipeline(
//   ["/root/vm_ai/bot/storage/chatgpt-results/cay_khe_test.json"],
//   {
//     chatId: -1004294978405,
//     prompt: "Hãy thực hiện yêu cầu trong file",
//     promptMessageId: 375,
//     statusMessageId: 376,
//     type: "gpt",
//     skipPipeline: false,
//     promptFileName: "cay_khe_test",
//   },
// );
