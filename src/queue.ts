import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { generateVideo } from "./automation/hailuo";

export interface VideoJob {
  chatId: number;
  prompt: string;
  resolution?: string;
  model?: string;
  onSuccess: (filePath: string) => Promise<void>;
  onError: (err: unknown) => Promise<void>;
}

const jobs: VideoJob[] = [];
let processing = false;

/**
 * Chạy tuần tự từng job (1 browser context, 1 video tại một thời điểm)
 * để tránh nhiều tab cùng thao tác trên cùng một tài khoản hailuoai.video.
 */
export function enqueueJob(job: VideoJob): void {
  jobs.push(job);
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (jobs.length > 0) {
      const job = jobs.shift();
      if (!job) continue;
      const jobId = randomUUID();
      try {
        const filePath = await generateVideo(
          job.prompt,
          { resolution: job.resolution, model: job.model },
          jobId,
        );
        await job.onSuccess(filePath);
        await fs.unlink(filePath).catch(() => {});
      } catch (err) {
        await job.onError(err);
      }
    }
  } finally {
    processing = false;
  }
}
