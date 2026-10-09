/**
 * "Remake phim" — 2 tầng:
 *
 * PHIM GỐC (phân tích 1 lần, mọi bản remake dùng chung), theo đợt nạp clip:
 *   [1] nạp clip mới (ffprobe, sắp theo số tập) → manifest.json
 *   [2] nối Global Timeline                      → timeline.json (+ transcripts/)
 *   [3] phân tích từng clip TUẦN TỰ             → analysis/<clip>.json
 *   [4] merge Story Memory                       → story_memory.json (+ memory/)
 *   [5] dựng cấu trúc truyện của đợt            → structure_tap<đầu>-<cuối>.json
 *
 * BẢN REMAKE (nhiều bản / 1 phim gốc: sinhton_remake_1, _2...), theo đợt tập:
 *   [6] Bible/Arc/từng tập/Ledger/QA  → storage/series/<bản>/ (seriesScript.ts)
 *   [7] ánh xạ gốc → bản này          → remakes/<bản>/adaptation_map.json
 *   [8] ảnh/video: luồng storyboard có sẵn
 *
 * Bot tách 3 nút:
 * - "Phân tích phim gốc" → analyzeFilm: làm xong đợt phim gốc còn dở + nạp,
 *   phân tích clip mới. Xuất <phim>_tham_chieu.json (tóm tắt) cho user.
 * - "Remake phim" (tên phim) → runFilmRemake mode "new": bản remake MỚI cho
 *   toàn bộ tập gốc đã phân tích (kèm yêu cầu riêng tuỳ chọn).
 * - "Tạo phim tiếp" (tên bản remake) → runFilmRemake mode "continue": viết
 *   tiếp các tập gốc đã phân tích mà bản đó chưa remake.
 * Bản remake chia đợt config.filmRemakeChunkEpisodes tập. Mọi bước đã có
 * file kết quả thì bỏ qua (chạy lại = làm tiếp từ bước dở).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { generateSeriesWithGemini, readSeriesMeta, seriesDirFor } from "../automation/seriesScript";
import { analyzeClip } from "./analyzer";
import { adaptationMapPath, loadAdaptationMap, updateAdaptationMap } from "./adaptation";
import {
  buildEpisodeContext,
  buildGlobalOverview,
  buildSourceEpisode,
  checkEpisodeDuration,
  episodeMapper,
  storyDurationOf,
  FILM_EPISODE_RULES,
} from "./context";
import { readJson, writeJson } from "./llm";
import { normalizeFilmId } from "./naming";
import { emptyMemory } from "./memory";
import { loadStructures, reconstructBatch, structurePath } from "./structure";
import {
  appendToTimeline,
  emptyTimeline,
  formatSeconds,
  fileFingerprint,
  ingestClips,
  listSourceEpisodes,
  truncateTimeline,
  transcribeClip,
} from "./timeline";
import type {
  ClipTranscript,
  FilmRecord,
  GlobalTimeline,
  RemakeRecord,
  SourceBatch,
  SourceClip,
  StoryMemory,
  StoryStructure,
} from "./types";

export function filmDirFor(filmId: string): string {
  return path.join(config.filmsDir, filmId);
}

export function filmSourceDir(filmId: string): string {
  return path.join(filmDirFor(filmId), "source");
}

function remakeDirFor(filmId: string, remakeName: string): string {
  return path.join(filmDirFor(filmId), "remakes", remakeName);
}

/** film.json bản 1 (1 phim = 1 remake) — chuyển sang 2 tầng khi đọc. */
interface FilmRecordV1 {
  filmId: string;
  remakeBaseName: string;
  createdAt: string;
  batches: { batch: number; clipIds: string[]; firstEpisode: number; lastEpisode: number; done: boolean }[];
}

/** film.json bản 2: sourceBatches theo VỊ TRÍ trong manifest, structure_batch<N>.json. */
type FilmRecordV2 = Omit<FilmRecord, "version"> & { version: 2 };

async function migrateV1(filmId: string, old: FilmRecordV1): Promise<FilmRecordV2> {
  const dir = filmDirFor(filmId);
  const memory = await readJson<StoryMemory>(path.join(dir, "story_memory.json"));
  const analyzed = new Set(memory?.analyzed_clips ?? []);
  const record: FilmRecordV2 = {
    version: 2,
    filmId,
    createdAt: old.createdAt,
    sourceBatches: old.batches.map((b) => ({
      batch: b.batch,
      clipIds: b.clipIds,
      firstEpisode: b.firstEpisode,
      lastEpisode: b.lastEpisode,
      analyzed: b.clipIds.every((c) => analyzed.has(c)) && fs.existsSync(path.join(dir, `structure_batch${b.batch}.json`)),
    })),
    remakes: [
      {
        name: old.remakeBaseName,
        createdAt: old.createdAt,
        batches: old.batches.map((b) => ({ firstEpisode: b.firstEpisode, lastEpisode: b.lastEpisode, done: b.done })),
      },
    ],
  };
  // Adaptation map bản 1 nằm thẳng trong thư mục phim → chuyển vào thư mục bản remake.
  const remakeDir = remakeDirFor(filmId, old.remakeBaseName);
  await fsp.mkdir(remakeDir, { recursive: true });
  for (const f of await fsp.readdir(dir)) {
    if (/^adaptation_map(_tap\d+)?\.json$/.test(f)) await fsp.rename(path.join(dir, f), path.join(remakeDir, f));
  }
  await writeJson(path.join(dir, "film.json"), record);
  console.log(`[film] Đã chuyển film.json của "${filmId}" sang dạng nhiều bản remake.`);
  return record;
}

/**
 * Bản 2 → 3: đổi firstEpisode/lastEpisode của sourceBatches từ vị trí trong
 * manifest sang SỐ TẬP GỐC, đổi tên structure_batch<N>.json → structure_tap2-5.json,
 * dọn cache của clip không còn trong manifest.
 */
async function migrateV2(filmId: string, old: FilmRecordV2): Promise<FilmRecord> {
  const dir = filmDirFor(filmId);
  const manifest = (await readJson<SourceClip[]>(path.join(dir, "manifest.json"))) ?? [];
  const episodeOf = new Map(manifest.map((c, i) => [c.clipId, c.sourceEpisode ?? i + 1]));
  const sourceBatches: SourceBatch[] = [];
  for (const b of old.sourceBatches) {
    const eps = b.clipIds.map((id) => episodeOf.get(id)).filter((n): n is number => n !== undefined);
    const next: SourceBatch = { ...b, firstEpisode: Math.min(...eps), lastEpisode: Math.max(...eps) };
    const oldPath = path.join(dir, `structure_batch${b.batch}.json`);
    if (eps.length > 0 && fs.existsSync(oldPath)) await fsp.rename(oldPath, structurePath(dir, next));
    if (eps.length > 0) sourceBatches.push(next);
  }
  const record: FilmRecord = { ...old, version: 3, sourceBatches };
  const pruned = await pruneOrphanCache(dir, manifest);
  await writeJson(path.join(dir, "film.json"), record);
  console.log(
    `[film] "${filmId}": film.json → bản 3 (đợt + structure theo số tập gốc)${pruned.length ? `, dọn cache mồ côi ${pruned.join(", ")}` : ""}.`,
  );
  return record;
}

export async function readFilmRecord(filmId: string): Promise<FilmRecord | null> {
  const raw = await readJson<FilmRecord | FilmRecordV2 | FilmRecordV1>(path.join(filmDirFor(filmId), "film.json"));
  if (!raw) return null;
  if ("version" in raw && raw.version === 3) return raw;
  const v2 = "version" in raw && raw.version === 2 ? raw : await migrateV1(filmId, raw as FilmRecordV1);
  return migrateV2(filmId, v2);
}

/**
 * Xoá cache (analysis/, transcripts/, memory/after_*) của clip KHÔNG còn trong
 * manifest — vd bản phân tích cũ trước khi đổi cách đặt clipId, hoặc clip đã
 * bị bỏ. Trả về clipId đã dọn.
 */
async function pruneOrphanCache(dir: string, manifest: SourceClip[]): Promise<string[]> {
  const keep = new Set(manifest.map((c) => c.clipId));
  const pruned = new Set<string>();
  for (const [sub, re] of [
    ["analysis", /^(C\w+)\.json$/],
    ["transcripts", /^(C\w+)\.json$/],
    ["memory", /^after_(C\w+)\.json$/],
  ] as const) {
    for (const f of await fsp.readdir(path.join(dir, sub)).catch(() => [] as string[])) {
      const id = f.match(re)?.[1];
      if (!id || keep.has(id)) continue;
      await fsp.unlink(path.join(dir, sub, f)).catch(() => {});
      pruned.add(id);
    }
  }
  return [...pruned];
}

/** Tập cuối đã viết xong của 1 bản remake (0 nếu chưa có). */
function remakeDoneUntil(remake: RemakeRecord): number {
  return Math.max(0, ...remake.batches.filter((b) => b.done).map((b) => b.lastEpisode));
}

// ---------- Tra cứu ----------

export class FilmPlanError extends Error {}

/** Bản remake: tạo MỚI (kèm yêu cầu riêng) hay TIẾP bản đã có. */
export type RemakeChoice = { mode: "new"; note?: string } | { mode: "continue"; name: string };

/** Số clip ĐẦU manifest đã phân tích xong (các đợt đã xong đứng liền từ đầu phim). */
function analyzedClipCount(record: FilmRecord | null): number {
  let count = 0;
  for (const b of record?.sourceBatches ?? []) {
    if (!b.analyzed) break;
    count += b.clipIds.length;
  }
  return count;
}

/** "sinhton", "sinhton_tham_chieu.json", "Sinh Tồn" → "sinhton"/"Sinh_Ton". */
function filmKey(text: string): string {
  return normalizeFilmId(text.trim().replace(/\.json$/i, "").replace(/_tham_chieu$/i, ""));
}

/**
 * Tên phim user gõ (hoặc tên file tham chiếu) → filmId đã phân tích. Khớp
 * đúng tên trước; không thì tìm phim có tên CHỨA chuỗi đó (không phân biệt
 * hoa/thường) — đúng 1 phim mới nhận, nhiều phim thì liệt kê để gõ rõ hơn.
 */
export async function resolveFilmId(typed: string): Promise<string> {
  const key = filmKey(typed);
  if (!key) throw new FilmPlanError("Tên phim trống.");
  const films = (await fsp.readdir(config.filmsDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.filmsDir, d.name, "film.json")))
    .map((d) => d.name);
  const exact = films.find((f) => f.toLowerCase() === key.toLowerCase());
  if (exact) return exact;
  const partial = films.filter((f) => f.toLowerCase().includes(key.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new FilmPlanError(`"${typed}" khớp nhiều phim: ${partial.join(", ")} — gõ rõ hơn.`);
  throw new FilmPlanError(
    `Không thấy phim "${typed}" đã phân tích${films.length ? ` (có: ${films.join(", ")})` : ""}. Dùng nút "Phân tích phim gốc" trước.`,
  );
}

/** Bản remake → phim gốc của nó (series_meta.json, không có thì quét film.json). */
export async function findFilmByRemake(remakeName: string): Promise<{ filmId: string; remake: string }> {
  const name = remakeName.trim().replace(/\.json$/i, "").replace(/_tap\d+(_full)?$/i, "");
  const meta = await readSeriesMeta(name);
  const candidates = meta?.filmId
    ? [meta.filmId]
    : (await fsp.readdir(config.filmsDir).catch(() => [] as string[]));
  for (const filmId of candidates) {
    const record = await readFilmRecord(filmId).catch(() => null);
    const remake = record?.remakes.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (remake) return { filmId, remake: remake.name };
  }
  throw new FilmPlanError(`Không thấy bản remake "${remakeName}" (tạo bằng nút "Remake phim").`);
}

// ---------- Phân tích phim gốc ----------
//
// Gửi tập nào phân tích tập đó — chỉ cần các tập gửi trong 1 lượt LIỀN NHAU.
// Không bắt nối tiếp tập cuối đã có (phim mới gửi riêng tập 2 vẫn được; thiếu
// tập giữa chừng thì memory nối thẳng từ tập trước đó). Gửi lại tập ĐÃ phân
// tích = phân tích lại: quay lui memory/timeline/structure về ngay trước tập
// nhỏ nhất được gửi, các tập sau đó không có trong lượt gửi bị bỏ khỏi phân
// tích (memory của chúng dựa trên bản phân tích cũ).

export interface AnalyzePlan {
  /** Số tập gốc sẽ phân tích, tăng dần + liền nhau. */
  episodes: number[];
  /** Tập → file trong thư mục nguồn. */
  files: { episode: number; fileName: string }[];
  /** Tập đã phân tích trước đó sẽ được phân tích LẠI. */
  reanalyze: number[];
  /** Tập đã phân tích trước đó bị BỎ (sau tập phân tích lại, không có trong lượt gửi). */
  dropped: number[];
}

/** Liệt kê số tập dạng khoảng: [1,2,3,5] → "1–3, 5". */
export function formatEpisodes(episodes: number[]): string {
  const sorted = [...episodes].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** Tập gốc (số tập trong tên file) đã phân tích xong, theo thứ tự phim. */
async function analyzedSourceEpisodes(filmId: string, record: FilmRecord | null): Promise<number[]> {
  const manifest = (await readJson<SourceClip[]>(path.join(filmDirFor(filmId), "manifest.json"))) ?? [];
  return manifest.slice(0, analyzedClipCount(record)).map((c, i) => c.sourceEpisode ?? i + 1);
}

/**
 * episodes = các tập user vừa gửi; không truyền (gõ "xong" không gửi gì /
 * chép tay vào thư mục) → các tập trong thư mục nguồn lớn hơn tập cuối đã
 * phân tích.
 */
export async function planFilmAnalyze(filmId: string, episodes?: number[]): Promise<AnalyzePlan> {
  const record = await readFilmRecord(filmId);
  const manifest = (await readJson<SourceClip[]>(path.join(filmDirFor(filmId), "manifest.json"))) ?? [];
  const { byEpisode, unnumbered } = await listSourceEpisodes(filmSourceDir(filmId));
  const known = manifest.map((c, i) => c.sourceEpisode ?? i + 1);
  const lastKnown = Math.max(0, ...known);

  let target: number[];
  if (episodes && episodes.length > 0) {
    target = [...new Set(episodes)].sort((a, b) => a - b);
    const missingFiles = target.filter((ep) => !byEpisode.has(ep));
    if (missingFiles.length > 0) throw new FilmPlanError(`Không thấy file tập ${formatEpisodes(missingFiles)} trong thư mục nguồn.`);
  } else {
    target = [...byEpisode.keys()].filter((ep) => ep > lastKnown);
    if (target.length === 0) {
      throw new FilmPlanError(
        `Không có tập mới để phân tích${unnumbered.length ? ` (file không có số tập: ${unnumbered.join(", ")})` : ""}. Gửi tập muốn phân tích — gửi lại tập đã có = phân tích lại.`,
      );
    }
  }
  const gaps = target.slice(1).flatMap((ep, i) =>
    Array.from({ length: ep - target[i] - 1 }, (_, k) => target[i] + k + 1),
  );
  if (gaps.length > 0) {
    throw new FilmPlanError(`Các tập trong 1 lượt phải liền nhau — đang có ${formatEpisodes(target)}, thiếu tập ${formatEpisodes(gaps)}.`);
  }
  const from = target[0];
  const previouslyKnown = known.filter((ep) => ep >= from);
  return {
    episodes: target,
    files: target.map((episode) => ({ episode, fileName: byEpisode.get(episode)! })),
    reanalyze: previouslyKnown.filter((ep) => target.includes(ep)),
    dropped: previouslyKnown.filter((ep) => !target.includes(ep)),
  };
}

export interface FilmAnalyzeResult {
  filmId: string;
  analyzedEpisodes: number[];
  reanalyzed: number[];
  dropped: number[];
  /** Bản remake viết từ phân tích cũ của các tập vừa phân tích lại/bỏ. */
  staleRemakes: string[];
  /** File tóm tắt phân tích (<phim>_tham_chieu.json) gửi cho user. */
  referencePath: string;
  notes: string[];
  stats: { episodes: number; duration: string; segments: number; characters: number; threads: number; openThreads: number };
}

/** Tóm tắt phân tích phim gốc — để user xem AI hiểu phim thế nào. */
function buildReferenceSummary(filmId: string, manifest: SourceClip[], memory: StoryMemory, structures: StoryStructure[]): unknown {
  const sourceEp = new Map(manifest.map((c, i) => [c.clipId, c.sourceEpisode ?? i + 1]));
  return {
    film: filmId,
    episodes: memory.clips.map((c) => ({
      episode: sourceEp.get(c.clip_id),
      file: manifest.find((m) => m.clipId === c.clip_id)?.fileName,
      summary: c.summary,
    })),
    characters: memory.characters.map((c) => ({ id: c.id, name: c.name, role: c.role, description: c.description, relations: c.relations })),
    threads: memory.threads.map((t) => ({ id: t.id, question: t.question, status: t.status })),
    twists: memory.reinterpretations,
    emotion_curve: structures.flatMap((s) =>
      s.emotion_curve.map((e) => ({ episode: sourceEp.get(e.clip_id), intensity: e.intensity, emotion: e.dominant_emotion })),
    ),
  };
}

/**
 * Xoá cache phân tích của 1 clipId — clipId theo số tập (C02 = tập 2) nên
 * phân tích lại cùng tập dùng lại đúng id; cache cũ phải xoá để runFilmStage
 * không dùng lại kết quả của bản phân tích trước.
 */
async function clearClipCache(dir: string, clipId: string): Promise<void> {
  for (const f of [
    path.join(dir, "analysis", `${clipId}.json`),
    path.join(dir, "transcripts", `${clipId}.json`),
    path.join(dir, "memory", `after_${clipId}.json`),
  ]) {
    await fsp.unlink(f).catch(() => {});
  }
}

/**
 * Gửi lại video của 1 tập (cùng tên hoặc khác tên, video có thể khác) → xoá
 * ngay cache analysis/ + transcripts/ của tập đó, để lần phân tích sau chắc
 * chắn làm lại. GIỮ memory/after_<clip>.json: đó là snapshot dùng để quay lui
 * khi phân tích lại các tập SAU (user gửi lại rồi "huỷ" vẫn không hỏng gì).
 * Trả về clipId đã xoá cache.
 */
export async function invalidateEpisodeCache(filmId: string, episode: number): Promise<string[]> {
  const dir = filmDirFor(filmId);
  const manifest = (await readJson<SourceClip[]>(path.join(dir, "manifest.json"))) ?? [];
  const base = `C${String(episode).padStart(2, "0")}`;
  const ids = new Set([base, ...manifest.filter((c) => c.sourceEpisode === episode).map((c) => c.clipId)]);
  // Thêm biến thể hậu tố (C02b...) còn sót cache.
  for (const f of await fsp.readdir(path.join(dir, "analysis")).catch(() => [] as string[])) {
    const id = path.basename(f, ".json");
    if (new RegExp(`^${base}[b-z]?$`).test(id)) ids.add(id);
  }
  const cleared: string[] = [];
  for (const id of ids) {
    let removed = false;
    for (const f of [path.join(dir, "analysis", `${id}.json`), path.join(dir, "transcripts", `${id}.json`)]) {
      removed = (await fsp.unlink(f).then(() => true).catch(() => false)) || removed;
    }
    if (removed) cleared.push(id);
  }
  if (cleared.length > 0) console.log(`[film] ${filmId}: gửi lại tập ${episode} → xoá cache phân tích ${cleared.join(", ")}`);
  return cleared;
}

/**
 * Quay lui phân tích về ngay trước tập gốc `fromEpisode`: giữ các clip có số
 * tập nhỏ hơn, memory = snapshot sau clip cuối được giữ, timeline cắt đuôi,
 * đợt bị cắt dở → structure dựng lại (analyzed=false), đợt bị bỏ hẳn → xoá.
 */
async function rollbackAnalysis(dir: string, record: FilmRecord, manifest: SourceClip[], fromEpisode: number): Promise<SourceClip[]> {
  const kept = manifest.filter((c, i) => (c.sourceEpisode ?? i + 1) < fromEpisode);
  const keptIds = new Set(kept.map((c) => c.clipId));
  for (const c of manifest) if (!keptIds.has(c.clipId)) await clearClipCache(dir, c.clipId);
  const last = kept[kept.length - 1];
  const memory = last ? await readJson<StoryMemory>(path.join(dir, "memory", `after_${last.clipId}.json`)) : null;
  if (last && !memory) throw new Error(`Thiếu snapshot memory sau ${last.clipId} — không quay lui được.`);
  await writeJson(path.join(dir, "story_memory.json"), memory ?? emptyMemory());
  const timeline = await readJson<GlobalTimeline>(path.join(dir, "timeline.json"));
  if (timeline) await writeJson(path.join(dir, "timeline.json"), truncateTimeline(timeline, [...keptIds]));

  const batches: SourceBatch[] = [];
  for (const b of record.sourceBatches) {
    const clipIds = b.clipIds.filter((id) => keptIds.has(id));
    if (clipIds.length === 0 || clipIds.length < b.clipIds.length) {
      await fsp.unlink(structurePath(dir, b)).catch(() => {});
    }
    if (clipIds.length === 0) continue;
    const eps = clipIds.map((id) => {
      const i = kept.findIndex((c) => c.clipId === id);
      return kept[i].sourceEpisode ?? i + 1;
    });
    batches.push({
      ...b,
      clipIds,
      firstEpisode: Math.min(...eps),
      lastEpisode: Math.max(...eps),
      analyzed: b.analyzed && clipIds.length === b.clipIds.length,
    });
  }
  record.sourceBatches = batches;
  await writeJson(path.join(dir, "manifest.json"), kept);
  await writeJson(path.join(dir, "film.json"), record);
  return kept;
}

export async function analyzeFilm(opts: {
  jobId: string;
  filmId: string;
  /** Tập user vừa gửi (xem planFilmAnalyze). */
  episodes?: number[];
  onStatus?: (text: string) => Promise<void>;
}): Promise<FilmAnalyzeResult> {
  const { filmId } = opts;
  const plan = await planFilmAnalyze(filmId, opts.episodes);
  const dir = filmDirFor(filmId);
  const notes: string[] = [];
  const recordPath = path.join(dir, "film.json");
  const record: FilmRecord = (await readFilmRecord(filmId)) ?? {
    version: 3,
    filmId,
    createdAt: new Date().toISOString(),
    sourceBatches: [],
    remakes: [],
  };
  const manifestPath = path.join(dir, "manifest.json");
  let manifest = (await readJson<SourceClip[]>(manifestPath)) ?? [];

  // Chạy lại job bị ngắt giữa chừng (restart): đợt dở ở cuối phim đúng là các
  // tập này → làm tiếp, KHÔNG quay lui (không phân tích lại phần đã xong).
  const unfinished = record.sourceBatches.find((b) => !b.analyzed);
  const unfinishedEpisodes = unfinished?.clipIds.map((id) => manifest.find((c) => c.clipId === id)?.sourceEpisode);
  // Chỉ làm tiếp khi file vẫn là đúng video đã nạp — gửi lại video KHÁC cùng tên
  // (dấu vân tay đổi) thì phân tích lại từ đầu, không dùng timeline/cache cũ.
  const sameFiles =
    unfinished !== undefined &&
    (
      await Promise.all(
        unfinished.clipIds.map(async (id) => {
          const clip = manifest.find((c) => c.clipId === id);
          const file = plan.files.find((f) => f.episode === clip?.sourceEpisode);
          return Boolean(
            clip?.fingerprint && file && clip.fingerprint === (await fileFingerprint(path.join(filmSourceDir(filmId), file.fileName))),
          );
        }),
      )
    ).every(Boolean);
  const resuming =
    unfinished !== undefined &&
    sameFiles &&
    unfinished.clipIds.includes(manifest[manifest.length - 1]?.clipId ?? "") &&
    JSON.stringify(unfinishedEpisodes) === JSON.stringify(plan.episodes);

  // Phân tích lại / bỏ tập → quay lui về trước tập nhỏ nhất được gửi.
  const staleRemakes: string[] = [];
  if (!resuming && plan.reanalyze.length + plan.dropped.length > 0) {
    const firstPosition = manifest.findIndex((c, i) => (c.sourceEpisode ?? i + 1) >= plan.episodes[0]) + 1;
    for (const r of record.remakes) {
      // Bản mới: batches ghi số tập gốc; bản cũ: vị trí trong manifest.
      if (remakeDoneUntil(r) >= (r.numbering === "source" ? plan.episodes[0] : firstPosition)) staleRemakes.push(r.name);
    }
    await opts.onStatus?.(`⏳ Quay lui phân tích về trước tập ${plan.episodes[0]}...`);
    manifest = await rollbackAnalysis(dir, record, manifest, plan.episodes[0]);
  }

  // Làm xong đợt bị cắt dở (dựng lại structure), rồi nạp + phân tích các tập được gửi.
  let ingested = resuming;
  for (;;) {
    let sb = record.sourceBatches.find((b) => !b.analyzed);
    if (!sb) {
      if (ingested) break;
      ingested = true;
      const batch = Math.max(0, ...record.sourceBatches.map((b) => b.batch)) + 1;
      const newClips = await ingestClips(filmSourceDir(filmId), plan.files, batch, new Set(manifest.map((c) => c.clipId)));
      for (const c of newClips) await clearClipCache(dir, c.clipId);
      await opts.onStatus?.(`⏳ [1/5] Nạp tập gốc ${formatEpisodes(plan.episodes)}...`);
      manifest = [...manifest, ...newClips];
      await writeJson(manifestPath, manifest);
      sb = {
        batch,
        clipIds: newClips.map((c) => c.clipId),
        firstEpisode: newClips[0].sourceEpisode ?? manifest.length - newClips.length + 1,
        lastEpisode: newClips[newClips.length - 1].sourceEpisode ?? manifest.length,
        analyzed: false,
      };
      record.sourceBatches.push(sb);
      await writeJson(recordPath, record);
    }
    await analyzeSourceBatch(opts, sb, record.sourceBatches.slice(0, record.sourceBatches.indexOf(sb)), manifest, notes);
    sb.analyzed = true;
    await writeJson(recordPath, record);
  }

  if (config.filmDeleteSourceAfterAnalyze) {
    const deleted = await deleteAnalyzedSourceVideos(filmId, manifest);
    if (deleted.length > 0) notes.push(`Đã xoá ${deleted.length} video gốc đã phân tích xong (giữ clip cuối để nối đợt sau).`);
  }

  const memory = (await readJson<StoryMemory>(path.join(dir, "story_memory.json")))!;
  const timeline = (await readJson<GlobalTimeline>(path.join(dir, "timeline.json")))!;
  // Cache của clip đã bị bỏ/thay (quay lui, phân tích lại) không còn dùng tới.
  await pruneOrphanCache(dir, manifest);
  const structures = await loadStructures(dir, record.sourceBatches);
  const referencePath = path.join(dir, `${filmId}_tham_chieu.json`);
  await writeJson(referencePath, buildReferenceSummary(filmId, manifest, memory, structures));
  return {
    filmId,
    analyzedEpisodes: plan.episodes,
    reanalyzed: resuming ? [] : plan.reanalyze,
    dropped: resuming ? [] : plan.dropped,
    staleRemakes,
    referencePath,
    notes,
    stats: {
      episodes: manifest.length,
      duration: formatSeconds(timeline.totalDuration),
      segments: timeline.segments.length,
      characters: memory.characters.length,
      threads: memory.threads.length,
      openThreads: memory.threads.filter((t) => t.status === "open").length,
    },
  };
}

/**
 * Theo yêu cầu người dùng: phân tích xong thì xoá video gốc đã upload trong
 * source/ — các bước sau (remake, adaptation map) chỉ dùng timeline/memory/
 * structure. GIỮ clip cuối của manifest: đợt nạp sau dò ranh giới (đoạn lặp
 * đầu clip mới) với clip này; nó bị xoá ở lần phân tích đợt kế tiếp. Video
 * chưa phân tích (tập mới gửi chưa chạy) không đụng tới. Trả về file đã xoá.
 */
async function deleteAnalyzedSourceVideos(filmId: string, manifest: SourceClip[]): Promise<string[]> {
  const sourceDir = filmSourceDir(filmId);
  const keep = manifest.at(-1)?.path;
  const deleted: string[] = [];
  for (const clip of manifest) {
    if (!clip.path || clip.path === keep) continue;
    // Chỉ xoá file trong source/ của phim (không đụng file ngoài thư mục bot quản lý).
    if (path.resolve(path.dirname(clip.path)) !== path.resolve(sourceDir)) continue;
    if (!fs.existsSync(clip.path)) continue;
    try {
      await fsp.unlink(clip.path);
      deleted.push(path.basename(clip.path));
    } catch (err) {
      console.warn(`[film] Không xoá được video gốc "${clip.path}":`, err instanceof Error ? err.message : err);
    }
  }
  if (deleted.length > 0) console.log(`[film] ${filmId}: đã xoá video gốc đã phân tích: ${deleted.join(", ")}`);
  return deleted;
}

// ---------- Remake ----------

export interface RemakePlan {
  name: string;
  isNew: boolean;
  note?: string;
  from: number;
  to: number;
}

function remakeVersion(name: string): number {
  return Number(name.match(/_remake_(\d+)$/)?.[1] ?? 0);
}

/**
 * Kế hoạch remake trên các tập gốc ĐÃ PHÂN TÍCH. Lỗi (chưa phân tích, bản
 * không có, đã đủ tập) → FilmPlanError để bot báo TRƯỚC khi enqueue.
 * suggestedNewName (resolveNextRemakeVersion theo generated/) — bản mới lấy
 * số lớn hơn giữa nó và các bản đã có trong film.json.
 */
/** Clip đã phân tích xong + số tập gốc của chúng (= số tập remake), theo thứ tự phim. */
async function analyzedClipsOf(filmId: string, record: FilmRecord | null): Promise<{ clip: SourceClip; episode: number }[]> {
  const manifest = (await readJson<SourceClip[]>(path.join(filmDirFor(filmId), "manifest.json"))) ?? [];
  return manifest.slice(0, analyzedClipCount(record)).map((clip, i) => ({ clip, episode: clip.sourceEpisode ?? i + 1 }));
}

export async function planFilmRemake(filmId: string, choice: RemakeChoice, suggestedNewName: string): Promise<RemakePlan> {
  const record = await readFilmRecord(filmId);
  const analyzed = (await analyzedClipsOf(filmId, record)).map((a) => a.episode);
  if (!record || analyzed.length === 0) {
    throw new FilmPlanError(`Phim "${filmId}" chưa phân tích xong tập nào — dùng nút "Phân tích phim gốc" trước.`);
  }
  const last = analyzed[analyzed.length - 1];
  // Remake chỉ chạy trên các tập gốc LIÊN TỤC (2, 3, 4, 5) — có lỗ (2, 3, 5, 6)
  // thì tập remake sau lỗ không nối được mạch, bắt phân tích bổ sung trước.
  const missing = analyzed.slice(1).flatMap((ep, i) =>
    Array.from({ length: ep - analyzed[i] - 1 }, (_, k) => analyzed[i] + k + 1),
  );
  if (missing.length > 0) {
    throw new FilmPlanError(
      `Tập gốc đã phân tích không liên tục (${formatEpisodes(analyzed)}) — thiếu tập ${formatEpisodes(missing)}. Remake chỉ chạy trên các tập liền nhau: gửi tập ${formatEpisodes(missing)} qua "Phân tích phim gốc" trước.`,
    );
  }
  if (choice.mode === "new") {
    const version = Math.max(remakeVersion(suggestedNewName), ...record.remakes.map((r) => remakeVersion(r.name) + 1), 1);
    return { name: `${filmId}_remake_${version}`, isNew: true, note: choice.note, from: analyzed[0], to: last };
  }
  const remake = record.remakes.find((r) => r.name.toLowerCase() === choice.name.toLowerCase());
  if (!remake) throw new FilmPlanError(`Phim "${filmId}" không có bản remake "${choice.name}".`);
  if (remake.numbering !== "source") {
    throw new FilmPlanError(
      `Bản "${remake.name}" tạo theo cách đánh số tập CŨ (1, 2, 3... thay vì đúng số tập gốc) — không tạo tiếp được. Dùng "Remake phim" để tạo bản mới.`,
    );
  }
  const unfinished = remake.batches.find((b) => !b.done);
  const doneUntil = remakeDoneUntil(remake);
  const pending = analyzed.filter((ep) => ep > doneUntil);
  if (!unfinished && pending.length === 0) {
    const pendingSource = record.sourceBatches.some((b) => !b.analyzed);
    throw new FilmPlanError(
      `Bản "${remake.name}" đã remake tới tập ${doneUntil} = tập gốc cuối đã phân tích.${pendingSource ? " Có tập gốc chưa phân tích xong — chạy lại" : " Muốn thêm tập: gửi tập gốc mới qua"} nút "Phân tích phim gốc" rồi quay lại "Tạo phim tiếp".`,
    );
  }
  return { name: remake.name, isNew: false, note: remake.note, from: unfinished?.firstEpisode ?? pending[0], to: last };
}

/** Tình trạng phim cho bot trả lời. */
export async function describeFilm(filmId: string): Promise<{
  record: FilmRecord | null;
  /** Số tập gốc (theo tên file) đã phân tích, theo thứ tự phim. */
  analyzedEpisodes: number[];
  /** Tập trong thư mục nguồn chưa phân tích, sau tập cuối đã phân tích. */
  pendingEpisodes: number[];
  remakes: { name: string; note?: string; doneUntil: number; unfinished: string | null }[];
}> {
  const record = await readFilmRecord(filmId);
  const analyzed = await analyzedSourceEpisodes(filmId, record);
  const { byEpisode } = await listSourceEpisodes(filmSourceDir(filmId));
  const last = Math.max(0, ...analyzed);
  return {
    record,
    analyzedEpisodes: analyzed,
    pendingEpisodes: [...byEpisode.keys()].filter((ep) => ep > last),
    remakes: (record?.remakes ?? []).map((r) => {
      const unfinished = r.batches.find((b) => !b.done);
      return {
        name: r.name,
        note: r.note,
        doneUntil: remakeDoneUntil(r),
        unfinished: unfinished ? `${unfinished.firstEpisode}–${unfinished.lastEpisode}` : null,
      };
    }),
  };
}

export interface FilmRemakeOptions {
  jobId: string;
  filmId: string;
  choice: RemakeChoice;
  /** Tên gợi ý cho bản remake mới (xem planFilmRemake). */
  suggestedNewName: string;
  /** Tin nhắn gửi kèm file đính kèm khi tạo từng tập (như "Tạo kịch bản mới"). */
  episodeMessage: string;
  onStatus?: (text: string) => Promise<void>;
}

export interface FilmRemakeResult {
  remakeBaseName: string;
  isNewRemake: boolean;
  /** File JSON các tập remake vừa tạo (trong chatAIResultsDir), đúng thứ tự. */
  episodeFiles: string[];
  /** Tập remake đầu tiên KHÔNG tạo được — undefined nếu đủ. */
  failedEpisode?: number;
  firstEpisode: number;
  lastEpisode: number;
  seriesDir: string;
  notes: string[];
}

/** Stage 2–5 cho 1 đợt phim gốc (đợt đã có trong manifest + film.json). */
async function analyzeSourceBatch(
  opts: { jobId: string; filmId: string; onStatus?: (text: string) => Promise<void> },
  sb: SourceBatch,
  /** Các đợt đứng trước sb trong phim (structure của chúng là ngữ cảnh). */
  previousBatches: SourceBatch[],
  manifest: SourceClip[],
  notes: string[],
): Promise<void> {
  const { jobId, onStatus } = opts;
  const dir = filmDirFor(opts.filmId);
  const timelinePath = path.join(dir, "timeline.json");
  let timeline = (await readJson<GlobalTimeline>(timelinePath)) ?? emptyTimeline();
  const batchClips = sb.clipIds.map((id) => manifest.find((c) => c.clipId === id)!);

  if (!timeline.batches.some((b) => b.batch === sb.batch)) {
    const previousClips = manifest.filter((c) => c.batch < sb.batch);
    const { timeline: next, warnings } = await appendToTimeline(timeline, previousClips, batchClips, sb.batch, onStatus);
    timeline = next;
    await writeJson(timelinePath, timeline);
    notes.push(...warnings.map((w) => `Timeline ${w.clipId}: ${w.message}`));
  }
  const transcripts = new Map<string, ClipTranscript>();
  for (const clip of batchClips) {
    const tPath = path.join(dir, "transcripts", `${clip.clipId}.json`);
    let t = await readJson<ClipTranscript>(tPath);
    if (!t) {
      await onStatus?.(`⏳ [2/7] Nhận dạng thoại tập gốc ${manifest.indexOf(clip) + 1}...`);
      t = await transcribeClip(clip, timeline);
      await writeJson(tPath, t);
    }
    transcripts.set(clip.clipId, t);
  }

  const memoryPath = path.join(dir, "story_memory.json");
  let memory = (await readJson<StoryMemory>(memoryPath)) ?? emptyMemory();
  for (const [i, clip] of batchClips.entries()) {
    if (memory.analyzed_clips.includes(clip.clipId)) continue;
    memory = await analyzeClip({
      jobId,
      filmDir: dir,
      clip,
      tl: timeline,
      transcript: transcripts.get(clip.clipId) ?? null,
      memory,
      previousEpisode: (() => {
        const prev = manifest[manifest.indexOf(clip) - 1];
        return prev ? (prev.sourceEpisode ?? manifest.indexOf(prev) + 1) : null;
      })(),
      clipIndex: i + 1,
      clipCount: batchClips.length,
      onStatus,
    });
    await writeJson(path.join(dir, "memory", `after_${clip.clipId}.json`), memory);
    await writeJson(memoryPath, memory);
  }
  await reconstructBatch({ jobId, filmDir: dir, memory, tl: timeline, sourceBatch: sb, previousBatches, onStatus });
}

/** Ghi chú riêng của bản remake → chèn vào ngữ cảnh mọi bước viết kịch bản. */
function remakeNoteSection(note: string | undefined): string {
  return note
    ? `\n\n## YÊU CẦU RIÊNG CỦA BẢN REMAKE NÀY (áp cho Bible/Arc/mọi tập — ưu tiên dưới Continuity/Bible đã khoá)\n${note}`
    : "";
}

export async function runFilmRemake(opts: FilmRemakeOptions): Promise<FilmRemakeResult> {
  const { jobId, filmId, onStatus } = opts;
  const plan = await planFilmRemake(filmId, opts.choice, opts.suggestedNewName);
  const dir = filmDirFor(filmId);
  const recordPath = path.join(dir, "film.json");
  const record = (await readFilmRecord(filmId))!;
  const analyzed = await analyzedClipsOf(filmId, record);
  const manifest = analyzed.map((a) => a.clip);
  const clipByEpisode = new Map(analyzed.map((a) => [a.episode, a.clip]));
  const memory = (await readJson<StoryMemory>(path.join(dir, "story_memory.json")))!;
  const timeline = (await readJson<GlobalTimeline>(path.join(dir, "timeline.json")))!;
  const structures = await loadStructures(dir, record.sourceBatches.filter((b) => b.analyzed));
  const episodeOf = episodeMapper(manifest);
  const notes: string[] = [];

  let remake = record.remakes.find((r) => r.name === plan.name);
  if (!remake) {
    remake = { name: plan.name, createdAt: new Date().toISOString(), note: plan.note, numbering: "source", batches: [] };
    record.remakes.push(remake);
    await writeJson(recordPath, record);
  }
  const remakeDir = remakeDirFor(filmId, remake.name);
  await fsp.mkdir(remakeDir, { recursive: true });
  const result: FilmRemakeResult = {
    remakeBaseName: remake.name,
    isNewRemake: plan.isNew,
    episodeFiles: [],
    firstEpisode: plan.from,
    lastEpisode: plan.to,
    seriesDir: seriesDirFor(remake.name),
    notes,
  };
  const noteSection = remakeNoteSection(remake.note);

  // Chia đợt tới hết tập gốc đã phân tích; đợt dở (nếu có) làm tiếp trước. Số
  // tập remake = số tập gốc (có thể không liền nhau: 2, 3, 6).
  for (;;) {
    const doneUntil = remakeDoneUntil(remake);
    let rb = remake.batches.find((b) => !b.done);
    if (!rb) {
      const pending = analyzed.filter((a) => a.episode > doneUntil).slice(0, config.filmRemakeChunkEpisodes);
      if (pending.length === 0) break;
      rb = { firstEpisode: pending[0].episode, lastEpisode: pending[pending.length - 1].episode, done: false };
      remake.batches.push(rb);
      await writeJson(recordPath, record);
    }
    const batch = rb;
    const chunk = analyzed.filter((a) => a.episode >= batch.firstEpisode && a.episode <= batch.lastEpisode);
    const chunkClips = chunk.map((a) => a.clip);
    const adaptationMap = await loadAdaptationMap(remakeDir);
    const series = await generateSeriesWithGemini({
      jobId,
      referenceFileNames: chunkClips.map((c) => `${filmId}_${c.clipId}`),
      sourceEpisodes: chunkClips.map((c) => buildSourceEpisode(c, timeline, memory)),
      globalContext: {
        overview: `${buildGlobalOverview(memory, structures, adaptationMap, episodeOf)}${noteSection}`,
        episode: (tap) => buildEpisodeContext(clipByEpisode.get(tap)!.clipId, memory, structures, adaptationMap, episodeOf, timeline),
        rules: `${FILM_EPISODE_RULES}${noteSection}`,
      },
      remakeBaseName: remake.name,
      episodeMessage: opts.episodeMessage,
      startEpisode: rb.firstEpisode,
      episodeNumbers: chunk.map((a) => a.episode),
      previousEpisode: doneUntil,
      // Flow phim không chạy QA — viết xong tập là gửi JSON.
      skipQa: true,
      // Tổng thời lượng tập remake phải gần tập gốc (lệch → Gemini viết lại kèm lỗi).
      checkEpisode: (tap, value) =>
        checkEpisodeDuration(value, storyDurationOf(clipByEpisode.get(tap)!.clipId, timeline, memory)),
      filmId,
      onStatus,
    });
    result.episodeFiles.push(...series.episodeFiles);
    if (series.failedEpisode !== undefined) {
      result.failedEpisode = series.failedEpisode;
      break;
    }
    try {
      const map = await updateAdaptationMap({
        jobId,
        remakeDir,
        seriesDir: seriesDirFor(remake.name),
        memory,
        structures,
        firstEpisode: rb.firstEpisode,
        lastEpisode: rb.lastEpisode,
        episodeOf,
        onStatus,
      });
      await writeJson(adaptationMapPath(remakeDir), map);
      rb.done = true;
      await writeJson(recordPath, record);
    } catch (err) {
      notes.push(
        `Chưa cập nhật được ánh xạ gốc → "${remake.name}" sau tập ${rb.lastEpisode} (${err instanceof Error ? err.message.split("\n")[0] : err}) — dừng; bấm "Tạo phim tiếp" với "${remake.name}" để làm tiếp.`,
      );
      break;
    }
  }
  return result;
}

/**
 * Phân tích sẵn của 1 tập gốc (tóm tắt, scene/beat, đường cảm xúc, twist) —
 * tài liệu tham khảo cho bước so sánh video gốc ↔ remake ("Test prompt remake phim").
 */
export async function episodeAnalysisSummary(filmId: string, episode: number): Promise<unknown> {
  const dir = filmDirFor(filmId);
  const record = await readFilmRecord(filmId);
  const manifest = (await readJson<SourceClip[]>(path.join(dir, "manifest.json"))) ?? [];
  const clip = manifest.find((c, i) => (c.sourceEpisode ?? i + 1) === episode);
  if (!clip) return null;
  const memory = await readJson<StoryMemory>(path.join(dir, "story_memory.json"));
  const structures = await loadStructures(dir, record?.sourceBatches.filter((b) => b.analyzed) ?? []);
  const events = (memory?.events ?? []).filter((e) => e.clip_id === clip.clipId);
  const eventIds = new Set(events.map((e) => e.id));
  return {
    episode,
    summary: memory?.clips.find((c) => c.clip_id === clip.clipId)?.summary,
    events: events.map((e) => ({ id: e.id, type: e.type, summary: e.summary })),
    scenes: structures.flatMap((s) => s.scenes.filter((sc) => sc.clip_id === clip.clipId)),
    emotion_curve: structures.flatMap((s) => s.emotion_curve.filter((c) => c.clip_id === clip.clipId)),
    twists: structures.flatMap((s) => s.twists.filter((t) => eventIds.has(t.event_id))),
    power_shifts: structures.flatMap((s) => s.power_shifts.filter((p) => eventIds.has(p.event_id))),
  };
}
