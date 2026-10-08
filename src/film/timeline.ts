/**
 * Stage 1–2 của "Remake phim": nạp clip nguồn (ffprobe) và dựng GLOBAL
 * TIMELINE — hoàn toàn bằng code, không LLM. Timeline là nguồn chuẩn về
 * thời gian: segId + mốc giây ở đây là bất biến, đợt sau chỉ được NỐI THÊM
 * (appendToTimeline kiểm checksum phần cũ).
 *
 * Phần nặng (scene-detect, so khớp ranh giới, Whisper) chạy trong
 * workers/timeline_worker.py; file này chỉ ghép kết quả + kiểm tra.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { parseClipFileName } from "./naming";
import type {
  ClipPlacement,
  ClipTranscript,
  GlobalTimeline,
  Segment,
  SourceClip,
} from "./types";

const execFileAsync = promisify(execFile);
const WORKER_PATH = path.resolve("./workers/timeline_worker.py");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
/** Dưới mức này coi như 2 clip không liền cảnh (chỉ cảnh báo, không chặn — tập phim khác nhau thường có intro/recap). */
export const LOW_CONTINUITY = 0.5;

export class TimelineError extends Error {}

async function runWorker<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(config.filmPythonBin, [WORKER_PATH, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
  });
  return JSON.parse(stdout) as T;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- Stage 1: ingest ----------

interface FfprobeJson {
  format?: { duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string }[];
}

function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? "").split("/").map(Number);
  const value = den ? num / den : num;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
}

/** Dấu vân tay file video (kích thước + thời điểm sửa) — đổi khi gửi lại video khác cùng tên. */
export async function fileFingerprint(filePath: string): Promise<string | null> {
  const st = await fsp.stat(filePath).catch(() => null);
  return st ? `${st.size}-${Math.round(st.mtimeMs)}` : null;
}

export async function probeClip(filePath: string): Promise<Omit<SourceClip, "clipId" | "batch" | "sourceEpisode">> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate",
    "-of", "json",
    filePath,
  ]);
  const parsed: FfprobeJson = JSON.parse(stdout);
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration < 1) {
    throw new TimelineError(`"${path.basename(filePath)}" không phải video hợp lệ (thiếu video stream hoặc < 1s).`);
  }
  return {
    fileName: path.basename(filePath),
    path: filePath,
    duration: round3(duration),
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 24,
    width: video.width,
    height: video.height,
    hasAudio: Boolean(parsed.streams?.some((s) => s.codec_type === "audio")),
  };
}

/**
 * Video trong thư mục nguồn theo SỐ TẬP (parseClipFileName). Nhiều file cùng
 * 1 tập (gửi lại / chép tay) → lấy file sửa đổi MỚI NHẤT. File không có số
 * tập trả riêng trong unnumbered.
 */
export async function listSourceEpisodes(
  sourceDir: string,
): Promise<{ byEpisode: Map<number, string>; unnumbered: string[] }> {
  const files = (await fsp.readdir(sourceDir).catch(() => [] as string[])).filter((f) =>
    VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );
  const newest = new Map<number, { fileName: string; mtime: number }>();
  const unnumbered: string[] = [];
  for (const fileName of files) {
    const episode = parseClipFileName(fileName).episode;
    if (episode === null) {
      unnumbered.push(fileName);
      continue;
    }
    const { mtimeMs } = await fsp.stat(path.join(sourceDir, fileName));
    const current = newest.get(episode);
    if (!current || mtimeMs > current.mtime) newest.set(episode, { fileName, mtime: mtimeMs });
  }
  return {
    byEpisode: new Map([...newest].sort((a, b) => a[0] - b[0]).map(([ep, v]) => [ep, v.fileName])),
    unnumbered,
  };
}

/**
 * Nạp các tập (đã sắp theo số tập) → SourceClip. clipId theo SỐ TẬP trong tên
 * file: tập 2 → "C02", tập 10 → "C10" (event/fact/thread của tập đó là
 * E02_n, F02_n...). Trùng id với clip đang giữ (dữ liệu cũ đánh số kiểu khác)
 * → thêm hậu tố "C02b". Cache phân tích cũ của id này do nơi gọi dọn
 * (clearClipCache trong pipeline.ts).
 */
export async function ingestClips(
  sourceDir: string,
  files: { episode: number; fileName: string }[],
  batch: number,
  /** clipId các clip đang giữ trong manifest. */
  usedIds: Set<string>,
): Promise<SourceClip[]> {
  const clips: SourceClip[] = [];
  const errors: string[] = [];
  const taken = new Set(usedIds);
  for (const { fileName, episode } of files) {
    try {
      const info = await probeClip(path.join(sourceDir, fileName));
      const base = `C${String(episode).padStart(2, "0")}`;
      let clipId = base;
      for (let i = 0; taken.has(clipId); i++) clipId = `${base}${String.fromCharCode(98 + i)}`;
      taken.add(clipId);
      clips.push({
        ...info,
        fingerprint: (await fileFingerprint(path.join(sourceDir, fileName))) ?? undefined,
        clipId,
        batch,
        sourceEpisode: episode,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) throw new TimelineError(`Clip lỗi:\n- ${errors.join("\n- ")}`);
  return clips;
}

/** Ranh giới shot trong [start, end]: cắt cảnh → gộp shot quá ngắn → chia shot quá dài. */
export function buildClipBoundaries(
  start: number,
  end: number,
  cuts: number[],
  minSeconds = config.filmMinSegmentSeconds,
  maxSeconds = config.filmMaxSegmentSeconds,
): number[] {
  const points = [start, ...cuts.filter((c) => c > start + 0.05 && c < end - 0.05), end];
  // Gộp shot ngắn hơn minSeconds vào shot trước (shot đầu thì vào shot sau).
  const merged: number[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const isLast = i === points.length - 1;
    if (!isLast && points[i] - merged[merged.length - 1] < minSeconds) continue;
    if (isLast && merged.length > 1 && points[i] - merged[merged.length - 1] < minSeconds) merged.pop();
    merged.push(points[i]);
  }
  // Chia đều shot dài hơn maxSeconds.
  const out: number[] = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1];
    const b = merged[i];
    const parts = Math.max(1, Math.ceil((b - a) / maxSeconds));
    for (let k = 1; k <= parts; k++) out.push(round3(a + ((b - a) * k) / parts));
  }
  out[0] = round3(out[0]);
  return out;
}

function segmentsChecksum(segments: Segment[]): string {
  const canonical = segments.map((s) => [s.segId, s.clipId, s.localStart, s.localEnd, s.globalStart, s.globalEnd]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Bất biến của timeline — vi phạm là lỗi code/dữ liệu, không bao giờ "đoán sửa". */
export function validateTimeline(tl: GlobalTimeline): void {
  const errors: string[] = [];
  let cursor = 0;
  tl.segments.forEach((s, i) => {
    if (s.segId !== segIdAt(i)) errors.push(`segId thứ ${i + 1} là ${s.segId}, cần ${segIdAt(i)}`);
    if (Math.abs(s.globalStart - cursor) > 0.01) errors.push(`${s.segId}: hở/chồng tại ${cursor}s → ${s.globalStart}s`);
    if (s.globalEnd - s.globalStart <= 0) errors.push(`${s.segId}: độ dài <= 0`);
    if (Math.abs(s.globalEnd - s.globalStart - (s.localEnd - s.localStart)) > 0.01) errors.push(`${s.segId}: lệch local/global`);
    cursor = s.globalEnd;
  });
  if (Math.abs(cursor - tl.totalDuration) > 0.01) errors.push(`Tổng ${cursor}s ≠ totalDuration ${tl.totalDuration}s`);
  for (const c of tl.clips) {
    const own = tl.segments.filter((s) => s.clipId === c.clipId);
    if (own.length === 0) errors.push(`${c.clipId}: không có segment`);
    else if (Math.abs(own[0].globalStart - c.globalOffset) > 0.01) errors.push(`${c.clipId}: offset lệch segment đầu`);
  }
  if (segmentsChecksum(tl.segments) !== tl.checksum) errors.push("checksum không khớp segments");
  if (errors.length > 0) throw new TimelineError(`Timeline không hợp lệ:\n- ${errors.join("\n- ")}`);
}

function segIdAt(index: number): string {
  return `S${String(index + 1).padStart(4, "0")}`;
}

export function emptyTimeline(): GlobalTimeline {
  return { version: 1, clips: [], segments: [], batches: [], totalDuration: 0, checksum: segmentsChecksum([]) };
}

/**
 * Quay lui timeline: chỉ giữ các clip trong keepClipIds (phải là PHẦN ĐẦU
 * của timeline) — dùng khi phân tích lại từ 1 tập ở giữa phim. segId/mốc
 * giây phần giữ lại không đổi.
 */
export function truncateTimeline(tl: GlobalTimeline, keepClipIds: string[]): GlobalTimeline {
  const keep = new Set(keepClipIds);
  const cut = tl.clips.findIndex((c) => !keep.has(c.clipId));
  if (cut === -1) return tl;
  if (tl.clips.slice(cut).some((c) => keep.has(c.clipId))) {
    throw new TimelineError("Chỉ quay lui được phần cuối timeline (clip giữ lại phải liền từ đầu).");
  }
  const clips = tl.clips.slice(0, cut);
  const segments = tl.segments.filter((s) => keep.has(s.clipId));
  const batches = tl.batches
    .map((b) => {
      const clipIds = b.clipIds.filter((id) => keep.has(id));
      const own = segments.filter((s) => clipIds.includes(s.clipId));
      return { ...b, clipIds, firstSegId: own[0]?.segId ?? "", lastSegId: own[own.length - 1]?.segId ?? "" };
    })
    .filter((b) => b.clipIds.length > 0);
  const next: GlobalTimeline = {
    version: 1,
    clips,
    segments,
    batches,
    totalDuration: segments.length > 0 ? segments[segments.length - 1].globalEnd : 0,
    checksum: segmentsChecksum(segments),
  };
  validateTimeline(next);
  return next;
}

export interface TimelineWarning {
  clipId: string;
  message: string;
}

/**
 * Nối clip mới vào cuối timeline (phim mới = nối vào timeline rỗng). Chỉ so
 * ranh giới clip cuối cũ ↔ clip mới đầu và giữa các clip mới; segment cũ
 * giữ nguyên tuyệt đối (kiểm checksum).
 */
export async function appendToTimeline(
  tl: GlobalTimeline,
  previousClips: SourceClip[],
  newClips: SourceClip[],
  batch: number,
  onStatus?: (text: string) => Promise<void>,
): Promise<{ timeline: GlobalTimeline; warnings: TimelineWarning[] }> {
  if (newClips.length === 0) throw new TimelineError("Không có clip mới để nối vào timeline.");
  const oldChecksum = tl.checksum;
  const segments = [...tl.segments];
  const clips: ClipPlacement[] = [...tl.clips];
  const warnings: TimelineWarning[] = [];
  let offset = tl.totalDuration;
  let prev = previousClips.at(-1);

  for (const [i, clip] of newClips.entries()) {
    await onStatus?.(`⏳ [2/7] Timeline: clip ${clip.clipId} (${i + 1}/${newClips.length}) — dò cảnh + ranh giới...`);
    let trimHead = 0;
    let continuity = 1;
    let overlapScore = 0;
    // Video clip trước có thể đã bị xoá sau khi phân tích (xem
    // deleteAnalyzedSourceVideos) — khi đó bỏ dò ranh giới, coi như không lặp.
    if (prev && !fs.existsSync(prev.path)) {
      warnings.push({ clipId: clip.clipId, message: `không dò được ranh giới với ${prev.clipId} (video gốc đã xoá) — không cắt đoạn lặp đầu clip` });
    } else if (prev) {
      const b = await runWorker<{ overlap: number; overlapScore: number; continuity: number }>([
        "boundary", "--a", prev.path, "--b", clip.path,
      ]);
      trimHead = Math.min(b.overlap, Math.max(0, clip.duration - 1));
      continuity = b.continuity;
      overlapScore = b.overlapScore;
      if (trimHead > 0) {
        warnings.push({ clipId: clip.clipId, message: `bỏ ${trimHead}s đầu (lặp lại đuôi ${prev.clipId})` });
      } else if (continuity < LOW_CONTINUITY) {
        warnings.push({
          clipId: clip.clipId,
          message: `không liền cảnh với ${prev.clipId} (continuity ${continuity}) — bình thường nếu là tập mới có intro/recap; kiểm tra lại thứ tự nếu không phải`,
        });
      }
    }
    const scenes = await runWorker<{ duration: number; cuts: number[] }>([
      "scenes", "--video", clip.path, "--threshold", String(config.filmSceneThreshold),
    ]);
    const end = round3(Math.min(clip.duration, scenes.duration || clip.duration));
    const bounds = buildClipBoundaries(trimHead, end, scenes.cuts);
    for (let k = 1; k < bounds.length; k++) {
      const localStart = bounds[k - 1];
      const localEnd = bounds[k];
      segments.push({
        segId: segIdAt(segments.length),
        clipId: clip.clipId,
        batch,
        localStart,
        localEnd,
        globalStart: round3(offset + localStart - trimHead),
        globalEnd: round3(offset + localEnd - trimHead),
      });
    }
    const effectiveDuration = round3(end - trimHead);
    clips.push({ clipId: clip.clipId, batch, globalOffset: round3(offset), trimHead, effectiveDuration, continuity, overlapScore });
    offset = segments[segments.length - 1].globalEnd;
    prev = clip;
  }

  const firstNew = segments[tl.segments.length];
  const timeline: GlobalTimeline = {
    version: 1,
    clips,
    segments,
    batches: [
      ...tl.batches,
      {
        batch,
        clipIds: newClips.map((c) => c.clipId),
        firstSegId: firstNew.segId,
        lastSegId: segments[segments.length - 1].segId,
      },
    ],
    totalDuration: round3(offset),
    checksum: segmentsChecksum(segments),
  };
  if (segmentsChecksum(timeline.segments.slice(0, tl.segments.length)) !== oldChecksum) {
    throw new TimelineError("Timeline cũ bị thay đổi khi nối đợt mới — từ chối.");
  }
  validateTimeline(timeline);
  return { timeline, warnings };
}

/**
 * Thoại kèm thời gian (faster-whisper, tuỳ chọn) gán vào segment chứa điểm
 * giữa câu. Không có Whisper → available=false, Gemini tự nghe thoại.
 */
export async function transcribeClip(clip: SourceClip, tl: GlobalTimeline): Promise<ClipTranscript> {
  const own = tl.segments.filter((s) => s.clipId === clip.clipId);
  let result: { available: boolean; language: string | null; segments: { start: number; end: number; text: string }[] };
  try {
    result = await runWorker(["transcribe", "--video", clip.path, "--model", config.filmWhisperModel]);
  } catch (err) {
    console.warn(`[film] Whisper lỗi với ${clip.clipId} — bỏ qua thoại tự động:`, err instanceof Error ? err.message : err);
    return { clipId: clip.clipId, available: false, language: null, lines: [] };
  }
  const lines = result.segments.flatMap((line) => {
    const mid = (line.start + line.end) / 2;
    const seg = own.find((s) => mid >= s.localStart && mid < s.localEnd);
    return seg ? [{ segId: seg.segId, text: line.text }] : []; // ngoài segment = nằm trong phần trim đầu
  });
  return { clipId: clip.clipId, available: result.available, language: result.language, lines };
}

export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
