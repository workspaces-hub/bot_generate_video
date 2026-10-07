/**
 * "Tạo kịch bản mới" nhiều tập bằng Gemini — pipeline series (theo yêu cầu
 * người dùng):
 *
 *   N JSON tham chiếu → Dramatic DNA từng file → Series Bible → Season Arc N
 *   tập → tạo từng tập tuần tự → cập nhật Continuity Ledger sau mỗi tập →
 *   QA toàn series.
 *
 * Tập N nhận: Series Bible + Season Arc tập N + End State (ledger) tập N-1 +
 * Dramatic DNA tập gốc N (+ JSON tập gốc N làm nguồn beat chi tiết, + sổ asset đã
 * chốt). Ưu tiên: Continuity > Season Arc > Dramatic DNA nguồn > chi tiết
 * mới. Mỗi tập gồm Carry-in → DNA drama → Carry-out/cliffhanger.
 *
 * Tạo theo ĐỢT: "Tạo kịch bản mới" = đợt đầu (startEpisode=1, tạo Bible +
 * Arc, số tập = số file tham chiếu); "Tiếp tục tạo kịch bản" từ tập K
 * (startEpisode=K) dùng lại Bible đã khoá (chỉ được THÊM thực thể mới — xem
 * mergeBible), lập Season Arc cho đợt mới từ ledger sau tập K-1, tập K nối
 * tiếp end state tập K-1. Không biết tổng số tập cả series → tập cuối mỗi
 * đợt vẫn kết bằng cliffhanger để còn tạo tiếp được.
 *
 * Mỗi bước là 1 cuộc chat Gemini mới (askGemini). Kết quả từng bước lưu ở
 * config.seriesDir/<remakeBaseName>/ — bước nào đã có file thì bỏ qua, nên
 * job chạy lại (bot restart giữa chừng) làm tiếp từ bước dở.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { askGemini } from "./geminiAI";

export interface SeriesGenerationOptions {
  jobId: string;
  /** Tên file JSON tham chiếu (trong config.chatAIResultsDir), đúng thứ tự tập, bắt đầu từ startEpisode. */
  referenceFileNames: string[];
  /** Tên series — tập N lưu thành "<remakeBaseName>_tap<N>_full.json". */
  remakeBaseName: string;
  /** Tin nhắn gửi kèm file đính kèm khi tạo từng tập. */
  episodeMessage: string;
  /** Số tập của referenceFileNames[0] (mặc định 1 = series mới). */
  startEpisode?: number;
  /** Từ khoá tìm file tham chiếu — lưu vào series_meta.json để "Tiếp tục tạo kịch bản" tìm lại. */
  searchTerm?: string;
  onStatus?: (text: string) => Promise<void>;
}

export interface SeriesGenerationResult {
  /** File JSON các tập đã tạo trong đợt này (trong config.chatAIResultsDir), đúng thứ tự. */
  episodeFiles: string[];
  /** Tập đầu tiên KHÔNG tạo được (dừng ở đó) — undefined nếu đủ mọi tập của đợt. */
  failedEpisode?: number;
  /** Báo cáo QA của đợt (null nếu bước QA lỗi/không chạy). */
  qaReportPath: string | null;
  seriesDir: string;
}

export interface SeriesMeta {
  searchTerm?: string;
  /** Số tập → tên file tham chiếu đã dùng. */
  references: Record<string, string>;
}

const STAGE_ATTEMPTS = 2;

export function seriesDirFor(remakeBaseName: string): string {
  return path.join(config.seriesDir, remakeBaseName);
}

export async function readSeriesMeta(remakeBaseName: string): Promise<SeriesMeta | null> {
  try {
    return JSON.parse(
      await fsp.readFile(path.join(seriesDirFor(remakeBaseName), "series_meta.json"), "utf-8"),
    ) as SeriesMeta;
  } catch {
    return null;
  }
}

/** Số tập lớn nhất đã tạo xong (có file trong episodes/) của series — 0 nếu chưa có. */
export async function lastSeriesEpisode(remakeBaseName: string): Promise<number> {
  const files = await fsp
    .readdir(path.join(seriesDirFor(remakeBaseName), "episodes"))
    .catch(() => [] as string[]);
  let max = 0;
  for (const f of files) {
    const m = f.match(/_tap(\d+)_full\.json$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function jsonSection(title: string, value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `\n\n## ${title}\n\`\`\`json\n${body}\n\`\`\``;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function videoEntries(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).filter(
    (e): e is Record<string, unknown> => isRecord(e) && e.type === "VIDEO",
  );
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Chạy 1 bước phân tích (DNA/Bible/Arc/Ledger/QA): gửi master prompt của
 * bước + dữ liệu đầu vào (file .txt đính kèm), lưu JSON kết quả ra outPath.
 * Đã có outPath thì dùng lại (resume). validate trả về lý do lỗi → coi như
 * lần thử thất bại.
 */
async function runJsonStage(opts: {
  jobId: string;
  name: string;
  label: string;
  promptPath: string;
  input: string;
  outPath: string;
  protectedNames: Set<string>;
  validate?: (value: unknown) => string | null;
  onStatus?: (text: string) => Promise<void>;
}): Promise<unknown> {
  if (fs.existsSync(opts.outPath)) {
    const value = await readJsonIfExists(opts.outPath);
    if (value !== null && !opts.validate?.(value)) {
      console.log(`[series] (${opts.jobId}) ${opts.label}: dùng lại kết quả đã có ${opts.outPath}`);
      return value;
    }
  }

  const stagePrompt = await fsp.readFile(opts.promptPath, "utf-8");
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  const attachmentPath = path.join(config.uploadsDir, `${randomUUID()}-series-${opts.name}.txt`);
  await fsp.writeFile(attachmentPath, opts.input, "utf-8");
  let lastError = "";
  try {
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
      await opts.onStatus?.(
        `⏳ ${opts.label}${attempt > 1 ? ` — thử lại lần ${attempt}` : ""}...`,
      );
      let downloadedFiles: string[] = [];
      try {
        ({ downloadedFiles } = await askGemini(
          `${stagePrompt}\n\nDữ liệu đầu vào nằm trong file đính kèm.`,
          `${opts.jobId}-${opts.name}`,
          `${path.basename(opts.outPath, ".json")}__${randomUUID().slice(0, 8)}.json`,
          attachmentPath,
        ));
        const produced = downloadedFiles.find((f) => f.toLowerCase().endsWith(".json"));
        if (!produced) throw new Error("Gemini không trả về JSON nào.");
        const value: unknown = JSON.parse(await fsp.readFile(produced, "utf-8"));
        const invalid = opts.validate?.(value);
        if (invalid) throw new Error(invalid);
        await fsp.mkdir(path.dirname(opts.outPath), { recursive: true });
        await fsp.writeFile(opts.outPath, JSON.stringify(value, null, 2), "utf-8");
        console.log(`[series] (${opts.jobId}) ${opts.label}: xong → ${opts.outPath}`);
        return value;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[series] (${opts.jobId}) ${opts.label} lỗi (lần ${attempt}/${STAGE_ATTEMPTS}): ${lastError}`);
      } finally {
        // File tạm của askGemini nằm trong chatAIResultsDir — KHÔNG xoá nhầm
        // file tham chiếu (Gemini có thể đặt key trùng tên file tham chiếu).
        for (const f of downloadedFiles) {
          if (!opts.protectedNames.has(path.basename(f))) await fsp.unlink(f).catch(() => {});
        }
      }
    }
  } finally {
    await fsp.unlink(attachmentPath).catch(() => {});
  }
  throw new Error(`${opts.label} thất bại sau ${STAGE_ATTEMPTS} lần thử: ${lastError}`);
}

/**
 * Kiểm tra kỹ thuật bằng code theo master prompt tạo tập: aspectRatio 9:16,
 * frameRate theo tập gốc (tập gốc không có thì 24),
 * duration nằm trong khoảng giây ghi ở tiêu đề prompt (vd
 * "4–9 SECONDS"). Không so số VIDEO/duration với tập gốc — prompt cho phép
 * chia lại clip.
 */
function technicalCheck(
  output: unknown,
  durationRange: [number, number] | null,
  sourceFrameRates: Set<number>,
): string[] {
  const allowedFrameRates = sourceFrameRates.size > 0 ? sourceFrameRates : new Set([24]);
  const out = videoEntries(output);
  const issues: string[] = [];
  if (out.length === 0) issues.push("Không có VIDEO nào.");
  for (const v of out) {
    const id = String(v.id);
    if (v.aspectRatio !== "9:16") issues.push(`${id}: aspectRatio ${JSON.stringify(v.aspectRatio)} ≠ "9:16".`);
    if (!allowedFrameRates.has(Number(v.frameRate))) {
      issues.push(`${id}: frameRate ${JSON.stringify(v.frameRate)} ≠ tập gốc (${[...allowedFrameRates].join("/")}).`);
    }
    const duration = Number(v.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      issues.push(`${id}: duration ${JSON.stringify(v.duration)} không hợp lệ.`);
    } else if (durationRange && (duration < durationRange[0] || duration > durationRange[1])) {
      issues.push(`${id}: duration ${duration}s ngoài khoảng ${durationRange[0]}–${durationRange[1]}s.`);
    }
  }
  return issues;
}

/** Khoảng giây mỗi VIDEO ghi trong tiêu đề master prompt, vd "4–9 SECONDS" → [4, 9]. */
function parseDurationRange(masterPrompt: string): [number, number] | null {
  const m = masterPrompt.match(/(\d+)\s*[–-]\s*(\d+)\s*SECONDS/i);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Tóm tắt 1 tập cho bước QA — đầu prompt + END FRAME của từng VIDEO (JSON đầy đủ quá lớn). */
function summarizeEpisode(value: unknown): unknown[] {
  return videoEntries(value).map((v) => {
    const prompt = typeof v.prompt === "string" ? v.prompt : "";
    const endIndex = prompt.lastIndexOf("END FRAME");
    return {
      id: v.id,
      duration: v.duration,
      start: prompt.slice(0, 600),
      end: endIndex >= 0 ? prompt.slice(endIndex, endIndex + 600) : prompt.slice(-400),
    };
  });
}

function arcEpisodes(arc: unknown): unknown[] {
  if (Array.isArray(arc)) return arc;
  if (isRecord(arc) && Array.isArray(arc.episodes)) return arc.episodes;
  return [];
}

/** Season Arc của 1 đợt bắt đầu ở firstEpisode — tìm theo số "episode", không có thì theo vị trí. */
function arcEntry(arc: unknown, episode: number, firstEpisode: number): unknown {
  const list = arcEpisodes(arc);
  return (
    list.find((e) => isRecord(e) && Number(e.episode) === episode) ??
    list[episode - firstEpisode] ??
    null
  );
}

/** Các file Season Arc của series: season_arc.json (đợt từ tập 1) + season_arc_tap<K>.json (đợt từ tập K). */
async function loadArcBatches(seriesDir: string): Promise<{ start: number; arc: unknown }[]> {
  const files = await fsp.readdir(seriesDir).catch(() => [] as string[]);
  const batches: { start: number; arc: unknown }[] = [];
  for (const f of files) {
    const m = f === "season_arc.json" ? ["", "1"] : f.match(/^season_arc_tap(\d+)\.json$/);
    if (!m) continue;
    const arc = await readJsonIfExists(path.join(seriesDir, f));
    if (arc !== null) batches.push({ start: Number(m[1]), arc });
  }
  return batches.sort((a, b) => a.start - b.start);
}

const BIBLE_ID_LISTS = ["characters", "core_locations", "core_props"] as const;
const BIBLE_APPEND_LISTS = [
  "relationships",
  "secrets",
  "long_term_conflicts",
  "source_to_target_map",
] as const;

/**
 * Bible hiệu lực = Bible gốc + các phần mở rộng theo đợt. Phần mở rộng CHỈ
 * được thêm — thực thể trùng id đã khoá bị bỏ (không cho sửa danh tính).
 */
function mergeBible(base: unknown, extensions: unknown[]): unknown {
  if (!isRecord(base)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const ext of extensions) {
    if (!isRecord(ext)) continue;
    for (const key of BIBLE_ID_LISTS) {
      const current = Array.isArray(merged[key]) ? [...(merged[key] as unknown[])] : [];
      const ids = new Set(current.map((e) => (isRecord(e) ? e.id : undefined)));
      for (const item of Array.isArray(ext[key]) ? (ext[key] as unknown[]) : []) {
        const id = isRecord(item) ? item.id : undefined;
        if (typeof id === "string" && ids.has(id)) {
          console.warn(`[series] Bible mở rộng định nghĩa lại "${id}" đã khoá — bỏ qua.`);
          continue;
        }
        ids.add(id);
        current.push(item);
      }
      merged[key] = current;
    }
    for (const key of BIBLE_APPEND_LISTS) {
      const additions = Array.isArray(ext[key]) ? (ext[key] as unknown[]) : [];
      if (additions.length === 0) continue;
      merged[key] = [...(Array.isArray(merged[key]) ? (merged[key] as unknown[]) : []), ...additions];
    }
  }
  return merged;
}

async function loadBibleExtensions(seriesDir: string, upToEpisode: number): Promise<unknown[]> {
  const files = await fsp.readdir(seriesDir).catch(() => [] as string[]);
  const exts: { tap: number; value: unknown }[] = [];
  for (const f of files) {
    const m = f.match(/^bible_ext_tap(\d+)\.json$/);
    if (!m || Number(m[1]) > upToEpisode) continue;
    const value = await readJsonIfExists(path.join(seriesDir, f));
    if (value !== null) exts.push({ tap: Number(m[1]), value });
  }
  return exts.sort((a, b) => a.tap - b.tap).map((e) => e.value);
}

function scopeHeader(start: number, end: number): string {
  const count = end - start + 1;
  return `## PHẠM VI ĐỢT NÀY\nTạo tập ${start}–${end} (${count} tập). Đánh số "episode" đúng theo phạm vi này (${start}, ${start + 1}, ...). Tổng số tập của cả series chưa xác định — series có thể được tạo tiếp: tập ${end} trả thưởng một phần nhưng vẫn kết bằng cliffhanger, không đóng hết bí mật/conflict dài hạn.`;
}

const SERIES_EPISODE_RULES = `## QUY TẮC SERIES (áp dụng cho tập này, ưu tiên CAO HƠN các mục mâu thuẫn bên trên)
Tập này là MỘT TẬP trong một series liền mạch. Đầu vào gồm: TARGET SERIES BIBLE (khóa nhân vật, tính cách, mục tiêu, quan hệ, thế giới, bí mật, conflict dài hạn, id asset), SEASON ARC của tập này, END STATE tập trước (Continuity Ledger), DRAMATIC DNA của TẬP GỐC hiện tại, và JSON TẬP GỐC (nguồn beat/DNA chi tiết của tập hiện tại).

THỨ TỰ ƯU TIÊN KHI MÂU THUẪN: Continuity (END STATE tập trước) > Season Arc tập này > Dramatic DNA tập gốc > chi tiết cốt truyện mới.

TẬP NÀY BẮT BUỘC CÓ 3 PHẦN:
1. CARRY-IN: các VIDEO đầu tiếp nhận trực tiếp trạng thái cuối tập trước (vị trí, thương tích, trang phục, ai biết gì, quan hệ, đạo cụ, cảm xúc, cliffhanger). Tập 1: thiết lập theo Season Arc.
2. DNA DRAMA: thân tập tái tạo Dramatic DNA của tập gốc (emotional curve, escalation, power shift, reveal/reversal, climax, pacing, cường độ phản ứng) bằng nhân vật/thế giới của Series Bible.
3. CARRY-OUT: kết tập bằng cliffhanger theo Season Arc ("carry_out_cliffhanger"), dẫn thẳng vào tập sau.

- Dùng ĐÚNG id + mô tả nhận dạng trong Series Bible / sổ asset; KHÔNG dùng lại danh tính, tên, thế giới của tập gốc.
- Không để nhân vật biết điều ledger ghi là họ chưa biết; không reset thương tích/đạo cụ/quan hệ.
- Khung kỹ thuật (duration từng VIDEO, số VIDEO/shot/clip, aspectRatio, frameRate, schema JSON) theo ĐÚNG quy định của master prompt bên trên — quy tắc series này KHÔNG thay đổi các quy định đó.`;

/**
 * Chạy pipeline series cho 1 đợt. Bước DNA/Bible/Arc lỗi → throw. Tập lỗi
 * (sau 2 lần thử) → dừng, trả các tập đã xong + failedEpisode (tập sau cần
 * tập này để nối mạch). Ledger/QA lỗi chỉ cảnh báo.
 */
export async function generateSeriesWithGemini(
  opts: SeriesGenerationOptions,
): Promise<SeriesGenerationResult> {
  const { jobId, referenceFileNames, remakeBaseName, onStatus } = opts;
  const start = opts.startEpisode ?? 1;
  const end = start + referenceFileNames.length - 1;
  const seriesDir = seriesDirFor(remakeBaseName);
  const episodesDir = path.join(seriesDir, "episodes");
  await fsp.mkdir(episodesDir, { recursive: true });
  const protectedNames = new Set(referenceFileNames.map((n) => path.basename(n)));
  const episodePath = (tap: number) => path.join(episodesDir, `${remakeBaseName}_tap${tap}_full.json`);

  // Meta series — "Tiếp tục tạo kịch bản" đọc lại searchTerm.
  const meta: SeriesMeta = (await readSeriesMeta(remakeBaseName)) ?? { references: {} };
  if (opts.searchTerm) meta.searchTerm = opts.searchTerm;
  referenceFileNames.forEach((name, i) => {
    meta.references[String(start + i)] = name;
  });
  await fsp.writeFile(path.join(seriesDir, "series_meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  const scope = scopeHeader(start, end);

  if (start > 1 && !fs.existsSync(episodePath(start - 1))) {
    throw new Error(`Series "${remakeBaseName}" chưa có tập ${start - 1} — không tạo tiếp từ tập ${start} được.`);
  }

  const references: { tap: number; name: string; content: string; value: unknown }[] = [];
  for (const [i, name] of referenceFileNames.entries()) {
    const content = await fsp.readFile(
      path.join(config.chatAIResultsDir, path.basename(name)),
      "utf-8",
    );
    let value: unknown = null;
    try {
      value = JSON.parse(content);
    } catch {
      // vẫn gửi nguyên văn cho Gemini
    }
    references.push({ tap: start + i, name, content, value });
  }

  // 1. Dramatic DNA từng tập gốc của đợt.
  const dnas: unknown[] = [];
  for (const ref of references) {
    dnas.push(
      await runJsonStage({
        jobId,
        name: `dna_tap${ref.tap}`,
        label: `[1/5] Trích Dramatic DNA tập gốc ${ref.tap}/${end} (${ref.name})`,
        promptPath: config.promptSeriesDna,
        input: jsonSection(`TẬP GỐC ${ref.tap}: ${ref.name}`, ref.content),
        outPath: path.join(seriesDir, `dna_tap${ref.tap}.json`),
        protectedNames,
        validate: (v) => (isRecord(v) ? null : "DNA không phải JSON object."),
        onStatus,
      }),
    );
  }
  const dnaInput = dnas
    .map((dna, i) => jsonSection(`DRAMATIC DNA TẬP GỐC ${references[i].tap} (${references[i].name})`, dna))
    .join("");
  const sourceAssets = references
    .map((ref) => {
      const assets = (Array.isArray(ref.value) ? ref.value : [])
        .filter((e) => isRecord(e) && e.type !== "VIDEO")
        .map((e) => ({ id: e.id, type: e.type }));
      return jsonSection(`ASSET TẬP GỐC ${ref.tap} (chỉ id/type, để hiểu vai trò)`, assets);
    })
    .join("");

  // End state trước đợt (chỉ khi tạo tiếp).
  let previousLedger: unknown = null;
  let previousEpisodeValue: unknown = null;
  if (start > 1) {
    previousLedger = await readJsonIfExists(path.join(seriesDir, `ledger_tap${start - 1}.json`));
    previousEpisodeValue = await readJsonIfExists(episodePath(start - 1));
  }
  const previousEndState = previousLedger
    ? jsonSection(`CONTINUITY LEDGER SAU TẬP ${start - 1} (end state trước đợt này)`, previousLedger)
    : previousEpisodeValue
      ? jsonSection(`VIDEO CUỐI TẬP ${start - 1} (end state trước đợt này)`, videoEntries(previousEpisodeValue).at(-1) ?? null)
      : "";

  // 2. Series Bible — đợt đầu tạo mới; đợt sau dùng lại + mở rộng (chỉ thêm).
  const biblePath = path.join(seriesDir, "series_bible.json");
  let bible: unknown;
  if (start === 1) {
    const base = await runJsonStage({
      jobId,
      name: "bible",
      label: `[2/5] Tạo Series Bible`,
      promptPath: config.promptSeriesBible,
      input: `${scope}${dnaInput}${sourceAssets}`,
      outPath: biblePath,
      protectedNames,
      validate: (v) =>
        isRecord(v) && Array.isArray(v.characters) && v.characters.length > 0
          ? null
          : "Series Bible thiếu danh sách characters.",
      onStatus,
    });
    bible = mergeBible(base, await loadBibleExtensions(seriesDir, start));
  } else {
    const base = await readJsonIfExists(biblePath);
    if (!isRecord(base)) {
      throw new Error(`Series "${remakeBaseName}" không có series_bible.json — không tạo tiếp được.`);
    }
    const lockedBible = mergeBible(base, await loadBibleExtensions(seriesDir, start - 1));
    await runJsonStage({
      jobId,
      name: `bible_ext_tap${start}`,
      label: `[2/5] Mở rộng Series Bible cho tập ${start}–${end}`,
      promptPath: config.promptSeriesBibleExtend,
      input: `${scope}${jsonSection("SERIES BIBLE ĐÃ KHÓA", lockedBible)}${previousEndState}${dnaInput}${sourceAssets}`,
      outPath: path.join(seriesDir, `bible_ext_tap${start}.json`),
      protectedNames,
      validate: (v) => (isRecord(v) ? null : "Bible mở rộng không phải JSON object."),
      onStatus,
    });
    bible = mergeBible(base, await loadBibleExtensions(seriesDir, start));
  }

  // 3. Season Arc của đợt.
  const previousArcSummary: unknown[] = [];
  if (start > 1) {
    for (const batch of await loadArcBatches(seriesDir)) {
      if (batch.start >= start) continue;
      for (const [i, e] of arcEpisodes(batch.arc).entries()) {
        if (!isRecord(e)) continue;
        const episode = Number(e.episode) || batch.start + i;
        if (episode >= start) continue;
        previousArcSummary.push({
          episode,
          role_in_season: e.role_in_season,
          carry_out_cliffhanger: e.carry_out_cliffhanger,
          threads_opened: e.threads_opened,
          threads_closed: e.threads_closed,
        });
      }
    }
  }
  const batchCount = end - start + 1;
  const arc = await runJsonStage({
    jobId,
    name: start === 1 ? "arc" : `arc_tap${start}`,
    label: `[3/5] Tạo Season Arc tập ${start}–${end}`,
    promptPath: config.promptSeriesArc,
    input: [
      scope,
      jsonSection("SERIES BIBLE", bible),
      previousArcSummary.length > 0 ? jsonSection("SEASON ARC CÁC TẬP ĐÃ CÓ (tóm tắt)", previousArcSummary) : "",
      previousEndState,
      dnaInput,
    ].join(""),
    outPath: path.join(seriesDir, start === 1 ? "season_arc.json" : `season_arc_tap${start}.json`),
    protectedNames,
    validate: (v) => {
      const count = arcEpisodes(v).length;
      return count === batchCount ? null : `Season Arc có ${count} tập, cần đúng ${batchCount} (tập ${start}–${end}).`;
    },
    onStatus,
  });

  // 4. Từng tập + Continuity Ledger.
  const masterPrompt = await fsp.readFile(config.promptGenerateScriptEpisode, "utf-8");
  const durationRange = parseDurationRange(masterPrompt);
  const assetLedger = new Map<string, unknown>();
  const addAssets = (episodeValue: unknown) => {
    for (const entry of Array.isArray(episodeValue) ? episodeValue : []) {
      if (isRecord(entry) && entry.type !== "VIDEO" && typeof entry.id === "string" && !assetLedger.has(entry.id)) {
        assetLedger.set(entry.id, entry);
      }
    }
  };
  // Tạo tiếp: sổ asset dựng lại từ mọi tập đã có trước đợt.
  for (let tap = 1; tap < start; tap++) {
    addAssets(await readJsonIfExists(episodePath(tap)));
  }

  const ledgers: unknown[] = [];
  const episodeFiles: string[] = [];
  const episodeValues: unknown[] = [];
  const technicalIssues: { episode: number; issues: string[] }[] = [];
  let failedEpisode: number | undefined;

  for (const [index, ref] of references.entries()) {
    const tap = ref.tap;
    const targetName = `${remakeBaseName}_tap${tap}_full.json`;
    const checkpointPath = episodePath(tap);
    const resultPath = path.join(config.chatAIResultsDir, targetName);

    if (!fs.existsSync(checkpointPath)) {
      const nextArc = arcEntry(arc, tap + 1, start);
      const sections = [
        masterPrompt,
        `\n\n## VỊ TRÍ TRONG BỘ PHIM\nĐây là TẬP ${tap} của bộ phim mới.`,
        `\n\n${SERIES_EPISODE_RULES}`,
        jsonSection("TARGET SERIES BIBLE (đã khóa)", bible),
        jsonSection(`SEASON ARC — TẬP ${tap}`, arcEntry(arc, tap, start)),
      ];
      if (isRecord(nextArc)) {
        sections.push(
          jsonSection(`SEASON ARC — TẬP ${tap + 1} (chỉ để carry-out dẫn đúng vào tập sau)`, {
            episode: tap + 1,
            role_in_season: nextArc.role_in_season,
            carry_in: nextArc.carry_in,
          }),
        );
      }
      if (previousLedger) {
        sections.push(jsonSection(`END STATE TẬP ${tap - 1} (CONTINUITY LEDGER — ưu tiên cao nhất)`, previousLedger));
      } else if (previousEpisodeValue) {
        // Ledger tập trước lỗi — dùng tạm VIDEO cuối tập trước làm end state.
        const last = videoEntries(previousEpisodeValue).at(-1);
        sections.push(jsonSection(`END STATE TẬP ${tap - 1} (VIDEO cuối tập trước)`, last ?? null));
      }
      sections.push(jsonSection(`DRAMATIC DNA CỦA TẬP GỐC ${tap}`, dnas[index]));
      sections.push(jsonSection(`TẬP GỐC (nguồn beat/DNA chi tiết): ${ref.name}`, ref.content));
      if (assetLedger.size > 0) {
        sections.push(
          jsonSection(
            "ASSET LEDGER TOÀN PHIM (dùng lại ĐÚNG id + mô tả nếu thực thể xuất hiện lại)",
            [...assetLedger.values()],
          ),
        );
      }

      await fsp.mkdir(config.uploadsDir, { recursive: true });
      const attachmentPath = path.join(config.uploadsDir, `${randomUUID()}-series-tap${tap}.txt`);
      await fsp.writeFile(attachmentPath, sections.join(""), "utf-8");
      try {
        for (let attempt = 1; attempt <= STAGE_ATTEMPTS && !fs.existsSync(checkpointPath); attempt++) {
          await onStatus?.(
            `⏳ [4/5] Đang tạo tập ${tap} (đợt ${start}–${end}, tham chiếu ${ref.name})${attempt > 1 ? ` — thử lại lần ${attempt}` : ""}...`,
          );
          let downloadedFiles: string[] = [];
          try {
            ({ downloadedFiles } = await askGemini(
              opts.episodeMessage,
              `${jobId}-tap${tap}`,
              targetName,
              attachmentPath,
            ));
            const produced = downloadedFiles.find((f) => f.toLowerCase().endsWith(".json"));
            if (!produced) throw new Error("Gemini không trả về file JSON nào.");
            const content = await fsp.readFile(produced, "utf-8");
            JSON.parse(content);
            await fsp.writeFile(checkpointPath, content, "utf-8");
          } catch (err) {
            console.error(
              `[series] (${jobId}) tập ${tap} lỗi (lần ${attempt}/${STAGE_ATTEMPTS}):`,
              err instanceof Error ? err.message : err,
            );
          } finally {
            for (const f of downloadedFiles) {
              if (!protectedNames.has(path.basename(f))) await fsp.unlink(f).catch(() => {});
            }
          }
        }
      } finally {
        await fsp.unlink(attachmentPath).catch(() => {});
      }
      if (!fs.existsSync(checkpointPath)) {
        failedEpisode = tap;
        break;
      }
    } else {
      console.log(`[series] (${jobId}) tập ${tap}: dùng lại ${checkpointPath}`);
    }

    // Bản trả về cho processChatAIQueue (nó sẽ đổi tên/chuyển sang downloads);
    // bản trong seriesDir giữ lại làm checkpoint.
    const content = await fsp.readFile(checkpointPath, "utf-8");
    await fsp.writeFile(resultPath, content, "utf-8");
    episodeFiles.push(resultPath);
    const episodeValue: unknown = JSON.parse(content);
    episodeValues.push(episodeValue);
    previousEpisodeValue = episodeValue;
    addAssets(episodeValue);
    const sourceFrameRates = new Set(
      videoEntries(ref.value)
        .map((v) => Number(v.frameRate))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    const issues = technicalCheck(episodeValue, durationRange, sourceFrameRates);
    if (issues.length > 0) {
      technicalIssues.push({ episode: tap, issues });
      console.warn(`[series] (${jobId}) tập ${tap}: lỗi kỹ thuật:\n- ${issues.join("\n- ")}`);
    }

    // Continuity Ledger sau tập này.
    try {
      const ledger = await runJsonStage({
        jobId,
        name: `ledger_tap${tap}`,
        label: `[4/5] Cập nhật Continuity Ledger sau tập ${tap}`,
        promptPath: config.promptSeriesLedger,
        input: [
          jsonSection("SERIES BIBLE", bible),
          previousLedger ? jsonSection(`CONTINUITY LEDGER SAU TẬP ${tap - 1}`, previousLedger) : "",
          jsonSection(`SEASON ARC — TẬP ${tap}`, arcEntry(arc, tap, start)),
          jsonSection(`JSON TẬP VỪA VIẾT (TẬP ${tap}): ${targetName}`, content),
        ].join(""),
        outPath: path.join(seriesDir, `ledger_tap${tap}.json`),
        protectedNames,
        validate: (v) => (isRecord(v) ? null : "Ledger không phải JSON object."),
        onStatus,
      });
      ledgers.push(ledger);
      previousLedger = ledger;
    } catch (err) {
      console.warn(
        `[series] (${jobId}) không cập nhật được ledger sau tập ${tap} — tập sau dùng VIDEO cuối làm end state:`,
        err instanceof Error ? err.message : err,
      );
      ledgers.push(null);
      previousLedger = null;
    }
  }

  // 5. QA của đợt (chỉ khi đủ mọi tập của đợt). Tạo tiếp: kiểm thêm chỗ nối
  // tập start-1 → start.
  let qaReportPath: string | null = null;
  if (failedEpisode === undefined && episodeValues.length > 0) {
    try {
      const qa = await runJsonStage({
        jobId,
        name: start === 1 ? "qa" : `qa_tap${start}`,
        label: `[5/5] QA series (tập ${start}–${end})`,
        promptPath: config.promptSeriesQa,
        input: [
          scope,
          jsonSection("SERIES BIBLE", bible),
          jsonSection(`SEASON ARC TẬP ${start}–${end}`, arc),
          previousEndState,
          dnaInput,
          ...ledgers.map((l, i) => jsonSection(`CONTINUITY LEDGER SAU TẬP ${start + i}`, l)),
          ...episodeValues.map((v, i) => jsonSection(`TÓM TẮT TẬP MỚI ${start + i}`, summarizeEpisode(v))),
          jsonSection("KIỂM TRA KỸ THUẬT BẰNG CODE (aspectRatio 9:16, frameRate theo tập gốc, duration)", technicalIssues),
        ].join(""),
        outPath: path.join(seriesDir, start === 1 ? "qa_report.json" : `qa_report_tap${start}.json`),
        protectedNames,
        validate: (v) => (isRecord(v) ? null : "QA không phải JSON object."),
        onStatus,
      });
      qaReportPath = path.join(seriesDir, `${remakeBaseName}_qa_report_tap${start}-${end}.json`);
      await fsp.writeFile(
        qaReportPath,
        JSON.stringify({ technical_check: technicalIssues, ...(qa as Record<string, unknown>) }, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn(`[series] (${jobId}) QA series lỗi (bỏ qua):`, err instanceof Error ? err.message : err);
    }
  }

  return { episodeFiles, failedEpisode, qaReportPath, seriesDir };
}
