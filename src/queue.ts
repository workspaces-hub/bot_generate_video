import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Telegram } from "telegraf";
import { config } from "./config";
import { generateVideo } from "./automation/hailuo";
import { generateImage } from "./automation/hailuoImage";
import { askChatGpt } from "./automation/chatgpt";

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
}

/** Job dùng chung 1 browser context (hailuoai.video) — video và ảnh cùng site nên phải xếp hàng tuần tự. */
type HailuoJob = VideoGenerationJob | ImageGenerationJob;

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
    const restored: HailuoJob[] = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    if (restored.length > 0) {
      jobs.push(...restored);
      console.log(`[queue] Khôi phục ${restored.length} job video/ảnh còn dang dở từ lần chạy trước.`);
    }
  } catch (err) {
    console.error("[queue] Không đọc được file hàng đợi video/ảnh đã lưu, bỏ qua:", err);
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
    const restored: GptJob[] = JSON.parse(fs.readFileSync(GPT_QUEUE_FILE, "utf-8"));
    if (restored.length > 0) {
      gptJobs.push(...restored);
      console.log(`[queue] Khôi phục ${restored.length} job GPT còn dang dở từ lần chạy trước.`);
    }
  } catch (err) {
    console.error("[queue] Không đọc được file hàng đợi GPT đã lưu, bỏ qua:", err);
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
        } else {
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
          if (job.startFramePath) await fsp.unlink(job.startFramePath).catch(() => {});
          if (job.characterImagePath) await fsp.unlink(job.characterImagePath).catch(() => {});
          for (const p of job.referenceImagePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
          for (const p of job.omniReferencePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
        } else {
          for (const p of job.referenceImagePaths ?? []) {
            await fsp.unlink(p).catch(() => {});
          }
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
        const { downloadedFiles } = await askChatGpt(job.prompt, jobId);
        await notifyGptSuccess(job, downloadedFiles);
      } catch (err) {
        await notifyError(job, err);
      } finally {
        gptJobs.shift();
        persistGptJobs();
      }
    }
  } finally {
    gptProcessing = false;
  }
}

async function notifyVideoSuccess(job: VideoGenerationJob, filePath: string): Promise<void> {
  if (!telegram) return;
  try {
    await telegram.sendVideo(job.chatId, { source: filePath }, {
      caption: `✅ Video cho prompt: "${job.prompt.split(" ").slice(0,20).join(" ")}"`,
      reply_parameters: { message_id: job.promptMessageId },
    });
  } catch (err) {
    console.error("[queue] Gửi video thất bại:", err);
    await telegram.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
    });
    await notifyAdmins(err);
  }
  await deleteStatusMessage(job);
}

async function notifyImageSuccess(job: ImageGenerationJob, filePaths: string[]): Promise<void> {
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
async function sendGeneratedImages(job: ImageGenerationJob, filePaths: string[]): Promise<void> {
  const caption = `✅ Ảnh cho prompt: "${job.prompt.split(" ").slice(0,20).join(" ")}"`;
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
    console.warn("[queue] sendMediaGroup thất bại, gửi lần lượt từng ảnh:", err);
    for (const filePath of filePaths) {
      await sendGeneratedImage(job, filePath, caption);
    }
  }
}

async function sendGeneratedImage(job: ImageGenerationJob, filePath: string, caption: string): Promise<void> {
  try {
    await telegram!.sendPhoto(job.chatId, { source: filePath }, {
      caption,
      reply_parameters: { message_id: job.promptMessageId },
    });
  } catch (err) {
    console.warn("[queue] sendPhoto thất bại, thử lại bằng sendDocument (gửi file gốc, không nén):", filePath, err);
    await telegram!.sendDocument(job.chatId, { source: filePath }, {
      caption,
      reply_parameters: { message_id: job.promptMessageId },
    });
  }
}

/**
 * Gửi lại mọi file GPT đính kèm (nếu có) đã tải về trong lúc hỏi đáp (xem
 * downloadAttachedFiles trong chatgpt.ts) — GPT tự tạo sẵn kết quả thành
 * file, không còn tự parse/merge code block JSON để tạo file result riêng
 * nữa. Không xoá các file sau khi gửi — giữ làm lưu trữ, khác video/ảnh chỉ
 * là file tạm.
 */
async function notifyGptSuccess(
  job: GptJob,
  downloadedFiles: string[],
): Promise<void> {
  if (!telegram) return;
  const promptPreview = job.prompt.split(" ").slice(0, 20).join(" ");
  try {
    if (downloadedFiles.length === 0) {
      // GPT trả lời xong nhưng không có file đính kèm nào — không coi là lỗi.
      await telegram.sendMessage(job.chatId, `✅ GPT đã trả lời xong cho prompt: "${promptPreview}" (không có file đính kèm).`, {
        reply_parameters: { message_id: job.promptMessageId },
      });
    }
    for (const [i, downloadedFile] of downloadedFiles.entries()) {
      await telegram.sendDocument(job.chatId, { source: downloadedFile }, {
        caption:
          i === 0
            ? `✅ Kết quả GPT cho prompt: "${promptPreview}"`
            : `📎 ${path.basename(downloadedFile)}`,
        reply_parameters: { message_id: job.promptMessageId },
      });
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
  if (type === "video") return "video";
  if (type === "image") return "ảnh";
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
    await telegram!.deleteMessage(job.chatId, job.statusMessageId).catch(() => {});
  }
}

async function notifyAdmins(err: unknown): Promise<void> {
  if (!config.adminsNotify) return;
  const message = err instanceof Error ? err.message : String(err);
  await telegram!.sendMessage(config.adminsNotify, message).catch(() => {});
}
