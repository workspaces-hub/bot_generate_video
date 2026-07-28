import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Telegram } from "telegraf";
import { config } from "./config";
import { generateVideo } from "./automation/hailuo";
import { generateImage } from "./automation/hailuoImage";

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
}

export interface ImageGenerationJob extends BaseJob {
  type: "image";
  referenceImagePaths?: string[];
}

export type GenerationJob = VideoGenerationJob | ImageGenerationJob;

const QUEUE_FILE = path.resolve("./storage/queue.json");

// Chỉ dữ liệu thuần (không callback/ctx) nên ghi được ra file — sống sót
// qua restart/crash. Job vẫn nằm trong mảng (và trong file) SUỐT lúc xử lý,
// chỉ gỡ ra sau khi thực sự xong (thành công/lỗi) — nếu bot crash giữa
// chừng lúc generate, job vẫn còn trong file để thử lại ở lần chạy sau.
const jobs: GenerationJob[] = [];
let processing = false;
let telegram: Telegram | null = null;

/** Gọi 1 lần lúc khởi động bot, trước khi có prompt nào được gửi. */
export function initQueue(botTelegram: Telegram): void {
  telegram = botTelegram;
  loadPersistedJobs();
  void processQueue();
}

function loadPersistedJobs(): void {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const restored: GenerationJob[] = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    if (restored.length > 0) {
      jobs.push(...restored);
      console.log(`[queue] Khôi phục ${restored.length} job còn dang dở từ lần chạy trước.`);
    }
  } catch (err) {
    console.error("[queue] Không đọc được file hàng đợi đã lưu, bỏ qua:", err);
  }
}

function persistJobs(): void {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobs, null, 2), "utf-8");
  } catch (err) {
    console.error("[queue] Không ghi được file hàng đợi:", err);
  }
}

/**
 * Chạy tuần tự từng job — video và ảnh dùng CHUNG 1 hàng đợi (1 browser
 * context, 1 job tại một thời điểm) để tránh nhiều tab cùng thao tác trên
 * cùng một tài khoản hailuoai.video.
 */
export function enqueueJob(job: GenerationJob): void {
  jobs.push(job);
  persistJobs();
  void processQueue();
}

export function getPendingCount(): number {
  return jobs.length + (processing ? 1 : 0);
}

async function processQueue(): Promise<void> {
  if (processing || !telegram) return;
  processing = true;
  try {
    while (jobs.length > 0) {
      const job = jobs[0];
      const jobId = randomUUID();
      try {
        const filePath =
          job.type === "video"
            ? await generateVideo(job.prompt, { resolution: job.resolution, model: job.model }, jobId)
            : await generateImage(job.prompt, { referenceImagePaths: job.referenceImagePaths }, jobId);
        await notifySuccess(job, filePath);
        await fsp.unlink(filePath).catch(() => {});
      } catch (err) {
        await notifyError(job, err);
      } finally {
        if (job.type === "image") {
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

async function notifySuccess(job: GenerationJob, filePath: string): Promise<void> {
  if (!telegram) return;
  const send =
    job.type === "video"
      ? telegram.sendVideo(job.chatId, { source: filePath }, {
          caption: `✅ Video cho prompt: "${job.prompt}"`,
          reply_parameters: { message_id: job.promptMessageId },
        })
      : telegram.sendPhoto(job.chatId, { source: filePath }, {
          caption: `✅ Ảnh cho prompt: "${job.prompt}"`,
          reply_parameters: { message_id: job.promptMessageId },
        });

  await send.catch(async (err) => {
    console.error(`[queue] Gửi ${job.type === "video" ? "video" : "ảnh"} thất bại:`, err);
    await telegram!.sendMessage(job.chatId, "404", {
      reply_parameters: { message_id: job.promptMessageId },
    });
    await notifyAdmins(err);
  });
  await deleteStatusMessage(job);
}

async function notifyError(job: GenerationJob, err: unknown): Promise<void> {
  if (!telegram) return;
  console.error(`[queue] Tạo ${job.type === "video" ? "video" : "ảnh"} thất bại:`, err);
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
