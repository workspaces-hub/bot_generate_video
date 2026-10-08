/**
 * Stage 5 — GLOBAL STORY RECONSTRUCTION: từ Story Memory (text, không cần
 * video) dựng scene → dramatic beat → nhân quả → setup/payoff → đường cảm
 * xúc/twist/power shift cho 1 ĐỢT clip. Đợt sau nhận structure đợt trước làm
 * ngữ cảnh chỉ đọc; setup/payoff được nối ngược về event đợt cũ.
 *
 * Mọi tham chiếu là eventId/segId đã có — validateStructure kiểm tồn tại và
 * thứ tự thời gian (nguyên nhân/setup không được đứng sau kết quả/payoff).
 */
import path from "node:path";
import { config } from "../config";
import { jsonSection, readJson, runFilmStage } from "./llm";
import type { GlobalTimeline, SourceBatch, StoryMemory, StoryStructure } from "./types";

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** Tên theo SỐ TẬP GỐC của đợt: "tap2" (1 tập) / "tap2-5". */
export function episodeRangeLabel(sb: Pick<SourceBatch, "firstEpisode" | "lastEpisode">): string {
  return sb.firstEpisode === sb.lastEpisode ? `tap${sb.firstEpisode}` : `tap${sb.firstEpisode}-${sb.lastEpisode}`;
}

/** storage/films/<phim>/structure_tap2-5.json — theo số tập gốc của đợt. */
export function structurePath(filmDir: string, sb: Pick<SourceBatch, "firstEpisode" | "lastEpisode">): string {
  return path.join(filmDir, `structure_${episodeRangeLabel(sb)}.json`);
}

/** Structure của các đợt (theo thứ tự phim). */
export async function loadStructures(filmDir: string, batches: SourceBatch[]): Promise<StoryStructure[]> {
  const out: StoryStructure[] = [];
  for (const sb of batches) {
    const s = await readJson<StoryStructure>(structurePath(filmDir, sb));
    if (s) out.push(s);
  }
  return out;
}

function normalizeStructure(raw: unknown, batch: number): StoryStructure {
  const s = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<StoryStructure>;
  return {
    batch: typeof s.batch === "number" ? s.batch : batch,
    scenes: arr(s.scenes).map((sc) => ({ ...sc, seg_ids: arr(sc.seg_ids), beats: arr(sc.beats).map((b) => ({ ...b, event_ids: arr(b.event_ids) })) })),
    cause_effect: arr(s.cause_effect),
    setup_payoff: arr(s.setup_payoff).map((sp) => ({ ...sp, setup_events: arr(sp.setup_events), payoff_events: arr(sp.payoff_events) })),
    emotion_curve: arr(s.emotion_curve),
    twists: arr(s.twists),
    power_shifts: arr(s.power_shifts),
    arcs: arr(s.arcs),
  };
}

export function validateStructure(s: StoryStructure, mem: StoryMemory, tl: GlobalTimeline, batch: number): string[] {
  const errors: string[] = [];
  const batchClips = new Set(tl.batches.find((b) => b.batch === batch)?.clipIds ?? []);
  const segIndex = new Map(tl.segments.map((seg, i) => [seg.segId, i]));
  const segClip = new Map(tl.segments.map((seg) => [seg.segId, seg.clipId]));
  const events = new Map(mem.events.map((e) => [e.id, e]));
  // Hạng thời gian của event = vị trí segment đầu tiên của nó.
  const rank = (id: string) => Math.min(...(events.get(id)?.seg_ids ?? []).map((sid) => segIndex.get(sid) ?? Infinity));
  const inBatch = (id: string) => batchClips.has(events.get(id)?.clip_id ?? "");
  const needEvent = (id: string, where: string) => {
    if (!events.has(id)) errors.push(`${where}: event "${id}" không tồn tại`);
  };

  if (s.batch !== batch) errors.push(`batch ${s.batch} ≠ ${batch}`);

  // Scene phủ mọi segment "story" của đợt, không segment nào thuộc 2 scene.
  const storySegs = new Set(
    mem.clips.filter((c) => batchClips.has(c.clip_id)).flatMap((c) => c.segments.filter((seg) => seg.kind === "story").map((seg) => seg.id)),
  );
  const owner = new Map<string, string>();
  for (const sc of s.scenes) {
    if (!batchClips.has(sc.clip_id)) errors.push(`scene ${sc.id}: clip_id "${sc.clip_id}" không thuộc đợt ${batch}`);
    if (sc.seg_ids.length === 0) errors.push(`scene ${sc.id}: seg_ids trống`);
    for (const sid of sc.seg_ids) {
      if (segClip.get(sid) !== sc.clip_id) errors.push(`scene ${sc.id}: segId "${sid}" không thuộc ${sc.clip_id}`);
      if (owner.has(sid)) errors.push(`segId "${sid}" nằm trong 2 scene (${owner.get(sid)}, ${sc.id})`);
      owner.set(sid, sc.id);
    }
    if (sc.beats.length === 0) errors.push(`scene ${sc.id}: không có beat`);
    for (const b of sc.beats) {
      b.event_ids.forEach((e) => {
        needEvent(e, `scene ${sc.id} beat ${b.id}`);
        if (events.has(e) && events.get(e)!.clip_id !== sc.clip_id) errors.push(`beat ${b.id}: event "${e}" không thuộc ${sc.clip_id}`);
      });
      if (!(b.intensity >= 1 && b.intensity <= 10)) errors.push(`beat ${b.id}: intensity phải 1–10`);
    }
  }
  const uncovered = [...storySegs].filter((sid) => !owner.has(sid));
  if (uncovered.length > 0) errors.push(`${uncovered.length} segment "story" chưa thuộc scene nào: ${uncovered.slice(0, 15).join(", ")}`);

  for (const ce of s.cause_effect) {
    needEvent(ce.cause, "cause_effect");
    needEvent(ce.effect, "cause_effect");
    if (events.has(ce.cause) && events.has(ce.effect)) {
      if (rank(ce.cause) > rank(ce.effect)) errors.push(`cause_effect ${ce.cause}→${ce.effect}: nguyên nhân đứng SAU kết quả`);
      if (!inBatch(ce.cause) && !inBatch(ce.effect)) errors.push(`cause_effect ${ce.cause}→${ce.effect}: không event nào thuộc đợt ${batch}`);
    }
  }
  const threads = new Set(mem.threads.map((t) => t.id));
  for (const sp of s.setup_payoff) {
    if (sp.thread_id && !threads.has(sp.thread_id)) errors.push(`setup_payoff: thread "${sp.thread_id}" không tồn tại`);
    if (sp.setup_events.length === 0) errors.push(`setup_payoff (${sp.note?.slice(0, 40)}): setup_events trống`);
    [...sp.setup_events, ...sp.payoff_events].forEach((e) => needEvent(e, "setup_payoff"));
    const payoffRanks = sp.payoff_events.filter((e) => events.has(e)).map(rank);
    if (payoffRanks.length > 0 && sp.setup_events.some((e) => events.has(e) && rank(e) >= Math.min(...payoffRanks))) {
      errors.push(`setup_payoff (${sp.thread_id ?? sp.note?.slice(0, 40)}): setup đứng sau payoff`);
    }
    if (![...sp.setup_events, ...sp.payoff_events].some(inBatch)) errors.push(`setup_payoff (${sp.thread_id ?? sp.note?.slice(0, 40)}): không event nào thuộc đợt ${batch}`);
  }
  const curveClips = new Set(s.emotion_curve.map((c) => c.clip_id));
  for (const c of batchClips) if (!curveClips.has(c)) errors.push(`emotion_curve thiếu clip ${c}`);
  const reinterps = new Set(mem.reinterpretations.map((r) => r.id));
  for (const t of s.twists) {
    needEvent(t.event_id, "twists");
    if (events.has(t.event_id) && !inBatch(t.event_id)) errors.push(`twists: event "${t.event_id}" không thuộc đợt ${batch}`);
    if (t.reinterpretation_id && !reinterps.has(t.reinterpretation_id)) errors.push(`twists: reinterpretation "${t.reinterpretation_id}" không tồn tại`);
  }
  for (const p of s.power_shifts) needEvent(p.event_id, "power_shifts");
  const chars = new Set(mem.characters.map((c) => c.id));
  for (const a of s.arcs) if (!chars.has(a.char_id)) errors.push(`arcs: nhân vật "${a.char_id}" không tồn tại`);
  return errors;
}

/** Tóm tắt structure đợt cũ gửi làm ngữ cảnh chỉ đọc. */
function summarizeStructure(s: StoryStructure): unknown {
  return {
    batch: s.batch,
    scenes: s.scenes.map((sc) => ({ id: sc.id, clip_id: sc.clip_id, summary: sc.summary })),
    setup_payoff: s.setup_payoff,
    twists: s.twists,
    power_shifts: s.power_shifts,
    emotion_curve: s.emotion_curve,
    arcs: s.arcs,
  };
}

export async function reconstructBatch(opts: {
  jobId: string;
  filmDir: string;
  memory: StoryMemory;
  tl: GlobalTimeline;
  /** Đợt cần dựng structure. */
  sourceBatch: SourceBatch;
  /** Các đợt đứng trước trong phim (structure của chúng là ngữ cảnh chỉ đọc). */
  previousBatches: SourceBatch[];
  onStatus?: (text: string) => Promise<void>;
}): Promise<StoryStructure> {
  const { memory, tl, sourceBatch } = opts;
  const batch = sourceBatch.batch;
  const range = episodeRangeLabel(sourceBatch);
  const batchClips = new Set(tl.batches.find((b) => b.batch === batch)?.clipIds ?? []);
  const previous = await loadStructures(opts.filmDir, opts.previousBatches);
  const context = [
    `## PHẠM VI\nDựng structure cho ĐỢT ${batch} (tập gốc ${range.replace("tap", "")}): clip ${[...batchClips].join(", ")}. Ghi "batch": ${batch}.`,
    previous.length > 0
      ? jsonSection("STRUCTURE CÁC ĐỢT TRƯỚC (CHỈ ĐỌC — không dựng lại; setup/payoff mới được trỏ về event cũ)", previous.map(summarizeStructure))
      : "",
    jsonSection("CLIP CỦA ĐỢT NÀY (tóm tắt + mô tả từng segment)", memory.clips.filter((c) => batchClips.has(c.clip_id))),
    jsonSection("EVENT LEDGER TOÀN PHIM", memory.events.map((e) => ({ id: e.id, clip: e.clip_id, seg_ids: e.seg_ids, type: e.type, actors: e.actors, summary: e.summary, caused_by: e.caused_by }))),
    jsonSection("NHÂN VẬT", memory.characters),
    jsonSection("KNOWLEDGE (ai biết gì, từ event nào)", memory.knowledge),
    jsonSection("STORY THREADS", memory.threads),
    jsonSection("REINTERPRETATIONS (twist đổi nghĩa event cũ)", memory.reinterpretations),
  ].join("");
  return runFilmStage({
    jobId: opts.jobId,
    name: `structure_${range}`,
    label: `[5/7] Dựng cấu trúc truyện (scene/beat/nhân quả/setup-payoff) tập gốc ${range.replace("tap", "")}`,
    promptPath: config.promptFilmReconstruct,
    context,
    outPath: structurePath(opts.filmDir, sourceBatch),
    parse: (raw) => normalizeStructure(raw, batch),
    validate: (s) => validateStructure(s, memory, tl, batch),
    onStatus: opts.onStatus,
  });
}
