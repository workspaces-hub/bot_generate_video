/**
 * Cầu nối Story Memory/Structure → pipeline series (seriesScript.ts):
 * - buildSourceEpisode: "TẬP GỐC" của 1 clip ở dạng storyboard (asset +
 *   VIDEO theo segment) — đúng hình dạng các prompt series/episode đang đọc.
 * - buildGlobalOverview / buildEpisodeContext: mạch truyện TOÀN PHIM để
 *   Bible/Arc/từng tập biết setup nào phải gieo cho payoff ở tập sau, twist
 *   nào đổi nghĩa tập trước, ai biết gì tới đâu.
 * Mỗi clip nguồn = 1 tập (tập N ↔ clip thứ N của manifest).
 */
import type { AdaptationMap, ClipTranscript, GlobalTimeline, SourceClip, StoryMemory, StoryStructure } from "./types";
import { jsonSection } from "./llm";
import { getPromptSection } from "../automation/frameLock";

export type EpisodeOf = (clipId: string | undefined) => number | undefined;

/** clipId → SỐ TẬP GỐC (theo tên file) = số tập remake tương ứng. */
export function episodeMapper(manifest: SourceClip[]): EpisodeOf {
  const map = new Map(manifest.map((c, i) => [c.clipId, c.sourceEpisode ?? i + 1]));
  return (clipId) => (clipId ? map.get(clipId) : undefined);
}

/** fps nguồn làm tròn về số nguyên chuẩn (23.976 → 24, 29.97 → 30). */
function targetFrameRate(fps: number): number {
  const rounded = Math.round(fps);
  return rounded > 0 ? rounded : 24;
}

/**
 * Mốc có thoại trong TẬP GỐC (giây tính từ đầu tập, sau phần trim đầu): theo
 * Whisper (mốc thật từng câu) nếu có, không thì theo đầu segment có dialogue.
 */
export function speechTimeline(
  clip: SourceClip,
  tl: GlobalTimeline,
  memory: StoryMemory,
  transcript?: ClipTranscript | null,
): { segId: string; start: number; text: string }[] {
  const trim = tl.clips.find((c) => c.clipId === clip.clipId)?.trimHead ?? 0;
  const timed = (transcript?.lines ?? []).filter((l) => typeof l.start === "number");
  if (timed.length > 0) return timed.map((l) => ({ segId: l.segId, start: round1(Math.max(0, l.start! - trim)), text: l.text }));
  const segById = new Map(tl.segments.map((s) => [s.segId, s]));
  return (memory.clips.find((c) => c.clip_id === clip.clipId)?.segments ?? [])
    .filter((s) => s.kind === "story" && s.dialogue.length > 0)
    .map((s) => ({ segId: s.id, start: round1(Math.max(0, (segById.get(s.id)?.localStart ?? 0) - trim)), text: s.dialogue.map((d) => d.text).join(" ") }));
}

export function buildSourceEpisode(
  clip: SourceClip,
  tl: GlobalTimeline,
  memory: StoryMemory,
  transcript?: ClipTranscript | null,
): string {
  const trim = tl.clips.find((c) => c.clipId === clip.clipId)?.trimHead ?? 0;
  const speechBySeg = new Map<string, number>();
  for (const line of speechTimeline(clip, tl, memory, transcript)) {
    if (!speechBySeg.has(line.segId)) speechBySeg.set(line.segId, line.start);
  }
  const record = memory.clips.find((c) => c.clip_id === clip.clipId);
  if (!record) throw new Error(`Clip ${clip.clipId} chưa được phân tích.`);
  const segById = new Map(tl.segments.map((s) => [s.segId, s]));
  const used = new Set(record.segments.flatMap((s) => [...s.characters, ...(s.location ? [s.location] : [])]));
  const clipEvents = memory.events.filter((e) => e.clip_id === clip.clipId);
  clipEvents.forEach((e) => (e.props ?? []).forEach((p) => used.add(p)));

  const assets = [
    ...memory.characters.filter((c) => used.has(c.id)).map((c) => ({
      id: c.id,
      type: "CHARACTER",
      prompt: `${c.name}: ${c.description}`,
      // Danh mục trang phục — mỗi shot ghi rõ bộ đang mặc (WARDROBE).
      ...(c.outfits?.length ? { outfits: c.outfits } : {}),
    })),
    ...memory.locations.filter((l) => used.has(l.id)).map((l) => ({ id: l.id, type: "LOCATION", prompt: l.description })),
    ...memory.props.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, type: p.type, prompt: p.description })),
  ];
  const fps = targetFrameRate(clip.fps);
  const videos = record.segments.map((s) => {
    const seg = segById.get(s.id)!;
    const speech = s.dialogue.map((d) => `${d.speaker}: "${d.text}"`).join(" ");
    const wardrobe = Object.entries(s.wardrobe ?? {}).map(([charId, outfitId]) => {
      const outfit = memory.characters.find((c) => c.id === charId)?.outfits?.find((o) => o.id === outfitId);
      return `${charId} mặc ${outfitId}${outfit ? ` (${outfit.description})` : ""}`;
    });
    const events = clipEvents.filter((e) => e.seg_ids.includes(s.id)).map((e) => `${e.id} ${e.summary}`);
    return {
      id: s.id,
      type: "VIDEO",
      source_shot: true,
      segment_kind: s.kind,
      duration: Math.round((seg.localEnd - seg.localStart) * 10) / 10,
      frameRate: fps,
      // Vị trí shot trong tập gốc + lúc thoại bắt đầu — remake phải cho thoại vào ĐÚNG lúc này.
      episode_time_s: `${round1(seg.localStart - trim)}–${round1(seg.localEnd - trim)}`,
      ...(speechBySeg.has(s.id) ? { speech_starts_at_episode_s: speechBySeg.get(s.id) } : {}),
      prompt: [
        s.location ? `LOCATION: ${s.location}.` : "",
        s.characters.length ? `CHARACTERS: ${s.characters.join(", ")}.` : "",
        wardrobe.length ? `WARDROBE: ${wardrobe.join("; ")}.` : "",
        `ACTION: ${s.action}`,
        speech ? `SPEECH: ${speech}` : "",
        s.emotion ? `EMOTION: ${s.emotion}${s.intensity ? ` (cường độ ${s.intensity}/10)` : ""}.` : "",
        s.reaction ? `REACTION: ${s.reaction}.` : "",
        s.sound ? `SOUND: ${s.sound}.` : "",
        s.camera ? `CAMERA: ${s.camera}.` : "",
        events.length ? `STORY EVENTS: ${events.join(" | ")}` : "",
      ].filter(Boolean).join(" "),
    };
  });
  return JSON.stringify([...assets, ...videos], null, 2);
}

function threadView(memory: StoryMemory, episodeOf: EpisodeOf) {
  const eventClip = new Map(memory.events.map((e) => [e.id, e.clip_id]));
  const eps = (ids: string[]) => [...new Set(ids.map((id) => episodeOf(eventClip.get(id))).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
  return memory.threads.map((t) => ({
    id: t.id,
    question: t.question,
    status: t.status,
    setup_in_source_episodes: eps(t.setup_events),
    payoff_in_source_episodes: eps(t.payoff_events),
  }));
}

/** Toàn cảnh phim gốc (đã phân tích tới hiện tại) — cho Bible/Arc/QA. */
export function buildGlobalOverview(
  memory: StoryMemory,
  structures: StoryStructure[],
  adaptationMap: AdaptationMap | null,
  episodeOf: EpisodeOf,
): string {
  return [
    `\n\n## PHIM GỐC ĐÃ ĐƯỢC PHÂN TÍCH TOÀN CỤC (Global Story Memory)\nCác tập gốc KHÔNG rời rạc: chúng là MỘT phim. Dùng dữ liệu dưới đây để giữ đúng nhân vật xuyên tập, mạch truyện dài (setup ở tập trước → payoff ở tập sau), twist và ai biết gì. Tập gốc N = clip nguồn thứ N.`,
    jsonSection("TÓM TẮT TỪNG TẬP GỐC", memory.clips.map((c) => ({ episode: episodeOf(c.clip_id), summary: c.summary }))),
    jsonSection("NHÂN VẬT XUYÊN PHIM GỐC (cùng id = cùng một người ở mọi tập)", memory.characters.map((c) => ({
      id: c.id, name: c.name, role: c.role, description: c.description, goals: c.goals, relations: c.relations,
      first_episode: episodeOf(memory.clips.find((cl) => cl.segments.some((s) => s.id === c.first_seg))?.clip_id),
    }))),
    jsonSection("MẠCH TRUYỆN DÀI (thread) — tập gốc gieo/trả", threadView(memory, episodeOf)),
    jsonSection("TWIST / ĐỔI NGHĨA (reinterpretation)", memory.reinterpretations),
    jsonSection("ĐƯỜNG CẢM XÚC + TWIST + POWER SHIFT + ARC (theo đợt)", structures.map((s) => ({
      batch: s.batch,
      emotion_curve: s.emotion_curve.map((c) => ({ ...c, episode: episodeOf(c.clip_id) })),
      twists: s.twists,
      power_shifts: s.power_shifts,
      arcs: s.arcs,
    }))),
    adaptationMap ? jsonSection("ÁNH XẠ GỐC → REMAKE ĐÃ CHỐT (adaptation map)", adaptationMap) : "",
  ].join("");
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Tổng thời lượng tập remake phải nằm trong [min, max] × thời lượng phần story của tập gốc. */
export const REMAKE_DURATION_RATIO = { min: 0.8, max: 1.25 } as const;
/** Độ dài VIDEO trung bình dùng để gợi ý số VIDEO (VIDEO 4–9s, đoạn dồn dập dùng ngắn). */
const TYPICAL_VIDEO_SECONDS = 5.5;

/** Thời lượng phần "story" của tập gốc (bỏ recap/credits/preview) — đo từ timeline. */
export function storyDurationOf(clipId: string, tl: GlobalTimeline, memory: StoryMemory): number {
  const kinds = new Map((memory.clips.find((c) => c.clip_id === clipId)?.segments ?? []).map((d) => [d.id, d.kind]));
  return tl.segments
    .filter((s) => s.clipId === clipId && (kinds.get(s.segId) ?? "story") === "story")
    .reduce((sum, s) => sum + s.localEnd - s.localStart, 0);
}

/**
 * Kiểm tra JSON tập remake: tổng duration các VIDEO phải gần thời lượng tập gốc
 * (xác nhận qua so sánh video thật: tập gốc 26.7s → remake 8 VIDEO 42s, mỗi
 * câu thoại 1 VIDEO ≥4.5s → mọi điểm hook/payoff/cliffhanger trễ ~1.6×).
 */
/**
 * Mỗi VIDEO phải ghi rõ trang phục của TỪNG nhân vật trong ref (dòng
 * "WARDROBE:") — ảnh tham chiếu chỉ có 1 bộ, không nói rõ thì model gen chọn
 * ngẫu nhiên. PROP_/OBJ_ (type CHARACTER theo quy ước loader) không tính.
 */
export function checkWardrobe(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const issues: string[] = [];
  for (const v of value as { id?: string; type?: string; ref?: { id?: string; type?: string }[]; prompt?: string }[]) {
    if (v?.type !== "VIDEO" || typeof v.prompt !== "string") continue;
    const chars = (v.ref ?? []).filter((r) => r.type === "CHARACTER" && /^CHAR_/.test(String(r.id))).map((r) => String(r.id));
    if (chars.length === 0) continue;
    const lines = [...v.prompt.matchAll(/WARDROBE:([^]*?)(?=\b(?:CLIP SPEC|CAST AND VOICE|START FRAME|ACTION AND PERFORMANCE|SPEECH|SOUND AND EDITING|END FRAME|CONTINUITY|ANALYSIS ONLY):|$)/g)]
      .map((m) => m[1])
      .join(" ");
    const missing = chars.filter((c) => !lines.includes(c));
    if (missing.length > 0) {
      issues.push(
        `${v.id}: thiếu trang phục cho ${missing.join(", ")} — thêm "WARDROBE: ${missing[0]} wears W? — <mô tả đầy đủ>" (ảnh tham chiếu chỉ có 1 bộ, không nói rõ model sẽ chọn ngẫu nhiên).`,
      );
    }
  }
  return issues;
}

type VideoLike = { id?: string; type?: string; ref?: { id?: string; type?: string }[]; prompt?: string };

/** Người nói trong mục SPEECH theo mẫu "CHAR_X (<Picture N>, ...) says". */
function parseSpeakers(speech: string): { id: string; picture: number; descriptor: string }[] {
  return [...speech.matchAll(/(CHAR_[A-Z0-9_]+)\s*\(\s*<Picture\s*(\d+)>([^)]*)\)\s*says/g)].map((m) => ({
    id: m[1],
    picture: Number(m[2]),
    descriptor: m[3],
  }));
}

const POSITION_WORDS = /\b(left|right|center|centre|middle|foreground|background|front|behind|closest|nearest|far)\b/i;
const SILENT_WORDS = /\b(silent|mouth closed|does not speak|doesn't speak|not speaking|listens|listening|lips closed)\b/i;

/**
 * Khung hình có ≥2 nhân vật mà có thoại: phải GẮN người nói rõ ràng — model
 * video không hiểu id CHAR_, chỉ thấy <Picture N> + mô tả; không gắn thì nó
 * chọn đại người mấp máy môi (xác nhận qua lỗi thật: gốc A nói, remake B nói
 * dù cả 2 cùng trong khung). Mẫu: SPEECH: CHAR_A (<Picture 1>, the woman on
 * the LEFT in the red dress) says: "..." + người còn lại "stays silent, mouth closed".
 */
export function checkSpeakerBinding(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const issues: string[] = [];
  for (const v of value as VideoLike[]) {
    if (v?.type !== "VIDEO" || typeof v.prompt !== "string" || !hasSpokenLine(v.prompt)) continue;
    const refs = (v.ref ?? []).map((r) => String(r.id));
    const chars = (v.ref ?? []).filter((r) => r.type === "CHARACTER" && /^CHAR_/.test(String(r.id))).map((r) => String(r.id));
    if (chars.length < 2) continue;
    const speech = getPromptSection(v.prompt, "SPEECH") ?? "";
    const speakers = parseSpeakers(speech);
    const example = `SPEECH: ${chars[0]} (<Picture ${refs.indexOf(chars[0]) + 1}>, <vị trí trong khung: LEFT/RIGHT/foreground + nét nhận dạng>) says: "..." — ${chars[1]} (<Picture ${refs.indexOf(chars[1]) + 1}>, <vị trí>) stays silent, mouth closed, listening.`;
    if (speakers.length === 0) {
      issues.push(`${v.id}: khung có ${chars.length} nhân vật (${chars.join(", ")}) nhưng SPEECH không gắn rõ người nói — viết đúng mẫu: ${example}`);
      continue;
    }
    for (const sp of speakers) {
      if (!chars.includes(sp.id)) issues.push(`${v.id}: người nói ${sp.id} không có trong VIDEO.ref.`);
      else if (refs[sp.picture - 1] !== sp.id) issues.push(`${v.id}: ${sp.id} được gắn <Picture ${sp.picture}> nhưng <Picture ${sp.picture}> là ${refs[sp.picture - 1] ?? "(không có)"} — phải là <Picture ${refs.indexOf(sp.id) + 1}>.`);
      if (!POSITION_WORDS.test(sp.descriptor)) issues.push(`${v.id}: người nói ${sp.id} thiếu vị trí trong khung (LEFT/RIGHT/foreground...) để model biết ai mấp máy môi.`);
    }
    const speakerIds = new Set(speakers.map((s) => s.id));
    const context = `${getPromptSection(v.prompt, "CAST AND VOICE") ?? ""} ${speech}`;
    for (const c of chars.filter((id) => !speakerIds.has(id))) {
      const silent = new RegExp(`${c}[^.]*?${SILENT_WORDS.source}`, "i").test(context);
      if (!silent) issues.push(`${v.id}: ${c} cùng trong khung nhưng không có chỉ dẫn im lặng — thêm "${c} (<Picture ${refs.indexOf(c) + 1}>, <vị trí>) stays silent, mouth closed, listening".`);
    }
  }
  return issues;
}

/**
 * Chế độ GIỐNG GỐC: người nói trong remake phải là nhân vật MỚI tương ứng với
 * người nói ở shot gốc (SOURCE SHOTS → dialogue.speaker trong phân tích →
 * source_to_target_map của Bible).
 */
export function checkSourceSpeakers(
  value: unknown,
  memory: StoryMemory,
  sourceToTarget: Map<string, string>,
): string[] {
  if (!Array.isArray(value)) return [];
  const dialogueBySeg = new Map(
    memory.clips.flatMap((c) => c.segments).map((s) => [s.id, s.dialogue.map((d) => d.speaker).filter((sp) => /^CHAR_/.test(sp))]),
  );
  const issues: string[] = [];
  for (const v of value as VideoLike[]) {
    if (v?.type !== "VIDEO" || typeof v.prompt !== "string") continue;
    const sourceShots = (getPromptSection(v.prompt, "SOURCE SHOTS") ?? "").match(/S\d{4}/g) ?? [];
    if (sourceShots.length === 0) {
      issues.push(`${v.id}: thiếu "SOURCE SHOTS: S00xx, ..." (các shot gốc VIDEO này chuyển thể) ở cuối prompt.`);
      continue;
    }
    if (!hasSpokenLine(v.prompt)) continue;
    const expected = new Set(sourceShots.flatMap((s) => dialogueBySeg.get(s) ?? []).map((sp) => sourceToTarget.get(sp) ?? sp));
    if (expected.size === 0) continue;
    for (const sp of parseSpeakers(getPromptSection(v.prompt, "SPEECH") ?? "")) {
      if (!expected.has(sp.id)) {
        issues.push(
          `${v.id}: người nói là ${sp.id} nhưng ở shot gốc ${sourceShots.join(", ")} người nói là ${[...expected].join(", ")} (nhân vật mới tương ứng) — giữ ĐÚNG người nói như gốc.`,
        );
      }
    }
  }
  return issues;
}

/** Có thoại nói thành lời trong VIDEO.prompt (SPEECH: "..."). */
function hasSpokenLine(prompt: string): boolean {
  if (/SPEECH MODE:\s*(NO_HUMAN_VOICE|NONE|INTERNAL)/i.test(prompt)) return false;
  const speech = getPromptSection(prompt, "SPEECH");
  // Cả "SPEECH: \"...\"" lẫn "SPEECH: CHAR_A (<Picture 1>, ...) says: \"...\"".
  return speech !== null && !/^NONE\b/i.test(speech) && /["“]/.test(speech);
}

/**
 * Thoại đầu tiên của remake phải vào gần lúc tập gốc có thoại — xác nhận qua
 * lỗi thật (iop_remake_1_tap11): gốc nói ở giây 1–2, remake 4–5s mới có thoại.
 * Đo ở mức VIDEO: mốc bắt đầu của VIDEO đầu tiên có thoại.
 */
export function checkSpeechOnset(value: unknown, sourceFirstSpeech: number | null): string[] {
  if (!Array.isArray(value) || sourceFirstSpeech === null) return [];
  const videos = value.filter((e) => e && typeof e === "object" && (e as { type?: string }).type === "VIDEO") as { id?: string; duration?: number; prompt?: string }[];
  let t = 0;
  for (const v of videos) {
    if (hasSpokenLine(String(v.prompt ?? ""))) {
      if (t > sourceFirstSpeech + 2) {
        return [
          `Thoại đầu tiên của remake nằm ở ${v.id} bắt đầu từ giây ${round1(t)}, trong khi tập gốc có thoại từ giây ${sourceFirstSpeech} — đưa thoại vào sớm như gốc: VIDEO đầu có thoại ngay (trong 0.5–1s đầu clip), không mở bằng clip chỉ có hình/không khí.`,
        ];
      }
      return [];
    }
    t += Number(v.duration) || 0;
  }
  return [];
}

export function checkEpisodeDuration(value: unknown, sourceSeconds: number): string[] {
  if (!Array.isArray(value) || sourceSeconds <= 0) return [];
  const videos = value.filter((e) => e && typeof e === "object" && (e as { type?: string }).type === "VIDEO") as { id?: string; duration?: number }[];
  const total = videos.reduce((sum, v) => sum + (Number(v.duration) || 0), 0);
  const min = round1(sourceSeconds * REMAKE_DURATION_RATIO.min);
  const max = round1(sourceSeconds * REMAKE_DURATION_RATIO.max);
  if (total >= min && total <= max) return [];
  const target = Math.max(1, Math.round(sourceSeconds / TYPICAL_VIDEO_SECONDS));
  return [
    total > max
      ? `Tổng thời lượng VIDEO = ${round1(total)}s, dài gấp ${round1(total / sourceSeconds)} lần tập gốc (${round1(sourceSeconds)}s) — phải trong ${min}–${max}s. Mọi điểm hook/đảo chiều/cao trào/cliffhanger đang bị đẩy trễ. Gộp các nhịp ngắn liền nhau (câu thoại + phản ứng, 2 câu đối đáp ngắn, câu nịnh/đệm) vào CÙNG 1 VIDEO, bỏ nhịp dạo đầu/đi vào khung hình, không kéo dài VIDEO quá mức cần; khoảng ${target} VIDEO (hiện ${videos.length}).`
      : `Tổng thời lượng VIDEO = ${round1(total)}s, ngắn hơn nhiều so với tập gốc (${round1(sourceSeconds)}s) — phải trong ${min}–${max}s: đừng bỏ beat/phản ứng của tập gốc; khoảng ${target} VIDEO (hiện ${videos.length}).`,
  ];
}

/**
 * NHỊP DỰNG + ĐƯỜNG CƯỜNG ĐỘ của tập gốc, đo bằng code từ timeline (độ dài
 * shot thật) + intensity từng segment — để tập remake bám đúng nhịp cắt, chỗ
 * dồn dập, chỗ nghỉ, chỗ cao trào (báo cáo so sánh: remake chuyển cảnh trễ,
 * cao trào bị loãng vì không biết bản gốc cắt nhanh tới đâu).
 */
export function buildEditRhythm(clipId: string, tl: GlobalTimeline, memory: StoryMemory, structures: StoryStructure[]): unknown {
  const segs = tl.segments.filter((s) => s.clipId === clipId);
  const desc = new Map((memory.clips.find((c) => c.clip_id === clipId)?.segments ?? []).map((d) => [d.id, d]));
  const story = segs.filter((s) => (desc.get(s.segId)?.kind ?? "story") === "story");
  if (story.length === 0) return null;
  const lens = story.map((s) => s.localEnd - s.localStart);
  const sorted = [...lens].sort((a, b) => a - b);
  const total = lens.reduce((a, b) => a + b, 0);
  // Cửa sổ 10s cắt dày nhất (số shot bắt đầu trong 10s).
  let fastest = { from: 0, cuts: 0 };
  for (const s of story) {
    const cuts = story.filter((x) => x.localStart >= s.localStart && x.localStart < s.localStart + 10).length;
    if (cuts > fastest.cuts) fastest = { from: s.localStart, cuts };
  }
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const scenes = structures.flatMap((st) => st.scenes.filter((sc) => sc.clip_id === clipId));
  return {
    tong_thoi_luong_s: round1(total),
    ngan_sach_remake: {
      tong_thoi_luong_video_s: `${round1(total * REMAKE_DURATION_RATIO.min)}–${round1(total * REMAKE_DURATION_RATIO.max)} (bắt buộc — code kiểm tra)`,
      so_video_goi_y: Math.max(1, Math.round(total / TYPICAL_VIDEO_SECONDS)),
    },
    so_shot: story.length,
    shot_trung_binh_s: round1(total / story.length),
    shot_trung_vi_s: round1(sorted[Math.floor(sorted.length / 2)]),
    ty_le_shot_duoi_2s: `${Math.round((lens.filter((l) => l < 2).length / lens.length) * 100)}%`,
    doan_cat_day_nhat: `${mmss(fastest.from)}–${mmss(fastest.from + 10)}: ${fastest.cuts} shot/10s`,
    theo_scene: scenes.map((sc) => {
      const own = story.filter((s) => sc.seg_ids.includes(s.segId));
      const dur = own.reduce((a, s) => a + s.localEnd - s.localStart, 0);
      const peak = Math.max(0, ...own.map((s) => desc.get(s.segId)?.intensity ?? 0));
      return {
        scene: sc.id,
        tom_tat: sc.summary,
        thoi_luong_s: round1(dur),
        ty_le_tap: `${Math.round((dur / total) * 100)}%`,
        so_shot: own.length,
        shot_trung_binh_s: own.length ? round1(dur / own.length) : 0,
        cuong_do_dinh: peak || undefined,
      };
    }),
    duong_cuong_do: story
      .map((s) => ({ t: mmss(s.localStart), shot: s.segId, i: desc.get(s.segId)?.intensity }))
      .filter((p) => p.i !== undefined),
  };
}

/** Phần mạch truyện liên quan riêng tập N — cho bước DNA + tạo tập. */
export function buildEpisodeContext(
  clipId: string,
  memory: StoryMemory,
  structures: StoryStructure[],
  adaptationMap: AdaptationMap | null,
  episodeOf: EpisodeOf,
  /** Có timeline → thêm NHỊP DỰNG GỐC đo bằng code. */
  tl?: GlobalTimeline,
): string {
  const tap = episodeOf(clipId)!;
  const events = memory.events.filter((e) => e.clip_id === clipId);
  const ids = new Set(events.map((e) => e.id));
  const eventClip = new Map(memory.events.map((e) => [e.id, e.clip_id]));
  const epOf = (id: string) => episodeOf(eventClip.get(id));
  const touches = memory.threads.filter((t) => [...t.setup_events, ...t.payoff_events].some((e) => ids.has(e)));
  const plantHere = touches
    .filter((t) => t.setup_events.some((e) => ids.has(e)))
    .map((t) => ({
      thread: t.id,
      question: t.question,
      setup_events_here: t.setup_events.filter((e) => ids.has(e)),
      payoff_source_episodes: [...new Set(t.payoff_events.map(epOf))].filter((n) => n !== undefined && n > tap),
      status: t.status,
    }));
  const payHere = touches
    .filter((t) => t.payoff_events.some((e) => ids.has(e)))
    .map((t) => ({
      thread: t.id,
      question: t.question,
      payoff_events_here: t.payoff_events.filter((e) => ids.has(e)),
      setup_source_episodes: [...new Set(t.setup_events.map(epOf))].filter((n) => n !== undefined && n < tap),
      remake_mapping: adaptationMap?.threads.find((m) => m.source_thread_id === t.id) ?? null,
    }));
  const reinterps = memory.reinterpretations.filter((r) => ids.has(r.revealed_by)).map((r) => ({
    ...r,
    affects_source_episodes: [...new Set(r.affects.map(epOf))],
  }));
  const knowledgeAfter = memory.knowledge.filter((f) =>
    f.known_by.some((k) => (epOf(k.since_event) ?? Infinity) <= tap) || (epOf(f.audience_knows_since ?? "") ?? Infinity) <= tap,
  );
  const scenes = structures.flatMap((s) => s.scenes.filter((sc) => sc.clip_id === clipId));
  return [
    `\n\n## MẠCH TRUYỆN TOÀN PHIM LIÊN QUAN TẬP GỐC ${tap} (Global Story Memory — ưu tiên dưới Continuity/Season Arc, trên chi tiết mới)`,
    jsonSection(`SCENE + BEAT CỦA TẬP GỐC ${tap}`, scenes),
    jsonSection(`SETUP GIEO Ở TẬP GỐC ${tap} (payoff ở tập sau — tập remake BẮT BUỘC gieo setup tương đương)`, plantHere),
    jsonSection(`PAYOFF Ở TẬP GỐC ${tap} (setup từ tập trước — trả đúng setup mà bản remake ĐÃ gieo, theo remake_mapping)`, payHere),
    reinterps.length > 0 ? jsonSection(`TWIST ĐỔI NGHĨA TẬP TRƯỚC (lộ ở tập gốc ${tap})`, reinterps) : "",
    jsonSection(`AI BIẾT GÌ TÍNH TỚI HẾT TẬP GỐC ${tap}`, knowledgeAfter),
    tl
      ? jsonSection(
          `NHỊP DỰNG + ĐƯỜNG CƯỜNG ĐỘ TẬP GỐC ${tap} (đo từ video gốc — bám theo, xem mục THỰC THI CẢM XÚC)`,
          buildEditRhythm(clipId, tl, memory, structures),
        )
      : "",
  ].join("");
}

export const FILM_EPISODE_RULES = `\n\n## QUY TẮC MẠCH TRUYỆN TOÀN PHIM (Remake phim — áp dụng thêm cho tập này)
- Phim gốc đã được phân tích TOÀN CỤC: mục "SETUP GIEO Ở TẬP GỐC" là các chi tiết sẽ được trả ở tập SAU. Tập remake này BẮT BUỘC gieo chi tiết tương đương (đạo cụ/lời nói/hành động quan sát được trong VIDEO) để tập sau trả được — không bỏ vì "có vẻ không quan trọng".
- Mục "PAYOFF Ở TẬP GỐC": trả đúng setup mà BẢN REMAKE đã gieo (xem remake_mapping / adaptation map, Continuity Ledger). Nếu remake_mapping là null/dropped (bản remake chưa từng gieo setup đó): gieo nhanh setup ngay trong tập này trước khi trả, hoặc dùng flashback ngắn — KHÔNG để payoff "từ trên trời rơi xuống".
- Twist đổi nghĩa tập trước: giữ cú lật tương đương; các tập remake đã viết KHÔNG được sửa — twist phải khớp với những gì remake đã cho thấy.
- Không để nhân vật biết điều mà mục "AI BIẾT GÌ" cho thấy họ chưa biết ở thời điểm này.
- Segment có segment_kind recap/credits/preview trong TẬP GỐC chỉ là phần lặp/intro — không chuyển thể thành beat mới.

## THỰC THI CẢM XÚC — GIỮ ĐÚNG CƯỜNG ĐỘ, PHẢN ỨNG, NHỊP DỰNG, ÂM THANH CỦA BẢN GỐC
(Kiểm chứng qua so sánh video thật: remake giữ cấu trúc tốt nhưng hụt ở biểu cảm chưa sắc, phản ứng quá nhanh, chuyển cảnh trễ làm loãng cao trào, nhạc lấn thoại.)
- CƯỜNG ĐỘ: mỗi VIDEO chuyển thể shot có "cường độ N/10" trong TẬP GỐC phải đạt cường độ tương đương. Viết biểu cảm thành chi tiết QUAN SÁT ĐƯỢC, không viết tính từ chung chung ("tức giận"): ánh mắt (nheo, trợn, liếc, nhìn xoáy), lông mày, cơ hàm/nghiến răng, khoé miệng (nhếch, mím), nhịp thở, tư thế đầu/vai. Cường độ ≥ 8 → biểu cảm rõ, mạnh, có chuyển động cơ mặt thấy được ở cận cảnh. Phản diện chế giễu → nụ cười nhếch + ánh mắt khinh miệt nhìn xuống, giữ đủ lâu để khán giả ghét.
- PHẢN ỨNG: shot gốc có REACTION (hoặc nhân vật chịu đựng/sững người/kìm nén) → VIDEO remake phải có khoảnh khắc phản ứng riêng: cận mặt, giữ khoảng lặng 1–2 giây TRƯỚC khi nói/đáp, có thể push-in chậm. Không để nhân vật đáp lời ngay lập tức ở beat cảm xúc mạnh.
- KHOÁ FRAME (ưu tiên hơn quy định đánh số shot của master prompt): "shot" = CẢNH LIÊN TỤC (cùng bối cảnh, cùng thời điểm, hành động nối tiếp) — đổi góc máy/cắt cảnh bên trong cảnh liên tục KHÔNG tăng shot, chỉ tăng clip. Hai VIDEO liền nhau cùng shot: START FRAME clip sau GIỐNG TỪNG CHỮ END FRAME clip trước (code ghi đè START FRAME bằng END FRAME). START/END FRAME viết theo mẫu 7 trường: "CHARACTERS: ... | POSE: ... | POSITION: ... | GAZE: ... | HANDS/PROPS: ... | CAMERA: ... | LIGHTING: ..." — END FRAME là khung hình cuối THẬT của clip; đổi tư thế/góc máy thì làm trong ACTION.
- NGƯỜI NÓI (BẮT BUỘC, code kiểm tra): model video không hiểu id CHAR_, chỉ thấy <Picture N> + mô tả — khung có ≥2 nhân vật mà không gắn rõ người nói thì nó chọn đại người mấp máy môi. Mỗi câu thoại viết: SPEECH: CHAR_A (<Picture N đúng thứ tự trong ref>, <vị trí trong khung LEFT/RIGHT/foreground + nét nhận dạng>) says: "..."; MỌI nhân vật khác trong khung: "CHAR_B (<Picture M>, <vị trí>) stays silent, mouth closed, listening". Người nói phải đúng người nói ở TẬP GỐC (theo ánh xạ nhân vật), không đổi sang người khác.
- TRANG PHỤC (BẮT BUỘC, code kiểm tra): ảnh tham chiếu nhân vật chỉ có MỘT bộ đồ — không nói rõ thì model gen video chọn ngẫu nhiên. Mỗi VIDEO.prompt có dòng "WARDROBE:" trong CAST AND VOICE, ghi cho TỪNG nhân vật (CHARACTER) trong ref: "WARDROBE: CHAR_X wears <id bộ> — <mô tả đầy đủ bằng tiếng Anh: áo, quần/váy, màu, chất liệu, phụ kiện, giày>". Bộ khác bộ trong ảnh tham chiếu thì thêm "(NOT the outfit shown in <Picture N>)". Trang phục theo TẬP GỐC (WARDROBE từng shot) và danh mục outfits của nhân vật trong Bible; cùng shot giữ nguyên bộ.
- TỔNG THỜI LƯỢNG (BẮT BUỘC, code kiểm tra): tổng duration các VIDEO phải nằm trong "ngan_sach_remake" — gần bằng tập gốc, KHÔNG dài hơn nhiều. Shot gốc ngắn (trung bình 2–3s) mà mỗi VIDEO tối thiểu 4s → KHÔNG được làm mỗi câu thoại/mỗi phản ứng thành 1 VIDEO riêng: gộp các nhịp ngắn liền nhau (câu thoại + phản ứng của người nghe, 2 câu đối đáp ngắn, câu nịnh/đệm của vai phụ) vào CÙNG 1 VIDEO bằng đổi góc máy rõ ràng. Mốc hook/đảo chiều/cao trào/cliffhanger của remake phải rơi vào CÙNG TỶ LỆ thời gian như tập gốc (vd gốc cliffhanger ở 90% thời lượng → remake cũng ~90%).
- NHỊP DỰNG: bám mục "NHỊP DỰNG + ĐƯỜNG CƯỜNG ĐỘ". Đoạn gốc cắt dày (shot < 2–3s) → dùng VIDEO ngắn nhất cho phép, mỗi VIDEO bắt đầu NGAY vào hành động (không có nhịp dạo đầu/đi vào khung hình), có thể dồn 2–3 nhịp ngắn trong 1 VIDEO bằng đổi góc máy rõ ràng; đoạn gốc giữ shot lâu → cho VIDEO dài, máy chậm. Tỷ lệ thời lượng giữa các scene giữ gần tỷ lệ gốc (ty_le_tap).
- CAO TRÀO: shot cường độ đỉnh của tập gốc → remake dồn nhịp nhanh nhất ngay trước đỉnh, đỉnh là cận cảnh biểu cảm mạnh nhất tập; không chèn shot phụ/cảnh rộng giữa chuỗi leo thang làm loãng.
- TÍCH TỤ: khi bản gốc dồn ức chế liên tục, giữ liên tục trên nhân vật chịu đựng (cận/trung cảnh), không cắt sang cảnh rộng hay nhân vật phụ giữa chừng.
- TRẢ THƯỞNG: khoảnh khắc giải toả/hả hê/quyết tâm của nhân vật chính phải có biểu cảm ấm, kiên định, rõ ràng (ánh mắt vững, cằm nâng, nụ cười nhẹ đúng lúc) — tránh mặt đơ/trung tính.
- ÂM THANH: theo SOUND của shot gốc (nhạc vào/tăng/dừng, im lặng, SFX nhấn). Mỗi VIDEO có thoại: ghi rõ thoại nghe rõ, nhạc nền nhỏ dưới thoại (ducking); nhạc chỉ dâng ở khoảng không thoại và ở cao trào; khoảnh khắc sốc có thể cắt nhạc thành im lặng. Khoảnh khắc hook, đảo chiều hoặc phản diện bùng nổ (cười lớn, ra đòn, tuyên bố): đặt SFX nhấn (stinger/hit) ĐÚNG frame bắt đầu hành động và nhạc dâng theo — không để nhạc nền đều đều suốt.`;

/**
 * Quy tắc series cho chế độ GIỐNG GỐC — thay SERIES_EPISODE_RULES (vốn bắt đổi
 * thế giới, không dùng lại tên/thế giới gốc).
 */
export const FAITHFUL_SERIES_RULES = `## QUY TẮC REMAKE GIỐNG GỐC (ưu tiên CAO HƠN mọi mục mâu thuẫn bên trên)
Video remake phải GIỐNG HỆT video gốc — cùng câu chuyện, thứ tự shot, hành động, tư thế, bối cảnh, đạo cụ, góc máy, nhịp cắt, cảm xúc, âm thanh, thời điểm thoại — CHỈ THAY NHÂN VẬT (người mới theo Series Bible) và lời thoại DỊCH sang tiếng Anh.
- Thế giới, bối cảnh, đạo cụ, nghề nghiệp, quan hệ GIỮ NGUYÊN như phim gốc; KHÔNG chuyển thể sang thế giới khác, KHÔNG thêm/bỏ beat.
- Nhân vật: dùng ĐÚNG id + ngoại hình người MỚI trong Bible (source_to_target_map); tên trong thoại đổi thành tên mới.
- CARRY-IN: tập này tiếp đúng END STATE tập trước. Tập kết thúc đúng như tập gốc (cliffhanger của gốc).
- Bám TẬP GỐC từng shot (episode_time_s, speech_starts_at_episode_s): tổng thời lượng ≈ gốc, thoại vào đúng lúc, clip liền nhau cùng shot giữ nguyên tư thế ở chỗ chia.`;

export const REPLICA_SERIES_RULES = `## QUY TẮC REMAKE GIỐNG HỆT GỐC (ưu tiên CAO HƠN mọi mục mâu thuẫn bên trên)
Video remake phải GIỐNG HỆT video gốc — KHÔNG thay gì: cùng nhân vật (cùng người, gương mặt, trang phục), câu chuyện, thứ tự shot, hành động, tư thế, bối cảnh, đạo cụ, góc máy, nhịp cắt, cảm xúc, âm thanh, thời điểm thoại.
- Lời thoại NGUYÊN VĂN, đúng NGÔN NGỮ GỐC (theo thoại của shot gốc/transcript) — KHÔNG dịch, KHÔNG viết lại; ghi rõ ngôn ngữ: says in <ngôn ngữ>: "...". Mọi mô tả khác bằng tiếng Anh.
- Nhân vật: dùng ĐÚNG id trong Bible (source_to_target_map), ngoại hình như gốc.
- CARRY-IN: tập này tiếp đúng END STATE tập trước. Tập kết thúc đúng như tập gốc.
- Bám TẬP GỐC từng shot (episode_time_s, speech_starts_at_episode_s): tổng thời lượng ≈ gốc, thoại vào đúng lúc, clip liền nhau cùng shot giữ nguyên tư thế ở chỗ chia.
- MỖI VIDEO kết thúc bằng "SOURCE SHOTS: S00xx, ..." (code đối chiếu người nói với bản gốc).
- Ảnh nhân vật và bối cảnh được GEN LẠI từ asset.prompt (không dùng ảnh trong video gốc) → asset.prompt phải mô tả thật chi tiết để ảnh gen giống người/nơi chốn gốc.`;
