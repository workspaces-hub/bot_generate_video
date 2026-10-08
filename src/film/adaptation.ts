/**
 * ADAPTATION MAP — bảng ánh xạ phim gốc → bản remake (nhân vật, đạo cụ, mạch
 * truyện + tập remake đã gieo/trả). Cập nhật sau MỖI đợt tập remake, để đợt
 * sau ("làm thêm 4 tập") biết setup nào remake đã gieo, mạch nào đã bỏ.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { jsonSection, readJson, runFilmStage } from "./llm";
import type { EpisodeOf } from "./context";
import type { AdaptationMap, StoryMemory, StoryStructure } from "./types";

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** remakeDir = storage/films/<phim>/remakes/<bản remake>/ — mỗi bản 1 map riêng. */
export function adaptationMapPath(remakeDir: string): string {
  return path.join(remakeDir, "adaptation_map.json");
}

export function loadAdaptationMap(remakeDir: string): Promise<AdaptationMap | null> {
  return readJson<AdaptationMap>(adaptationMapPath(remakeDir));
}

function normalizeMap(raw: unknown, lastEpisode: number): AdaptationMap {
  const m = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<AdaptationMap>;
  return {
    updated_after_episode: typeof m.updated_after_episode === "number" ? m.updated_after_episode : lastEpisode,
    characters: arr(m.characters),
    props: arr(m.props),
    threads: arr(m.threads).map((t) => ({
      ...t,
      setup_episodes: arr(t.setup_episodes),
      payoff_episodes: arr(t.payoff_episodes),
      target_thread: t.target_thread ?? null,
    })),
  };
}

export function validateMap(m: AdaptationMap, mem: StoryMemory, lastEpisode: number, previous: AdaptationMap | null): string[] {
  const errors: string[] = [];
  if (m.updated_after_episode !== lastEpisode) errors.push(`updated_after_episode phải là ${lastEpisode}`);
  const chars = new Set(mem.characters.map((c) => c.id));
  for (const c of m.characters) if (!chars.has(c.source_id)) errors.push(`characters: source_id "${c.source_id}" không có trong phim gốc`);
  const props = new Set(mem.props.map((p) => p.id));
  for (const p of m.props) if (!props.has(p.source_id)) errors.push(`props: source_id "${p.source_id}" không có trong phim gốc`);
  const listed = new Map<string, number>();
  for (const t of m.threads) {
    listed.set(t.source_thread_id, (listed.get(t.source_thread_id) ?? 0) + 1);
    const eps = [...t.setup_episodes, ...t.payoff_episodes];
    if (eps.some((n) => !Number.isInteger(n) || n < 1 || n > lastEpisode)) errors.push(`threads ${t.source_thread_id}: số tập phải trong 1–${lastEpisode}`);
    if (t.status === "dropped" && t.target_thread !== null) errors.push(`threads ${t.source_thread_id}: dropped thì target_thread phải null`);
    if (t.status === "resolved" && t.payoff_episodes.length === 0) errors.push(`threads ${t.source_thread_id}: resolved nhưng không có payoff_episodes`);
  }
  for (const t of mem.threads) {
    const n = listed.get(t.id) ?? 0;
    if (n !== 1) errors.push(`threads: "${t.id}" phải xuất hiện đúng 1 lần (đang ${n})`);
  }
  for (const id of listed.keys()) if (!mem.threads.some((t) => t.id === id)) errors.push(`threads: "${id}" không có trong phim gốc`);
  // Tập remake đã viết là bất biến: tập đã ghi nhận gieo/trả ở bản trước không được biến mất.
  for (const old of previous?.threads ?? []) {
    const now = m.threads.find((t) => t.source_thread_id === old.source_thread_id);
    if (!now) continue;
    const lost = [...old.setup_episodes.filter((e) => !now.setup_episodes.includes(e)), ...old.payoff_episodes.filter((e) => !now.payoff_episodes.includes(e))];
    if (lost.length > 0) errors.push(`threads ${old.source_thread_id}: mất tập đã ghi nhận ${lost.join(", ")} (tập cũ không đổi được)`);
  }
  return errors;
}

export async function updateAdaptationMap(opts: {
  jobId: string;
  remakeDir: string;
  seriesDir: string;
  memory: StoryMemory;
  structures: StoryStructure[];
  firstEpisode: number;
  lastEpisode: number;
  episodeOf: EpisodeOf;
  onStatus?: (text: string) => Promise<void>;
}): Promise<AdaptationMap> {
  const previous = await loadAdaptationMap(opts.remakeDir);
  const bible = await readJson<unknown>(path.join(opts.seriesDir, "series_bible.json"));
  const extFiles = (await fsp.readdir(opts.seriesDir).catch(() => [] as string[])).filter((f) => /^bible_ext_tap\d+\.json$/.test(f));
  const bibleExts = await Promise.all(extFiles.map((f) => readJson<unknown>(path.join(opts.seriesDir, f))));
  const ledgers: unknown[] = [];
  // Số tập theo tập gốc, có thể không liền nhau (2, 3, 6) — bỏ qua số không có ledger.
  for (let tap = opts.firstEpisode; tap <= opts.lastEpisode; tap++) {
    const ledger = await readJson<unknown>(path.join(opts.seriesDir, `ledger_tap${tap}.json`));
    if (ledger !== null) ledgers.push({ episode: tap, ledger });
  }
  const eventClip = new Map(opts.memory.events.map((e) => [e.id, e.clip_id]));
  const sourceThreads = opts.memory.threads.map((t) => ({
    ...t,
    setup_source_episodes: [...new Set(t.setup_events.map((e) => opts.episodeOf(eventClip.get(e))))],
    payoff_source_episodes: [...new Set(t.payoff_events.map((e) => opts.episodeOf(eventClip.get(e))))],
  }));
  const context = [
    `## PHẠM VI\nCập nhật adaptation map sau khi bản remake đã viết xong tới TẬP ${opts.lastEpisode} (đợt này: tập ${opts.firstEpisode}–${opts.lastEpisode}). Ghi "updated_after_episode": ${opts.lastEpisode}.`,
    previous ? jsonSection("ADAPTATION MAP TRƯỚC (giữ nguyên tập đã ghi nhận — tập remake cũ KHÔNG đổi được)", previous) : "",
    jsonSection("NHÂN VẬT PHIM GỐC", opts.memory.characters.map((c) => ({ id: c.id, name: c.name, role: c.role, description: c.description }))),
    jsonSection("ĐẠO CỤ PHIM GỐC", opts.memory.props.map((p) => ({ id: p.id, type: p.type, description: p.description }))),
    jsonSection("MẠCH TRUYỆN PHIM GỐC (thread)", sourceThreads),
    jsonSection("SETUP/PAYOFF + TWIST PHIM GỐC", opts.structures.map((s) => ({ batch: s.batch, setup_payoff: s.setup_payoff, twists: s.twists }))),
    jsonSection("SERIES BIBLE REMAKE", bible),
    bibleExts.length > 0 ? jsonSection("BIBLE MỞ RỘNG", bibleExts) : "",
    jsonSection(`CONTINUITY LEDGER REMAKE TẬP ${opts.firstEpisode}–${opts.lastEpisode}`, ledgers),
  ].join("");
  return runFilmStage({
    jobId: opts.jobId,
    name: `adapt_map_${opts.lastEpisode}`,
    label: `[7/7] Cập nhật ánh xạ gốc → remake sau tập ${opts.lastEpisode}`,
    promptPath: config.promptFilmAdaptMap,
    context,
    // File riêng theo mốc tập (resume được), rồi copy thành adaptation_map.json hiện hành.
    outPath: path.join(opts.remakeDir, `adaptation_map_tap${opts.lastEpisode}.json`),
    parse: (raw) => normalizeMap(raw, opts.lastEpisode),
    validate: (m) => validateMap(m, opts.memory, opts.lastEpisode, previous),
    onStatus: opts.onStatus,
  });
}
