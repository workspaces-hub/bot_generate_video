import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { getBrowserContext } from "./browser";
import {
  errorIndicatorCandidates,
  firstVisible,
  generateButtonCandidates,
  historyVideoLocator,
  promptInputCandidates,
  signInIndicatorCandidates,
} from "./selectors";

export class GenerationError extends Error {}

export async function generateVideo(prompt: string, jobId: string): Promise<string> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(config.hailuoCreatePath, config.hailuoBaseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await ensureLoggedIn(page);

    const promptInput = await firstVisible(promptInputCandidates(page));
    await promptInput.click();
    await promptInput.fill(prompt);

    await captureDebug(page, jobId, "before-generate-click");

    // Chụp baseline TRƯỚC khi bấm Generate để sau đó biết chính xác video
    // nào là MỚI (không phải video cũ nhất trong lịch sử — xem waitForNewVideo).
    const baseline = await captureVideoBaseline(page);

    const generateButton = await firstVisible(generateButtonCandidates(page));
    await generateButton.click();

    const newVideo = await waitForNewVideo(page, baseline, config.generationTimeoutMs);

    return await downloadVideo(page, newVideo, jobId);
  } catch (err) {
    await captureDebug(page, jobId, err);
    throw err instanceof GenerationError ? err : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

async function ensureLoggedIn(page: Page): Promise<void> {
  const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
    .then(() => true)
    .catch(() => false);
  if (signedOut) {
    throw new GenerationError(
      "Chưa đăng nhập hailuoai.video hoặc session đã hết hạn. Chạy lại: npm run login",
    );
  }
}

interface VideoBaseline {
  count: number;
  firstSrc: string | null;
  lastSrc: string | null;
}

async function captureVideoBaseline(page: Page): Promise<VideoBaseline> {
  const videos = historyVideoLocator(page);
  const count = await videos.count();
  return {
    count,
    firstSrc: count > 0 ? await videos.first().getAttribute("src") : null,
    lastSrc: count > 0 ? await videos.last().getAttribute("src") : null,
  };
}

/**
 * Chờ tới khi có video MỚI xuất hiện trong lịch sử (count tăng so với
 * baseline), rồi tự phát hiện video mới nằm ở đầu hay cuối danh sách bằng
 * cách so sánh src với baseline — không giả định cố định .first()/.last().
 */
async function waitForNewVideo(page: Page, baseline: VideoBaseline, timeoutMs: number): Promise<Locator> {
  const videos = historyVideoLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;

  while (Date.now() - start < timeoutMs) {
    const count = await videos.count();
    if (count > baseline.count) {
      const currentFirstSrc = await videos.first().getAttribute("src");
      if (currentFirstSrc !== baseline.firstSrc) {
        return videos.first();
      }
      return videos.last();
    }

    const failed = await firstVisible(errorIndicatorCandidates(page), 1000)
      .then(() => true)
      .catch(() => false);
    if (failed) {
      throw new GenerationError("Website báo lỗi khi tạo video");
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(`Hết thời gian chờ tạo video (timeout ${timeoutMs}ms)`);
}

async function downloadVideo(page: Page, video: Locator, jobId: string): Promise<string> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
  const filePath = path.join(config.downloadDir, `${jobId}.mp4`);

  const src = await video.getAttribute("src");
  if (!src) {
    throw new GenerationError("Video mới không có thuộc tính src để tải xuống");
  }

  const absoluteUrl = new URL(src, page.url()).toString();
  const response = await page.context().request.get(absoluteUrl);
  if (!response.ok()) {
    throw new GenerationError(`Tải video thất bại: HTTP ${response.status()}`);
  }
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}

async function captureDebug(page: Page, jobId: string, err: unknown): Promise<void> {
  try {
    await fs.promises.mkdir(config.debugDir, { recursive: true });
    await page.screenshot({ path: path.join(config.debugDir, `${jobId}.png`), fullPage: true });
    await fs.promises.writeFile(
      path.join(config.debugDir, `${jobId}.html`),
      await page.content(),
      "utf-8",
    );
  } catch (debugErr) {
    console.error("[hailuo] Không thể lưu debug snapshot:", debugErr);
  }
  console.error(`[hailuo] Job ${jobId} lỗi:`, err);
}
