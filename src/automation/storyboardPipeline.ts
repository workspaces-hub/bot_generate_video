import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateReferenceImage } from "./chatgptImage";
import { generateVideo, type GenerateVideoOptions } from "./hailuo";

/**
 * Logic dùng CHUNG cho cả 2 nơi gọi: script CLI (scripts/generate-reference-images.ts,
 * scripts/generate-videos.ts) và bot Telegram (xử lý job "gpt" trong
 * src/queue.ts, sau khi askChatGpt tải về file JSON storyboard) — tránh viết
 * trùng cùng 1 logic ở 2 chỗ.
 */

export interface StoryboardRefItem {
  id?: string;
  type?: string;
}

export interface StoryboardEntry {
  type?: string;
  id?: string;
  ref?: StoryboardRefItem[];
  prompt?: string;
  duration?: number;
  /** true/false nếu đã từng generate (ảnh hoặc video) — không có field này nghĩa là CHƯA TỪNG chạy. */
  error?: boolean;
  [key: string]: unknown;
}

/** Chỉ giữ ký tự an toàn cho tên file — id trong JSON input có thể chứa dấu cách/ký tự lạ. */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Thư mục reference-images/<tên file input, bỏ đuôi> — DÙNG CHUNG giữa bước tạo ảnh và tạo video của CÙNG 1 file input. */
export function referenceImagesDirFor(inputPath: string): string {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.resolve("./storage/reference-images", baseName);
}

export interface FailedEntry {
  id: string;
  type: string;
}

export interface GenerateImagesResult {
  outputDir: string;
  charactersDir: string;
  locationsDir: string;
  succeeded: number;
  failed: number;
  failedEntries: FailedEntry[];
}

/**
 * Đọc 1 file JSON storyboard (list entry {type, id, prompt, ...} — output
 * của tính năng GPT storyboard, xem askChatGpt/downloadAttachedFiles trong
 * chatgpt.ts), lọc entry CHARACTER/LOCATION (bỏ qua VIDEO vì đó là prompt tạo
 * VIDEO, không phải ảnh), rồi lần lượt nhờ GPT tạo ảnh cho từng entry và tải
 * về reference-images/<tên file input>/characters|locations/<id>.<đuôi>.
 *
 * Chạy TUẦN TỰ từng entry (không song song) — cùng 1 browser context
 * chatgpt.com dùng chung, tránh nhiều tab cùng thao tác gây xung đột.
 *
 * Entry nào generate lỗi được đánh dấu "error": true, thành công thì
 * "error": false — LUÔN ghi tường minh (không xoá field), để phân biệt được
 * với entry CHƯA TỪNG chạy. Sau khi xử lý xong HẾT (kể cả có lỗi), ghi đè lại
 * TOÀN BỘ mảng vào đúng file input gốc.
 */
export async function generateReferenceImagesForFile(
  inputPath: string,
): Promise<GenerateImagesResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = referenceImagesDirFor(inputPath);
  const charactersDir = path.join(outputDir, "characters");
  const locationsDir = path.join(outputDir, "locations");
  await fs.promises.mkdir(charactersDir, { recursive: true });
  await fs.promises.mkdir(locationsDir, { recursive: true });

  const targets = entries.filter(
    (e): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> & StoryboardEntry => {
      if (e.type !== "CHARACTER" && e.type !== "LOCATION") return false;
      if (!e.id || !e.prompt) {
        console.warn(`[storyboardPipeline] Bỏ qua entry thiếu "id"/"prompt":`, e);
        return false;
      }
      return true;
    },
  );
  console.log(
    `[storyboardPipeline] Tìm thấy ${targets.length} entry CHARACTER/LOCATION trong ${entries.length} entry (${inputPath}).`,
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  for (const entry of targets) {
    const destDir = entry.type === "CHARACTER" ? charactersDir : locationsDir;
    const jobId = randomUUID();
    console.log(`[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh...`);
    try {
      const savedPath = await generateReferenceImage(
        entry.prompt,
        destDir,
        sanitizeId(entry.id),
        jobId,
      );
      console.log(`[storyboardPipeline] [${entry.type}] ${entry.id} — đã lưu: ${savedPath}`);
      entry.error = false;
      succeeded++;
    } catch (err) {
      console.error(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.error = true;
      failed++;
      failedEntries.push({ id: entry.id, type: entry.type });
    }
  }

  await fs.promises.writeFile(inputPath, JSON.stringify(entries, null, 2), "utf-8");

  return { outputDir, charactersDir, locationsDir, succeeded, failed, failedEntries };
}

/**
 * Tìm file ảnh ref theo id trong 1 folder — ưu tiên đúng "<id>.png", fallback
 * dò bất kỳ đuôi nào khác nếu không có (generate-reference-images lưu theo
 * đuôi THẬT của ảnh GPT trả về, có thể không phải .png — xem
 * guessImageExtension trong chatgptImage.ts).
 */
async function resolveRefImagePath(dir: string, id: string): Promise<string> {
  const exact = path.join(dir, `${id}.png`);
  if (fs.existsSync(exact)) return exact;

  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(`${id}.`));
  if (match) return path.join(dir, match);

  throw new Error(`Không tìm thấy file ảnh tham chiếu cho id "${id}" trong ${dir}`);
}

export interface GenerateVideosResult {
  videosDir: string;
  succeeded: number;
  failed: number;
  failedEntries: FailedEntry[];
}

/**
 * Đọc 1 file JSON storyboard (CÙNG file input dùng chung với
 * generateReferenceImagesForFile), lọc entry type "VIDEO", rồi lần lượt gọi
 * generateVideo trên hailuoai.video cho từng entry.
 *
 * Chọn mode theo ref:
 * - ref.length > 0: mode "Omni Reference", ảnh/file ref lấy từ
 *   reference-images/<tên file input>/characters|locations/<ref.id>.png
 *   (tuỳ ref.type) — PHẢI đã chạy generateReferenceImagesForFile trước đó.
 * - ref.length === 0 (hoặc không có): mode "Start/End Frame" — KHÔNG upload
 *   ảnh start frame nào (chỉ tạo video thuần từ prompt).
 *
 * Video tạo xong lưu vào reference-images/<tên file input>/videos/<id>.mp4.
 *
 * Chạy TUẦN TỰ, đánh dấu "error" trên từng entry, ghi đè lại file input gốc
 * — cùng quy tắc với generateReferenceImagesForFile.
 */
export async function generateVideosForFile(inputPath: string): Promise<GenerateVideosResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const refImagesDir = referenceImagesDirFor(inputPath);
  const charactersDir = path.join(refImagesDir, "characters");
  const locationsDir = path.join(refImagesDir, "locations");
  const videosDir = path.join(refImagesDir, "videos");
  await fs.promises.mkdir(videosDir, { recursive: true });

  const targets = entries.filter(
    (e): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> & StoryboardEntry => {
      if (e.type !== "VIDEO") return false;
      if (!e.id || !e.prompt) {
        console.warn(`[storyboardPipeline] Bỏ qua entry thiếu "id"/"prompt":`, e);
        return false;
      }
      return true;
    },
  );
  console.log(
    `[storyboardPipeline] Tìm thấy ${targets.length} entry VIDEO trong ${entries.length} entry (${inputPath}).`,
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  for (const entry of targets) {
    const jobId = randomUUID();
    console.log(`[storyboardPipeline] [VIDEO] ${entry.id} — đang tạo video...`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) && (r.type === "CHARACTER" || r.type === "LOCATION"),
      );

      const refPaths: string[] = [];
      for (const ref of refs) {
        const dir = ref.type === "CHARACTER" ? charactersDir : locationsDir;
        refPaths.push(await resolveRefImagePath(dir, sanitizeId(ref.id)));
      }

      if (entry.duration) {
        console.warn(
          `[storyboardPipeline] [VIDEO] ${entry.id} — field "duration" (${entry.duration}s) chưa được hỗ trợ tự động chọn trên hailuoai.video, bỏ qua.`,
        );
      }

      const options: GenerateVideoOptions =
        refPaths.length > 0 ? { omniReferencePaths: refPaths } : {};

      const tempFilePath = await generateVideo(entry.prompt, options, jobId);

      const destPath = path.join(videosDir, `${sanitizeId(entry.id)}.mp4`);
      try {
        await fs.promises.rename(tempFilePath, destPath);
      } catch {
        await fs.promises.copyFile(tempFilePath, destPath);
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }

      console.log(`[storyboardPipeline] [VIDEO] ${entry.id} — đã lưu: ${destPath}`);
      entry.error = false;
      succeeded++;
    } catch (err) {
      console.error(
        `[storyboardPipeline] [VIDEO] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.error = true;
      failed++;
      failedEntries.push({ id: entry.id, type: "VIDEO" });
    }
  }

  await fs.promises.writeFile(inputPath, JSON.stringify(entries, null, 2), "utf-8");

  return { videosDir, succeeded, failed, failedEntries };
}
