/**
 * Cầu nối Story Memory/Structure → pipeline series (seriesScript.ts):
 * - buildSourceEpisode: "TẬP GỐC" của 1 clip ở dạng storyboard (asset +
 *   VIDEO theo segment) — đúng hình dạng các prompt series/episode đang đọc.
 * - buildGlobalOverview / buildEpisodeContext: mạch truyện TOÀN PHIM để
 *   Bible/Arc/từng tập biết setup nào phải gieo cho payoff ở tập sau, twist
 *   nào đổi nghĩa tập trước, ai biết gì tới đâu.
 * Mỗi clip nguồn = 1 tập (tập N ↔ clip thứ N của manifest).
 */
import type { AdaptationMap, GlobalTimeline, SourceClip, StoryMemory, StoryStructure } from "./types";
import { jsonSection } from "./llm";

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

export function buildSourceEpisode(clip: SourceClip, tl: GlobalTimeline, memory: StoryMemory): string {
  const record = memory.clips.find((c) => c.clip_id === clip.clipId);
  if (!record) throw new Error(`Clip ${clip.clipId} chưa được phân tích.`);
  const segById = new Map(tl.segments.map((s) => [s.segId, s]));
  const used = new Set(record.segments.flatMap((s) => [...s.characters, ...(s.location ? [s.location] : [])]));
  const clipEvents = memory.events.filter((e) => e.clip_id === clip.clipId);
  clipEvents.forEach((e) => (e.props ?? []).forEach((p) => used.add(p)));

  const assets = [
    ...memory.characters.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, type: "CHARACTER", prompt: `${c.name}: ${c.description}` })),
    ...memory.locations.filter((l) => used.has(l.id)).map((l) => ({ id: l.id, type: "LOCATION", prompt: l.description })),
    ...memory.props.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, type: p.type, prompt: p.description })),
  ];
  const fps = targetFrameRate(clip.fps);
  const videos = record.segments.map((s) => {
    const seg = segById.get(s.id)!;
    const speech = s.dialogue.map((d) => `${d.speaker}: "${d.text}"`).join(" ");
    const events = clipEvents.filter((e) => e.seg_ids.includes(s.id)).map((e) => `${e.id} ${e.summary}`);
    return {
      id: s.id,
      type: "VIDEO",
      source_shot: true,
      segment_kind: s.kind,
      duration: Math.round((seg.localEnd - seg.localStart) * 10) / 10,
      frameRate: fps,
      prompt: [
        s.location ? `LOCATION: ${s.location}.` : "",
        s.characters.length ? `CHARACTERS: ${s.characters.join(", ")}.` : "",
        `ACTION: ${s.action}`,
        speech ? `SPEECH: ${speech}` : "",
        s.emotion ? `EMOTION: ${s.emotion}.` : "",
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

/** Phần mạch truyện liên quan riêng tập N — cho bước DNA + tạo tập. */
export function buildEpisodeContext(
  clipId: string,
  memory: StoryMemory,
  structures: StoryStructure[],
  adaptationMap: AdaptationMap | null,
  episodeOf: EpisodeOf,
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
  ].join("");
}

export const FILM_EPISODE_RULES = `\n\n## QUY TẮC MẠCH TRUYỆN TOÀN PHIM (Remake phim — áp dụng thêm cho tập này)
- Phim gốc đã được phân tích TOÀN CỤC: mục "SETUP GIEO Ở TẬP GỐC" là các chi tiết sẽ được trả ở tập SAU. Tập remake này BẮT BUỘC gieo chi tiết tương đương (đạo cụ/lời nói/hành động quan sát được trong VIDEO) để tập sau trả được — không bỏ vì "có vẻ không quan trọng".
- Mục "PAYOFF Ở TẬP GỐC": trả đúng setup mà BẢN REMAKE đã gieo (xem remake_mapping / adaptation map, Continuity Ledger). Nếu remake_mapping là null/dropped (bản remake chưa từng gieo setup đó): gieo nhanh setup ngay trong tập này trước khi trả, hoặc dùng flashback ngắn — KHÔNG để payoff "từ trên trời rơi xuống".
- Twist đổi nghĩa tập trước: giữ cú lật tương đương; các tập remake đã viết KHÔNG được sửa — twist phải khớp với những gì remake đã cho thấy.
- Không để nhân vật biết điều mà mục "AI BIẾT GÌ" cho thấy họ chưa biết ở thời điểm này.
- Segment có segment_kind recap/credits/preview trong TẬP GỐC chỉ là phần lặp/intro — không chuyển thể thành beat mới.`;
