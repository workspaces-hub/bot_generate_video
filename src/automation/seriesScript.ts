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
import { getPromptSection, lockContinuousFrames } from "./frameLock";

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
  /**
   * "Remake phim" (src/film/pipeline.ts): nội dung tập gốc dựng sẵn từ Story
   * Memory, cùng thứ tự/độ dài với referenceFileNames — thay cho đọc file
   * trong chatAIResultsDir.
   */
  sourceEpisodes?: string[];
  /**
   * "Remake phim": mạch truyện toàn phim. overview → Bible/Arc/QA;
   * episode(tap) → DNA + tạo tập (setup cần gieo, payoff cần trả, twist,
   * ai biết gì) kèm luật rules.
   */
  globalContext?: {
    overview: string;
    episode: (tap: number) => string;
    rules: string;
  };
  /** "Remake phim": tên phim (storage/films/<filmId>) — lưu vào series_meta.json. */
  filmId?: string;
  /**
   * "Remake phim": số tập của từng tham chiếu = SỐ TẬP GỐC (tập gốc 2 → tập
   * remake 2, dna_tap2...), có thể không liền nhau (2, 3, 6). Mặc định
   * startEpisode, startEpisode+1...
   */
  episodeNumbers?: number[];
  /**
   * Tập remake ngay trước đợt này (nối end state/ledger) — 0 = series mới
   * (đợt đầu: tạo Bible). Mặc định startEpisode - 1.
   */
  previousEpisode?: number;
  /** "Remake phim": bỏ bước QA cuối đợt — viết xong tập là trả JSON ngay. */
  skipQa?: boolean;
  /**
   * "Remake phim": kiểm tra thêm JSON từng tập (vd tổng thời lượng so với tập
   * gốc). Có lỗi → lần thử sau gửi kèm lỗi để Gemini sửa; hết lượt vẫn dùng
   * bản cuối (cảnh báo trong log).
   */
  checkEpisode?: (tap: number, value: unknown) => string[];
  /**
   * "Remake phim" chế độ giống gốc: thay master prompt Bible / Bible mở rộng /
   * tạo tập và quy tắc series (mặc định là bộ prompt đổi thế giới).
   */
  prompts?: { bible?: string; bibleExtend?: string; episode?: string };
  episodeRules?: string;
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
  /** Series tạo từ "Remake phim" — tạo tiếp qua nút đó, không qua "Tiếp tục tạo kịch bản". */
  filmId?: string;
}

const STAGE_ATTEMPTS = 2;
/** Tạo tập: thêm 1 lần thử vì có kiểm tra ref tới asset (repairAssetRefs). */
const EPISODE_ATTEMPTS = 3;

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
/** Ký tự có dấu tiếng Việt (chữ Latin thường không có các dấu này). */
const VIETNAMESE_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
/**
 * Token tiếng Việt (không dấu) hay gặp trong id kiểu nhãn vai trò
 * (CHAR_NAM_CHINH, CHAR_SEP_PHAN_DIEN...) — id nhân vật phải lấy từ TÊN riêng.
 */
const VIETNAMESE_ID_TOKENS = new Set([
  "NAM", "NU", "CHINH", "PHAN", "DIEN", "SEP", "CAP", "DUOI", "NHAN", "TINH", "ME", "CHONG", "CON", "DAU",
  "VO", "CHA", "BA", "ONG", "CO", "CHU", "ANH", "CHI", "EM", "TRO", "LY", "THU", "KY", "GIAM", "DOC",
  "BAN", "THAN", "TIEU", "THIEU", "GIA", "NGUOI", "YEU", "PHU", "BE", "GAI", "TRAI", "CU", "LAO", "HAU",
  "GAN", "THANG", "DUA", "NHA", "HO", "MOI", "VUA", "QUAN", "TUONG", "THAY", "TRUONG", "DAI", "TRE",
]);

/** Từ có dấu tiếng Việt trong 1 đoạn chữ (tối đa `limit` từ, không lặp). */
function vietnameseWords(text: string, limit = 8): string[] {
  const words = text.match(/[\p{L}]+/gu) ?? [];
  return [...new Set(words.filter((w) => VIETNAMESE_CHARS.test(w)))].slice(0, limit);
}

/**
 * Tên/id nhân vật trong Bible (hoặc Bible mở rộng) không được là tiếng Việt —
 * xác nhận qua lỗi thật (test-prompt_remake_1): CHAR_NAM_CHINH "Lâm Việt",
 * CHAR_SEP_PHAN_DIEN "Ông Hoàng"... rồi tên tiếng Việt lọt vào thoại tiếng Anh.
 */
export function vietnameseIdentityIssues(bible: unknown): string[] {
  if (!isRecord(bible)) return [];
  const issues: string[] = [];
  for (const c of Array.isArray(bible.characters) ? bible.characters : []) {
    if (!isRecord(c)) continue;
    const id = String(c.id ?? "");
    const name = String(c.name ?? "");
    if (VIETNAMESE_CHARS.test(name)) issues.push(`Nhân vật ${id}: tên "${name}" là tiếng Việt — dùng tên riêng KHÔNG phải tiếng Việt, không dấu, hợp văn hoá thế giới phim mới.`);
    const tokens = id.replace(/^CHAR_/, "").split("_").filter(Boolean);
    const vnTokens = tokens.filter((t) => VIETNAMESE_ID_TOKENS.has(t));
    if (tokens.length > 0 && vnTokens.length > tokens.length / 2) {
      issues.push(`Nhân vật ${id}: id là nhãn vai trò tiếng Việt (${vnTokens.join(", ")}) — id phải lấy từ TÊN riêng của nhân vật, vd CHAR_ELENA, CHAR_MARCUS_HALE.`);
    }
  }
  return issues;
}

/** Từ tiếng Việt trong prompt VIDEO/asset của 1 tập (prompt + thoại phải là tiếng Anh). */
function vietnameseTextIssues(episode: unknown): string[] {
  const issues: string[] = [];
  for (const entry of Array.isArray(episode) ? episode : []) {
    if (!isRecord(entry) || typeof entry.prompt !== "string") continue;
    const words = vietnameseWords(entry.prompt);
    if (words.length > 0) {
      issues.push(`${String(entry.id)}: có chữ tiếng Việt (${words.join(", ")}) — prompt, lời thoại và TÊN nhân vật phải bằng tiếng Anh/tên không phải tiếng Việt, đúng tên trong Series Bible.`);
    }
  }
  return issues;
}

/** Nhóm tư thế đọc từ mô tả khung hình (tiếng Anh). */
const POSTURES: [string, RegExp][] = [
  ["nằm", /\b(lying|lies|lay|laid|sprawled|collapsed on|reclin\w*|on (?:her|his|their) back|face[- ]down)\b/i],
  ["ngồi", /\b(sitting|sits|seated|sat)\b/i],
  ["quỳ", /\b(kneeling|kneels|knelt|on (?:her|his|their) knees)\b/i],
  ["đứng", /\b(standing|stands|stood|upright|on (?:her|his|their) feet)\b/i],
];

function postureSet(text: string): Set<string> {
  return new Set(POSTURES.filter(([, re]) => re.test(text)).map(([name]) => name));
}

/**
 * Liền mạch tư thế giữa 2 VIDEO kề nhau (cùng shot, hoặc cùng bối cảnh + nhân
 * vật): END FRAME clip trước và START FRAME clip sau không được đổi tư thế —
 * xác nhận qua lỗi thật (iop_remake_1_tap11): cuối clip trước nhân vật nằm,
 * đầu clip sau lại đứng.
 */
export function continuityIssues(episode: unknown): string[] {
  const videos = (Array.isArray(episode) ? episode : []).filter(
    (e): e is Record<string, unknown> => isRecord(e) && e.type === "VIDEO" && typeof e.prompt === "string",
  );
  const refIds = (v: Record<string, unknown>, type: string) =>
    new Set((Array.isArray(v.ref) ? v.ref : []).filter((r) => isRecord(r) && r.type === type).map((r) => String((r as Record<string, unknown>).id)));
  const issues: string[] = [];
  for (let i = 1; i < videos.length; i++) {
    const [a, b] = [videos[i - 1], videos[i]];
    const sameShot = Number(a.shot) === Number(b.shot);
    const locA = refIds(a, "LOCATION");
    const sameScene =
      [...refIds(b, "LOCATION")].some((id) => locA.has(id)) &&
      [...refIds(b, "CHARACTER")].some((id) => refIds(a, "CHARACTER").has(id));
    if (!sameShot && !sameScene) continue;
    const end = postureSet(getPromptSection(String(a.prompt), "END FRAME") ?? "");
    const start = postureSet(getPromptSection(String(b.prompt), "START FRAME") ?? "");
    if (end.size === 0 || start.size === 0 || [...end].some((p) => start.has(p))) continue;
    issues.push(
      `${String(a.id)} → ${String(b.id)}: END FRAME nhân vật đang ${[...end].join("/")} nhưng START FRAME clip sau lại ${[...start].join("/")} — clip sau phải bắt đầu ĐÚNG tư thế/vị trí cuối clip trước (chép nguyên END FRAME sang START FRAME), muốn đổi tư thế thì cho nhân vật đổi trong ACTION.`,
    );
  }
  return issues;
}

async function runJsonStage(opts: {
  jobId: string;
  name: string;
  label: string;
  promptPath: string;
  input: string;
  outPath: string;
  protectedNames: Set<string>;
  validate?: (value: unknown) => string | null;
  /** Số lần thử (mặc định STAGE_ATTEMPTS). */
  attempts?: number;
  onStatus?: (text: string) => Promise<void>;
}): Promise<unknown> {
  const attempts = opts.attempts ?? STAGE_ATTEMPTS;
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
    for (let attempt = 1; attempt <= attempts; attempt++) {
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
        if (invalid) {
          // Lần thử sau: gửi kèm đúng lỗi kiểm tra để Gemini sửa (không làm lại mù).
          await fsp.writeFile(
            attachmentPath,
            `${opts.input}\n\n## LỖI CỦA LẦN TRƯỚC — BẮT BUỘC SỬA (code đã kiểm tra và từ chối)\n${invalid}\nTạo lại TOÀN BỘ kết quả, sửa đúng các lỗi trên.`,
            "utf-8",
          );
          throw new Error(invalid);
        }
        await fsp.mkdir(path.dirname(opts.outPath), { recursive: true });
        await fsp.writeFile(opts.outPath, JSON.stringify(value, null, 2), "utf-8");
        console.log(`[series] (${opts.jobId}) ${opts.label}: xong → ${opts.outPath}`);
        return value;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[series] (${opts.jobId}) ${opts.label} lỗi (lần ${attempt}/${attempts}): ${lastError}`);
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
  throw new Error(`${opts.label} thất bại sau ${attempts} lần thử: ${lastError}`);
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

/** Season Arc của 1 đợt — tìm theo số "episode", không có thì theo vị trí (index) trong đợt. */
function arcEntry(arc: unknown, episode: number, index: number): unknown {
  const list = arcEpisodes(arc);
  return (
    list.find((e) => isRecord(e) && Number(e.episode) === episode) ??
    list[index] ??
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

function scopeHeader(taps: number[]): string {
  const start = taps[0];
  const end = taps[taps.length - 1];
  const contiguous = end - start + 1 === taps.length;
  const range = contiguous ? `tập ${start}–${end}` : `các tập ${taps.join(", ")}`;
  const numbering = contiguous ? `(${start}, ${start + 1}, ...)` : `(${taps.join(", ")} — đúng số tập gốc, không đánh lại liên tục)`;
  return `## PHẠM VI ĐỢT NÀY\nTạo ${range} (${taps.length} tập). Đánh số "episode" đúng theo phạm vi này ${numbering}. Tổng số tập của cả series chưa xác định — series có thể được tạo tiếp: tập ${end} trả thưởng một phần nhưng vẫn kết bằng cliffhanger, không đóng hết bí mật/conflict dài hạn.`;
}

/**
 * VIDEO.ref phải trỏ tới asset khai báo trong CHÍNH file tập (xác nhận qua lỗi
 * thật, aladinhusband_remake_1 tập 1: S0044–S0046 ref LOC_EXT_CITY /
 * LOC_EXT_BUILDING nhưng file không khai báo). Ref tới asset đã có ở tập trước
 * (sổ asset) → tự chép asset đó vào file; còn lại → trả về để bắt tạo lại.
 */
function repairAssetRefs(
  value: unknown,
  assetLedger: Map<string, unknown>,
): { value: unknown; autoAdded: string[]; missing: { id: string; videos: string[] }[] } {
  if (!Array.isArray(value)) return { value, autoAdded: [], missing: [] };
  const declared = new Set(
    value.filter((e) => isRecord(e) && e.type !== "VIDEO").map((e) => String((e as Record<string, unknown>).id)),
  );
  const usedBy = new Map<string, string[]>();
  for (const v of videoEntries(value)) {
    for (const r of Array.isArray(v.ref) ? v.ref : []) {
      if (!isRecord(r) || typeof r.id !== "string" || declared.has(r.id)) continue;
      usedBy.set(r.id, [...(usedBy.get(r.id) ?? []), String(v.id)]);
    }
  }
  const autoAdded: string[] = [];
  const missing: { id: string; videos: string[] }[] = [];
  const toInsert: unknown[] = [];
  for (const [id, videos] of usedBy) {
    const known = assetLedger.get(id);
    if (known) {
      toInsert.push(known);
      autoAdded.push(id);
    } else {
      missing.push({ id, videos });
    }
  }
  if (toInsert.length === 0) return { value, autoAdded, missing };
  // Chèn asset trước VIDEO đầu tiên (asset trước, VIDEO sau — đúng schema).
  const firstVideo = value.findIndex((e) => isRecord(e) && e.type === "VIDEO");
  const at = firstVideo < 0 ? value.length : firstVideo;
  return { value: [...value.slice(0, at), ...toInsert, ...value.slice(at)], autoAdded, missing };
}

/**
 * Asset chuẩn từ Bible: core_locations → LOCATION, core_props (PROP_/OBJ_) →
 * type CHARACTER (quy ước loader của master prompt). Chỉ lấy mục có
 * asset_prompt tiếng Anh (mô tả tiếng Việt không dùng được làm prompt gen ảnh).
 */
function bibleSceneAssets(bible: unknown): unknown[] {
  if (!isRecord(bible)) return [];
  const vietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const out: unknown[] = [];
  const take = (list: unknown, type: "LOCATION" | "CHARACTER", pattern: RegExp) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!isRecord(item) || typeof item.id !== "string" || !pattern.test(item.id)) continue;
      const prompt = typeof item.asset_prompt === "string" ? item.asset_prompt.trim() : "";
      if (!prompt || vietnamese.test(prompt)) continue;
      out.push({ id: item.id, type, ref: [], prompt, duration: 0 });
    }
  };
  take(bible.core_locations, "LOCATION", /^LOC_/);
  take(bible.core_props, "CHARACTER", /^(PROP|OBJ)_/);
  return out;
}

function missingRefFeedback(missing: { id: string; videos: string[] }[]): string {
  return `\n\n## LỖI CỦA LẦN TẠO TRƯỚC — BẮT BUỘC SỬA
JSON lần trước có VIDEO.ref trỏ tới asset KHÔNG được khai báo trong file (dangling ref):
${missing.map((m) => `- ${m.id} (dùng ở ${m.videos.join(", ")})`).join("\n")}
Tạo lại TOÀN BỘ tập: mọi id xuất hiện trong VIDEO.ref PHẢI có asset tương ứng khai báo trong chính file (id, type CHARACTER|LOCATION khớp ref.type, "ref": [], prompt tiếng Anh tự chứa, "duration": 0). Đạo cụ/vật thể/bối cảnh có vai trò trong cảnh (vd bảng tên, toà nhà, toàn cảnh thành phố) phải là asset riêng + có trong ref, không chỉ mô tả bằng chữ.`;
}

const SERIES_EPISODE_RULES = `## QUY TẮC SERIES (áp dụng cho tập này, ưu tiên CAO HƠN các mục mâu thuẫn bên trên)
Tập này là MỘT TẬP trong một series liền mạch. Đầu vào gồm: TARGET SERIES BIBLE (khóa nhân vật, tính cách, mục tiêu, quan hệ, thế giới, bí mật, conflict dài hạn, id asset), SEASON ARC của tập này, END STATE tập trước (Continuity Ledger), DRAMATIC DNA của TẬP GỐC hiện tại, và JSON TẬP GỐC (nguồn beat/DNA chi tiết của tập hiện tại).

THỨ TỰ ƯU TIÊN KHI MÂU THUẪN: Continuity (END STATE tập trước) > Season Arc tập này > Dramatic DNA tập gốc > chi tiết cốt truyện mới.

TẬP NÀY BẮT BUỘC CÓ 3 PHẦN:
1. CARRY-IN: các VIDEO đầu tiếp nhận trực tiếp trạng thái cuối tập trước (vị trí, thương tích, trang phục, ai biết gì, quan hệ, đạo cụ, cảm xúc, cliffhanger). Tập 1: thiết lập theo Season Arc.
2. DNA DRAMA: thân tập tái tạo Dramatic DNA của tập gốc (emotional curve, escalation, power shift, reveal/reversal, climax, pacing, cường độ phản ứng) bằng nhân vật/thế giới của Series Bible.
3. CARRY-OUT: kết tập bằng cliffhanger theo Season Arc ("carry_out_cliffhanger"), dẫn thẳng vào tập sau.

- Dùng ĐÚNG id + mô tả nhận dạng trong Series Bible / sổ asset; KHÔNG dùng lại danh tính, tên, thế giới của tập gốc.
- NGÔN NGỮ ĐẦU RA: Series Bible/Season Arc/DNA/Ledger bên dưới có thể bằng tiếng Việt — đó chỉ là dữ liệu. Mọi asset.prompt và VIDEO.prompt trong JSON xuất ra PHẢI hoàn toàn bằng tiếng Anh (dịch, không chép nguyên văn), tên riêng không dấu (xem OUTPUT LANGUAGE LOCK của master prompt).
- ĐẠO CỤ/VẬT THỂ/BỐI CẢNH THỐNG NHẤT TOÀN PHIM: bối cảnh, đạo cụ, vật thể đã có trong Series Bible (core_locations/core_props) hoặc ASSET LEDGER TOÀN PHIM thì dùng ĐÚNG id đó và mô tả đó mỗi khi chúng xuất hiện — không tạo id mới cho cùng một vật, không đổi mô tả. Vật mới chưa có thì tạo asset PROP_/OBJ_/LOC_ mới (prompt tiếng Anh).
- ASSET TỰ CHỨA: mọi id trong VIDEO.ref PHẢI có asset khai báo trong chính file JSON của tập (kể cả bối cảnh ngoại cảnh/toàn cảnh, toà nhà, đạo cụ nhỏ như bảng tên). Đạo cụ/vật thể/bối cảnh có id riêng trong tập gốc và có mặt trong beat tương ứng → tạo asset riêng + đưa vào ref, không chỉ tả bằng chữ trong prompt. Bot kiểm tra bằng code và bắt tạo lại nếu có ref trỏ tới asset không tồn tại.
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
  const taps = opts.episodeNumbers ?? referenceFileNames.map((_, i) => (opts.startEpisode ?? 1) + i);
  const start = taps[0];
  const end = taps[taps.length - 1];
  // Tập remake ngay trước đợt (nối mạch) — 0 = series mới.
  const prev = opts.previousEpisode ?? start - 1;
  const isFirstBatch = prev < 1;
  const seriesDir = seriesDirFor(remakeBaseName);
  const episodesDir = path.join(seriesDir, "episodes");
  await fsp.mkdir(episodesDir, { recursive: true });
  const protectedNames = new Set(referenceFileNames.map((n) => path.basename(n)));
  const episodePath = (tap: number) => path.join(episodesDir, `${remakeBaseName}_tap${tap}_full.json`);

  // Meta series — "Tiếp tục tạo kịch bản" đọc lại searchTerm.
  const meta: SeriesMeta = (await readSeriesMeta(remakeBaseName)) ?? { references: {} };
  if (opts.searchTerm) meta.searchTerm = opts.searchTerm;
  if (opts.filmId) meta.filmId = opts.filmId;
  referenceFileNames.forEach((name, i) => {
    meta.references[String(taps[i])] = name;
  });
  await fsp.writeFile(path.join(seriesDir, "series_meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  const scope = scopeHeader(taps);

  if (!isFirstBatch && !fs.existsSync(episodePath(prev))) {
    throw new Error(`Series "${remakeBaseName}" chưa có tập ${prev} — không tạo tiếp từ tập ${start} được.`);
  }

  const references: { tap: number; name: string; content: string; value: unknown }[] = [];
  for (const [i, name] of referenceFileNames.entries()) {
    const content =
      opts.sourceEpisodes?.[i] ??
      (await fsp.readFile(path.join(config.chatAIResultsDir, path.basename(name)), "utf-8"));
    let value: unknown = null;
    try {
      value = JSON.parse(content);
    } catch {
      // vẫn gửi nguyên văn cho Gemini
    }
    references.push({ tap: taps[i], name, content, value });
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
        input: `${jsonSection(`TẬP GỐC ${ref.tap}: ${ref.name}`, ref.content)}${opts.globalContext?.episode(ref.tap) ?? ""}`,
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

  const globalOverview = opts.globalContext?.overview ?? "";

  // End state trước đợt (chỉ khi tạo tiếp).
  let previousLedger: unknown = null;
  let previousEpisodeValue: unknown = null;
  if (!isFirstBatch) {
    previousLedger = await readJsonIfExists(path.join(seriesDir, `ledger_tap${prev}.json`));
    previousEpisodeValue = await readJsonIfExists(episodePath(prev));
  }
  const previousEndState = previousLedger
    ? jsonSection(`CONTINUITY LEDGER SAU TẬP ${prev} (end state trước đợt này)`, previousLedger)
    : previousEpisodeValue
      ? jsonSection(`VIDEO CUỐI TẬP ${prev} (end state trước đợt này)`, videoEntries(previousEpisodeValue).at(-1) ?? null)
      : "";

  // 2. Series Bible — đợt đầu tạo mới; đợt sau dùng lại + mở rộng (chỉ thêm).
  const biblePath = path.join(seriesDir, "series_bible.json");
  // Đợt đã có tập viết xong (chạy lại giữa chừng) → GIỮ Bible/Bible mở rộng đã
  // dùng, kể cả khi không còn qua kiểm tra mới (vd tên tiếng Việt) — tạo lại
  // sẽ làm các tập sau lệch tên/danh tính với các tập đã viết.
  const batchStarted = taps.some((t) => fs.existsSync(episodePath(t)));
  const keepExisting = async (file: string, label: string): Promise<unknown> => {
    const value = batchStarted ? await readJsonIfExists(file) : null;
    if (value === null) return null;
    const issues = vietnameseIdentityIssues(value);
    if (issues.length > 0) {
      console.warn(`[series] (${jobId}) ${label}: đợt đã có tập viết xong → giữ bản cũ dù còn lỗi:\n- ${issues.join("\n- ")}`);
    }
    return value;
  };
  let bible: unknown;
  if (isFirstBatch) {
    const base = (await keepExisting(biblePath, "Series Bible")) ?? await runJsonStage({
      jobId,
      name: "bible",
      label: `[2/5] Tạo Series Bible`,
      promptPath: opts.prompts?.bible ?? config.promptSeriesBible,
      input: `${scope}${dnaInput}${sourceAssets}${globalOverview}`,
      outPath: biblePath,
      protectedNames,
      validate: (v) => {
        if (!isRecord(v) || !Array.isArray(v.characters) || v.characters.length === 0) {
          return "Series Bible thiếu danh sách characters.";
        }
        const issues = vietnameseIdentityIssues(v);
        return issues.length > 0 ? `- ${issues.join("\n- ")}` : null;
      },
      attempts: 3,
      onStatus,
    });
    bible = mergeBible(base, await loadBibleExtensions(seriesDir, start));
  } else {
    const base = await readJsonIfExists(biblePath);
    if (!isRecord(base)) {
      throw new Error(`Series "${remakeBaseName}" không có series_bible.json — không tạo tiếp được.`);
    }
    const lockedBible = mergeBible(base, await loadBibleExtensions(seriesDir, prev));
    const extPath = path.join(seriesDir, `bible_ext_tap${start}.json`);
    if (!(await keepExisting(extPath, "Bible mở rộng"))) await runJsonStage({
      jobId,
      name: `bible_ext_tap${start}`,
      label: `[2/5] Mở rộng Series Bible cho tập ${start}–${end}`,
      promptPath: opts.prompts?.bibleExtend ?? config.promptSeriesBibleExtend,
      input: `${scope}${jsonSection("SERIES BIBLE ĐÃ KHÓA", lockedBible)}${previousEndState}${dnaInput}${sourceAssets}${globalOverview}`,
      outPath: path.join(seriesDir, `bible_ext_tap${start}.json`),
      protectedNames,
      validate: (v) => {
        if (!isRecord(v)) return "Bible mở rộng không phải JSON object.";
        const issues = vietnameseIdentityIssues(v);
        return issues.length > 0 ? `- ${issues.join("\n- ")}` : null;
      },
      attempts: 3,
      onStatus,
    });
    bible = mergeBible(base, await loadBibleExtensions(seriesDir, start));
  }

  // 3. Season Arc của đợt.
  const previousArcSummary: unknown[] = [];
  if (!isFirstBatch) {
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
  const batchCount = taps.length;
  const arc = await runJsonStage({
    jobId,
    name: isFirstBatch ? "arc" : `arc_tap${start}`,
    label: `[3/5] Tạo Season Arc tập ${start}–${end}`,
    promptPath: config.promptSeriesArc,
    input: [
      scope,
      jsonSection("SERIES BIBLE", bible),
      previousArcSummary.length > 0 ? jsonSection("SEASON ARC CÁC TẬP ĐÃ CÓ (tóm tắt)", previousArcSummary) : "",
      previousEndState,
      dnaInput,
      globalOverview,
    ].join(""),
    outPath: path.join(seriesDir, isFirstBatch ? "season_arc.json" : `season_arc_tap${start}.json`),
    protectedNames,
    validate: (v) => {
      const count = arcEpisodes(v).length;
      return count === batchCount ? null : `Season Arc có ${count} tập, cần đúng ${batchCount} (tập ${taps.join(", ")}).`;
    },
    onStatus,
  });

  // 4. Từng tập + Continuity Ledger.
  const masterPrompt = await fsp.readFile(opts.prompts?.episode ?? config.promptGenerateScriptEpisode, "utf-8");
  const durationRange = parseDurationRange(masterPrompt);
  const assetLedger = new Map<string, unknown>();
  // id lấy từ Bible (bản nháp) — tập đã viết khai báo asset cùng id thì bản
  // của tập thắng (mô tả đầy đủ hơn, đã dùng để gen ảnh).
  const bibleSeeded = new Set<string>();
  const addAssets = (episodeValue: unknown) => {
    for (const entry of Array.isArray(episodeValue) ? episodeValue : []) {
      if (!isRecord(entry) || entry.type === "VIDEO" || typeof entry.id !== "string") continue;
      if (!assetLedger.has(entry.id) || bibleSeeded.has(entry.id)) {
        assetLedger.set(entry.id, entry);
        bibleSeeded.delete(entry.id);
      }
    }
  };
  // Tạo tiếp: sổ asset dựng lại từ mọi tập đã có trước đợt.
  for (let tap = 1; tap < start; tap++) {
    addAssets(await readJsonIfExists(episodePath(tap)));
  }
  // Bối cảnh/đạo cụ/vật thể chuẩn của cả phim (Bible core_locations/core_props)
  // vào sổ asset ngay từ tập 1 — mọi tập dùng chung 1 id + mô tả, và ref
  // thiếu khai báo được tự bổ sung (xem repairAssetRefs).
  for (const asset of bibleSceneAssets(bible)) {
    const id = String((asset as Record<string, unknown>).id);
    if (assetLedger.has(id)) continue;
    assetLedger.set(id, asset);
    bibleSeeded.add(id);
  }
  if (bibleSeeded.size > 0) {
    console.log(`[series] (${jobId}) sổ asset: thêm ${bibleSeeded.size} bối cảnh/đạo cụ/vật thể từ Bible: ${[...bibleSeeded].join(", ")}`);
  }

  const ledgers: unknown[] = [];
  const episodeFiles: string[] = [];
  const episodeValues: unknown[] = [];
  const technicalIssues: { episode: number; issues: string[] }[] = [];
  let failedEpisode: number | undefined;

  for (const [index, ref] of references.entries()) {
    const tap = ref.tap;
    // Tập remake liền trước (số tập gốc có thể không liền nhau: 3 → 6).
    const prevTap = index === 0 ? prev : taps[index - 1];
    const targetName = `${remakeBaseName}_tap${tap}_full.json`;
    const checkpointPath = episodePath(tap);
    const resultPath = path.join(config.chatAIResultsDir, targetName);

    if (!fs.existsSync(checkpointPath)) {
      const nextTap = taps[index + 1];
      const nextArc = nextTap !== undefined ? arcEntry(arc, nextTap, index + 1) : null;
      const sections = [
        masterPrompt,
        `\n\n## VỊ TRÍ TRONG BỘ PHIM\nĐây là TẬP ${tap} của bộ phim mới.`,
        `\n\n${opts.episodeRules ?? SERIES_EPISODE_RULES}`,
        jsonSection("TARGET SERIES BIBLE (đã khóa)", bible),
        jsonSection(`SEASON ARC — TẬP ${tap}`, arcEntry(arc, tap, index)),
      ];
      if (isRecord(nextArc)) {
        sections.push(
          jsonSection(`SEASON ARC — TẬP ${nextTap} (chỉ để carry-out dẫn đúng vào tập sau)`, {
            episode: nextTap,
            role_in_season: nextArc.role_in_season,
            carry_in: nextArc.carry_in,
          }),
        );
      }
      if (previousLedger) {
        sections.push(jsonSection(`END STATE TẬP ${prevTap} (CONTINUITY LEDGER — ưu tiên cao nhất)`, previousLedger));
      } else if (previousEpisodeValue) {
        // Ledger tập trước lỗi — dùng tạm VIDEO cuối tập trước làm end state.
        const last = videoEntries(previousEpisodeValue).at(-1);
        sections.push(jsonSection(`END STATE TẬP ${prevTap} (VIDEO cuối tập trước)`, last ?? null));
      }
      sections.push(jsonSection(`DRAMATIC DNA CỦA TẬP GỐC ${tap}`, dnas[index]));
      if (opts.globalContext) {
        sections.push(opts.globalContext.rules, opts.globalContext.episode(tap));
      }
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
      const baseInput = sections.join("");
      await fsp.writeFile(attachmentPath, baseInput, "utf-8");
      // Bản cuối có JSON hợp lệ nhưng còn dangling ref — hết lượt thì vẫn dùng (ghi vào QA).
      let fallbackContent: string | null = null;
      try {
        for (let attempt = 1; attempt <= EPISODE_ATTEMPTS && !fs.existsSync(checkpointPath); attempt++) {
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
            const repaired = repairAssetRefs(JSON.parse(content), assetLedger);
            // KHOÁ FRAME: clip liền mạch (cùng shot, clip kế tiếp) — START FRAME = đúng END FRAME clip trước.
            const locked = Array.isArray(repaired.value) ? lockContinuousFrames(repaired.value) : [];
            if (locked.length > 0) console.log(`[series] (${jobId}) tập ${tap}: khoá START FRAME = END FRAME clip trước cho ${locked.join(", ")}`);
            const repairedContent = JSON.stringify(repaired.value, null, 2);
            if (repaired.autoAdded.length > 0) {
              console.log(`[series] (${jobId}) tập ${tap}: tự bổ sung asset từ các tập trước: ${repaired.autoAdded.join(", ")}`);
            }
            const checkErrors = [
              ...vietnameseTextIssues(repaired.value),
              ...continuityIssues(repaired.value),
              ...(opts.checkEpisode?.(tap, repaired.value) ?? []),
            ];
            if (repaired.missing.length === 0 && checkErrors.length === 0) {
              await fsp.writeFile(checkpointPath, repairedContent, "utf-8");
            } else {
              fallbackContent = repairedContent;
              if (repaired.missing.length > 0) {
                const detail = repaired.missing.map((m) => `${m.id} (${m.videos.join(", ")})`).join("; ");
                console.warn(`[series] (${jobId}) tập ${tap}: ref tới asset không tồn tại (lần ${attempt}/${EPISODE_ATTEMPTS}): ${detail}`);
              }
              if (checkErrors.length > 0) {
                console.warn(`[series] (${jobId}) tập ${tap}: kiểm tra không đạt (lần ${attempt}/${EPISODE_ATTEMPTS}):\n- ${checkErrors.join("\n- ")}`);
              }
              // Lần thử sau: báo Gemini đúng lỗi của lần này.
              await fsp.writeFile(
                attachmentPath,
                `${baseInput}${repaired.missing.length > 0 ? missingRefFeedback(repaired.missing) : ""}${
                  checkErrors.length > 0
                    ? `\n\n## LỖI CỦA LẦN TẠO TRƯỚC — BẮT BUỘC SỬA (code đã kiểm tra)\n- ${checkErrors.join("\n- ")}\nTạo lại TOÀN BỘ tập, sửa đúng các lỗi trên.`
                    : ""
                }`,
                "utf-8",
              );
            }
          } catch (err) {
            console.error(
              `[series] (${jobId}) tập ${tap} lỗi (lần ${attempt}/${EPISODE_ATTEMPTS}):`,
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
      if (!fs.existsSync(checkpointPath) && fallbackContent) {
        console.warn(`[series] (${jobId}) tập ${tap}: hết ${EPISODE_ATTEMPTS} lần thử vẫn còn lỗi (ref asset/kiểm tra) — dùng bản cuối, ghi vào QA.`);
        await fsp.writeFile(checkpointPath, fallbackContent, "utf-8");
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
    // Tập dùng lại từ checkpoint cũng được bổ sung asset từ sổ asset nếu thiếu.
    const checked = repairAssetRefs(JSON.parse(await fsp.readFile(checkpointPath, "utf-8")), assetLedger);
    const content = JSON.stringify(checked.value, null, 2);
    if (checked.autoAdded.length > 0) await fsp.writeFile(checkpointPath, content, "utf-8");
    if (checked.missing.length > 0) {
      technicalIssues.push({
        episode: tap,
        issues: checked.missing.map((m) => `VIDEO.ref trỏ tới asset không khai báo: ${m.id} (${m.videos.join(", ")}).`),
      });
    }
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
          previousLedger ? jsonSection(`CONTINUITY LEDGER SAU TẬP ${prevTap}`, previousLedger) : "",
          jsonSection(`SEASON ARC — TẬP ${tap}`, arcEntry(arc, tap, index)),
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
  if (!opts.skipQa && failedEpisode === undefined && episodeValues.length > 0) {
    try {
      const qa = await runJsonStage({
        jobId,
        name: isFirstBatch ? "qa" : `qa_tap${start}`,
        label: `[5/5] QA series (tập ${taps.join(", ")})`,
        promptPath: config.promptSeriesQa,
        input: [
          scope,
          jsonSection("SERIES BIBLE", bible),
          jsonSection(`SEASON ARC TẬP ${start}–${end}`, arc),
          previousEndState,
          dnaInput,
          globalOverview,
          ...ledgers.map((l, i) => jsonSection(`CONTINUITY LEDGER SAU TẬP ${taps[i]}`, l)),
          ...episodeValues.map((v, i) => jsonSection(`TÓM TẮT TẬP MỚI ${taps[i]}`, summarizeEpisode(v))),
          jsonSection("KIỂM TRA KỸ THUẬT BẰNG CODE (aspectRatio 9:16, frameRate theo tập gốc, duration)", technicalIssues),
        ].join(""),
        outPath: path.join(seriesDir, isFirstBatch ? "qa_report.json" : `qa_report_tap${start}.json`),
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
