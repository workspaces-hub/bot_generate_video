/**
 * Gọi Gemini cho các bước LLM của "Remake phim" (Stage 3, 5, adaptation map).
 * Giống runJsonStage (seriesScript.ts) — mỗi lần thử 1 cuộc chat mới, kết quả
 * lưu outPath, đã có thì dùng lại — nhưng thêm 2 điểm:
 * - đính kèm được clip video (video trước, file .txt ngữ cảnh sau);
 * - lần thử sau nhận DANH SÁCH LỖI của lần trước (do code kiểm tra) để sửa
 *   đúng chỗ, thay vì làm lại mù.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { askGemini } from "../automation/geminiAI";

export function jsonSection(title: string, value: unknown): string {
  return `\n\n## ${title}\n\`\`\`json\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\``;
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // Ghi file tạm rồi rename — bot chết giữa chừng không để lại JSON hỏng.
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fsp.rename(tmp, filePath);
}

export interface FilmStageOptions<T> {
  jobId: string;
  /** Tên ngắn, dùng cho jobId Gemini + tên file tạm. */
  name: string;
  label: string;
  promptPath: string;
  /** Ngữ cảnh (đính kèm dạng .txt). */
  context: string;
  /** Clip video đính kèm (nếu có). */
  videoPath?: string;
  /** Video đính kèm THÊM sau videoPath (vd so sánh video gốc ↔ remake). */
  extraVideoPaths?: string[];
  outPath: string;
  attempts?: number;
  /** JSON thô → giá trị (chuẩn hoá). */
  parse: (raw: unknown) => T;
  /** Danh sách lỗi; rỗng = hợp lệ. */
  validate: (value: T) => string[];
  onStatus?: (text: string) => Promise<void>;
}

export class FilmStageError extends Error {
  constructor(message: string, readonly lastErrors: string[]) {
    super(message);
  }
}

export async function runFilmStage<T>(opts: FilmStageOptions<T>): Promise<T> {
  if (fs.existsSync(opts.outPath)) {
    const cached = await readJson<unknown>(opts.outPath);
    if (cached !== null) {
      const value = opts.parse(cached);
      if (opts.validate(value).length === 0) {
        console.log(`[film] (${opts.jobId}) ${opts.label}: dùng lại ${opts.outPath}`);
        return value;
      }
    }
  }

  const attempts = opts.attempts ?? 3;
  const stagePrompt = await fsp.readFile(opts.promptPath, "utf-8");
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await opts.onStatus?.(`⏳ ${opts.label}${attempt > 1 ? ` — sửa lỗi, lần ${attempt}/${attempts}` : ""}...`);
    const feedback =
      lastErrors.length > 0
        ? `\n\n## LỖI CỦA LẦN TRƯỚC — BẮT BUỘC SỬA (code đã kiểm tra và TỪ CHỐI kết quả vì các lỗi sau; làm lại TOÀN BỘ kết quả, sửa đúng các lỗi này)\n- ${lastErrors.slice(0, 60).join("\n- ")}`
        : "";
    const contextPath = path.join(config.uploadsDir, `${randomUUID()}-film-${opts.name}.txt`);
    await fsp.writeFile(contextPath, `${opts.context}${feedback}`, "utf-8");
    const videoCount = opts.videoPath ? 1 + (opts.extraVideoPaths?.length ?? 0) : 0;
    const attachNote =
      videoCount > 1
        ? `Đính kèm theo thứ tự: ${videoCount} video (thứ tự ý nghĩa ghi trong file .txt), rồi 1 file .txt chứa dữ liệu đầu vào.`
        : videoCount === 1
          ? "Đính kèm: (1) video clip nguồn cần phân tích, (2) file .txt chứa dữ liệu đầu vào."
          : "Dữ liệu đầu vào nằm trong file .txt đính kèm.";
    let downloadedFiles: string[] = [];
    try {
      ({ downloadedFiles } = await askGemini(
        `${stagePrompt}\n\n${attachNote}`,
        `${opts.jobId}-${opts.name}`,
        `${path.basename(opts.outPath, ".json")}__${randomUUID().slice(0, 8)}.json`,
        opts.videoPath ?? contextPath,
        {
          ...(opts.videoPath ? { extraAttachmentPaths: [...(opts.extraVideoPaths ?? []), contextPath] } : {}),
          modelLabel: config.filmGeminiModelLabel || undefined,
        },
      ));
      const produced = downloadedFiles.find((f) => f.toLowerCase().endsWith(".json"));
      if (!produced) throw new Error("Gemini không trả về JSON nào.");
      const value = opts.parse(JSON.parse(await fsp.readFile(produced, "utf-8")));
      lastErrors = opts.validate(value);
      if (lastErrors.length === 0) {
        await writeJson(opts.outPath, value);
        console.log(`[film] (${opts.jobId}) ${opts.label}: xong → ${opts.outPath}`);
        return value;
      }
      console.warn(`[film] (${opts.jobId}) ${opts.label}: ${lastErrors.length} lỗi (lần ${attempt}/${attempts}):\n- ${lastErrors.slice(0, 20).join("\n- ")}`);
    } catch (err) {
      // Lỗi kỹ thuật (Gemini/parse): giữ lastErrors của lần kiểm tra trước để lần sau vẫn được nhắc.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[film] (${opts.jobId}) ${opts.label} lỗi (lần ${attempt}/${attempts}): ${message}`);
      if (attempt === attempts) throw new FilmStageError(`${opts.label} thất bại: ${message}`, lastErrors);
    } finally {
      await fsp.unlink(contextPath).catch(() => {});
      for (const f of downloadedFiles) await fsp.unlink(f).catch(() => {});
    }
  }
  throw new FilmStageError(
    `${opts.label}: kết quả vẫn sai sau ${attempts} lần:\n- ${lastErrors.slice(0, 15).join("\n- ")}`,
    lastErrors,
  );
}
