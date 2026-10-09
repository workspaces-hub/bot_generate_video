/**
 * Stage 4 — GLOBAL STORY MEMORY: nguồn chuẩn về trạng thái + cách hiểu câu
 * chuyện. LLM (Stage 3) chỉ đề xuất MemoryDelta cho 1 clip; validateDelta
 * chặn mọi thứ phá bất biến, applyDelta mới ghi.
 *
 * Bất biến:
 * - Không timestamp: delta chỉ tham chiếu segId của ĐÚNG clip đang phân tích.
 * - Event/fact/thread/reinterpretation đã ghi KHÔNG bị sửa hay xoá. Tập sau
 *   chỉ được: thêm payoff vào thread, đổi trạng thái thread, thêm người biết
 *   một fact, hoặc thêm Reinterpretation (đổi cách hiểu, giữ event gốc).
 * - Danh tính (name/description) của nhân vật/đạo cụ đã có không bị ghi đè —
 *   update chỉ đổi trạng thái (goals, relations, holder, state...).
 * - Mọi id được tham chiếu phải tồn tại (trong memory hoặc chính delta).
 */
import type {
  CharacterRecord,
  GlobalTimeline,
  MemoryDelta,
  PropRecord,
  SegmentDescription,
  StoryMemory,
} from "./types";

export class DeltaRejected extends Error {
  constructor(readonly errors: string[]) {
    super(`Delta không hợp lệ (${errors.length} lỗi):\n- ${errors.slice(0, 40).join("\n- ")}`);
  }
}

export function emptyMemory(): StoryMemory {
  return {
    version: 1,
    analyzed_clips: [],
    clips: [],
    characters: [],
    props: [],
    locations: [],
    events: [],
    knowledge: [],
    threads: [],
    reinterpretations: [],
  };
}

const TIMESTAMP_KEY = /^(start|end|time|timestamp|seconds?|duration|(global|local)_?(start|end)|(start|end)_?(time|sec|seconds))$/i;

function findTimestampKeys(value: unknown, pathPrefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findTimestampKeys(v, `${pathPrefix}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(TIMESTAMP_KEY.test(k) ? [`${pathPrefix}.${k}`] : []),
    ...findTimestampKeys(v, `${pathPrefix}.${k}`),
  ]);
}

/** "C03" → "03": tiền tố bắt buộc của id event/fact/thread mới trong clip này. */
function clipTag(clipId: string): string {
  return clipId.replace(/^C/i, "");
}

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** Chuẩn hoá nhẹ đầu ra LLM (thiếu mảng → []) trước khi kiểm tra. */
export function normalizeDelta(raw: unknown, clipId: string): MemoryDelta {
  const d = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<MemoryDelta>;
  return {
    ...d,
    clip_id: typeof d.clip_id === "string" ? d.clip_id : clipId,
    clip_summary: typeof d.clip_summary === "string" ? d.clip_summary : "",
    segments: arr(d.segments).map((s) => ({ ...s, characters: arr(s.characters), dialogue: arr(s.dialogue) })),
    events: arr(d.events).map((e) => ({ ...e, seg_ids: arr(e.seg_ids), actors: arr(e.actors), props: arr(e.props), caused_by: arr(e.caused_by) })),
    new_characters: arr(d.new_characters).map((c) => ({ ...c, aliases: arr(c.aliases) })),
    character_updates: arr(d.character_updates),
    new_props: arr(d.new_props),
    prop_updates: arr(d.prop_updates),
    new_locations: arr(d.new_locations),
    knowledge: arr(d.knowledge).map((f) => ({ ...f, known_by: arr(f.known_by) })),
    knowledge_updates: arr(d.knowledge_updates),
    thread_opens: arr(d.thread_opens).map((t) => ({
      ...t,
      status: t.status === "resolved" ? "resolved" : "open",
      setup_events: arr(t.setup_events),
      payoff_events: arr(t.payoff_events),
    })),
    thread_updates: arr(d.thread_updates),
    reinterpretations: arr(d.reinterpretations).map((r) => ({ ...r, affects: arr(r.affects) })),
  };
}

/** Thiếu tối đa chừng này segment thì tự điền chỗ trống thay vì bắt làm lại cả clip. */
const MAX_FILLED_SEGMENT_RATIO = 0.1;

/**
 * Tự sửa lỗi VẶT của Gemini trước khi validateDelta — mỗi lần làm lại phải
 * mở chat mới + upload lại video (~1 phút), không đáng cho lỗi kiểu này
 * (xác nhận qua log thật, tập 2 aladinhusband: lần 1 thiếu 3/62 segment cuối,
 * lần 2 dùng "UNKNOWN" làm nhân vật + quên khai báo 1 bối cảnh):
 * - nhãn chung không phải id (UNKNOWN, NARRATOR, CROWD...) trong danh sách
 *   nhân vật → bỏ (người nói ngoài hình vẫn giữ ở dialogue.speaker);
 * - LOC_/PROP_/OBJ_ được dùng mà chưa khai báo → tự khai báo (mô tả lấy từ
 *   segment/event đầu tiên dùng nó);
 * - thiếu ≤ 10% segment → điền segment kind "other" (không mô tả).
 * KHÔNG tự sửa: CHAR_ chưa khai báo, id sai/trùng, nhân quả, timestamp —
 * những lỗi đó làm sai câu chuyện, phải để Gemini làm lại.
 */
export function repairDelta(
  mem: StoryMemory,
  d: MemoryDelta,
  tl: GlobalTimeline,
  clipId: string,
): { delta: MemoryDelta; fixes: string[] } {
  const delta: MemoryDelta = structuredClone(d);
  const fixes: string[] = [];
  const isCharId = (id: string) => /^CHAR_[A-Z0-9_]+$/.test(id);

  // intensity tuỳ chọn: chữ số → số, ngoài 1–10 → kẹp, không phải số → bỏ.
  for (const seg of delta.segments) {
    if (seg.intensity === undefined || seg.intensity === null) continue;
    const n = Number(seg.intensity);
    if (Number.isFinite(n)) seg.intensity = Math.min(10, Math.max(1, Math.round(n)));
    else delete seg.intensity;
  }

  for (const seg of delta.segments) {
    const generic = seg.characters.filter((c) => !isCharId(c));
    if (generic.length > 0) {
      seg.characters = seg.characters.filter(isCharId);
      fixes.push(`${seg.id}: bỏ nhãn chung ${generic.join(", ")} khỏi characters`);
    }
  }
  for (const e of delta.events) {
    const generic = e.actors.filter((a) => !isCharId(a));
    if (generic.length > 0) {
      e.actors = e.actors.filter(isCharId);
      fixes.push(`${e.id}: bỏ nhãn chung ${generic.join(", ")} khỏi actors`);
    }
  }

  // Segment ngoài shot list (Gemini viết lố quá cuối clip — log thật: S0063–S0068
  // khi clip chỉ có 62 shot) → bỏ; event chỉ trỏ vào segment bịa → bỏ event.
  const clipSegSet = new Set(tl.segments.filter((s) => s.clipId === clipId).map((s) => s.segId));
  const foreignSegs = delta.segments.filter((s) => !clipSegSet.has(s.id)).map((s) => s.id);
  if (foreignSegs.length > 0) {
    delta.segments = delta.segments.filter((s) => clipSegSet.has(s.id));
    fixes.push(`bỏ ${foreignSegs.length} segment không có trong shot list: ${foreignSegs.join(", ")}`);
  }
  const droppedEvents: string[] = [];
  delta.events = delta.events.filter((e) => {
    const valid = e.seg_ids.filter((sid) => clipSegSet.has(sid));
    if (valid.length < e.seg_ids.length) {
      fixes.push(`${e.id}: bỏ segId không có trong shot list ${e.seg_ids.filter((sid) => !clipSegSet.has(sid)).join(", ")}`);
      e.seg_ids = valid;
    }
    if (e.seg_ids.length === 0) droppedEvents.push(e.id);
    return e.seg_ids.length > 0;
  });
  if (droppedEvents.length > 0) fixes.push(`bỏ event chỉ gắn với segment bịa: ${droppedEvents.join(", ")}`);
  const segAction = new Map(delta.segments.map((s) => [s.id, s.action]));
  for (const e of delta.events) {
    if (e.summary?.trim()) continue;
    e.summary = `(tự điền) ${segAction.get(e.seg_ids[0]) ?? e.type}`;
    fixes.push(`${e.id}: summary trống → lấy mô tả segment ${e.seg_ids[0]}`);
  }

  // CHAR_ chưa khai báo mà CHỈ xuất hiện trong segment (vai phụ trong khung
  // hình, vd CHAR_VILLAIN_1) → tự khai báo. Xuất hiện ở event/knowledge thì
  // KHÔNG tự sửa — có thể là nhân vật đã có bị đặt nhầm id.
  const declared = new Set([...mem.characters, ...arr(delta.new_characters)].map((c) => c.id));
  const storyRefs = new Set([
    ...delta.events.flatMap((e) => e.actors),
    ...arr(delta.knowledge).flatMap((f) => f.known_by.map((k) => k.char_id)),
    ...arr(delta.knowledge_updates).flatMap((u) => arr(u.known_by_add).map((k) => k.char_id)),
    ...arr(delta.character_updates).map((u) => u.id),
  ]);
  for (const seg of delta.segments) {
    for (const id of seg.characters) {
      if (declared.has(id) || storyRefs.has(id)) continue;
      const name = id.replace(/^CHAR_/, "").replace(/_/g, " ").toLowerCase();
      delta.new_characters = [
        ...arr(delta.new_characters),
        { id, name, description: `(tự khai báo — vai phụ trong khung hình) ${seg.action}`.slice(0, 300), aliases: [] },
      ];
      declared.add(id);
      fixes.push(`tự khai báo vai phụ ${id} (chỉ xuất hiện trong segment)`);
    }
  }

  const locs = new Set([...mem.locations, ...arr(delta.new_locations)].map((l) => l.id));
  for (const seg of delta.segments) {
    if (!seg.location || locs.has(seg.location)) continue;
    if (!/^LOC_[A-Z0-9_]+$/.test(seg.location)) {
      fixes.push(`${seg.id}: bỏ bối cảnh không hợp lệ "${seg.location}"`);
      delete seg.location;
      continue;
    }
    delta.new_locations = [...arr(delta.new_locations), { id: seg.location, description: `(tự khai báo) ${seg.action}`.slice(0, 300) }];
    locs.add(seg.location);
    fixes.push(`tự khai báo bối cảnh ${seg.location}`);
  }
  const props = new Set([...mem.props, ...arr(delta.new_props)].map((p) => p.id));
  for (const e of delta.events) {
    for (const pid of arr(e.props)) {
      if (props.has(pid) || !/^(PROP|OBJ)_[A-Z0-9_]+$/.test(pid)) continue;
      delta.new_props = [
        ...arr(delta.new_props),
        { id: pid, type: pid.startsWith("OBJ_") ? "OBJECT" : "PROP", description: `(tự khai báo) ${e.summary}`.slice(0, 300) },
      ];
      props.add(pid);
      fixes.push(`tự khai báo đạo cụ ${pid}`);
    }
  }

  const clipSegs = tl.segments.filter((s) => s.clipId === clipId).map((s) => s.segId);
  const described = new Set(delta.segments.map((s) => s.id));
  const missing = clipSegs.filter((id) => !described.has(id));
  if (missing.length > 0 && missing.length <= Math.max(1, Math.floor(clipSegs.length * MAX_FILLED_SEGMENT_RATIO))) {
    for (const id of missing) {
      delta.segments.push({ id, kind: "other", characters: [], dialogue: [], action: "(Gemini không mô tả segment này)" });
    }
    const order = new Map(clipSegs.map((id, i) => [id, i]));
    delta.segments.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    fixes.push(`điền ${missing.length} segment Gemini bỏ sót: ${missing.join(", ")}`);
  }
  return { delta, fixes };
}

export function validateDelta(mem: StoryMemory, d: MemoryDelta, tl: GlobalTimeline, clipId: string): string[] {
  const errors: string[] = [];
  const tag = clipTag(clipId);
  const clipSegs = tl.segments.filter((s) => s.clipId === clipId).map((s) => s.segId);
  const clipSegSet = new Set(clipSegs);

  if (d.clip_id !== clipId) errors.push(`clip_id "${d.clip_id}" ≠ "${clipId}"`);
  if (!d.clip_summary.trim()) errors.push("clip_summary trống");
  for (const key of findTimestampKeys(d)) errors.push(`Có khoá thời gian "${key}" — chỉ được tham chiếu segId`);

  // Segment: phủ ĐỦ mọi segId của clip, không segId lạ.
  const described = new Set<string>();
  for (const s of d.segments) {
    if (!clipSegSet.has(s.id)) errors.push(`segments: "${s.id}" không thuộc ${clipId}`);
    described.add(s.id);
  }
  const missing = clipSegs.filter((s) => !described.has(s));
  if (missing.length > 0) errors.push(`segments thiếu ${missing.length}/${clipSegs.length} segId: ${missing.slice(0, 15).join(", ")}`);

  // Thực thể: id mới không trùng id cũ; tham chiếu phải tồn tại.
  const chars = new Set(mem.characters.map((c) => c.id));
  for (const c of arr(d.new_characters)) {
    if (!/^CHAR_[A-Z0-9_]+$/.test(c.id)) errors.push(`new_characters: id "${c.id}" phải dạng CHAR_XXX`);
    if (chars.has(c.id)) errors.push(`new_characters: "${c.id}" đã tồn tại — dùng character_updates`);
    if (!c.name?.trim() || !c.description?.trim()) errors.push(`new_characters: "${c.id}" thiếu name/description`);
    chars.add(c.id);
  }
  const props = new Set(mem.props.map((p) => p.id));
  for (const p of arr(d.new_props)) {
    if (!/^(PROP|OBJ)_[A-Z0-9_]+$/.test(p.id)) errors.push(`new_props: id "${p.id}" phải dạng PROP_XXX/OBJ_XXX`);
    if (props.has(p.id)) errors.push(`new_props: "${p.id}" đã tồn tại — dùng prop_updates`);
    props.add(p.id);
  }
  const locs = new Set(mem.locations.map((l) => l.id));
  for (const l of arr(d.new_locations)) {
    if (!/^LOC_[A-Z0-9_]+$/.test(l.id)) errors.push(`new_locations: id "${l.id}" phải dạng LOC_XXX`);
    if (locs.has(l.id)) errors.push(`new_locations: "${l.id}" đã tồn tại`);
    locs.add(l.id);
  }
  const needChar = (id: string, where: string) => {
    if (!chars.has(id)) errors.push(`${where}: nhân vật "${id}" chưa khai báo (thêm vào new_characters)`);
  };
  const needProp = (id: string, where: string) => {
    if (!props.has(id)) errors.push(`${where}: đạo cụ "${id}" chưa khai báo (thêm vào new_props)`);
  };
  for (const s of d.segments) {
    s.characters.forEach((c) => needChar(c, `segments ${s.id}`));
    if (s.location && !locs.has(s.location)) errors.push(`segments ${s.id}: bối cảnh "${s.location}" chưa khai báo`);
  }
  for (const u of arr(d.character_updates)) needChar(u.id, "character_updates");
  for (const u of arr(d.prop_updates)) {
    needProp(u.id, "prop_updates");
    if (u.holder && u.holder.startsWith("CHAR_")) needChar(u.holder, `prop_updates ${u.id}.holder`);
  }

  // Event: id theo clip, không trùng, segId thuộc clip, nhân quả trỏ event đã biết.
  const existingEvents = new Set(mem.events.map((e) => e.id));
  const events = new Set(existingEvents);
  const newEventIds = new Set<string>();
  const eventPattern = new RegExp(`^E${tag}_\\d+$`);
  for (const e of d.events) {
    if (!eventPattern.test(e.id)) errors.push(`events: id "${e.id}" phải dạng E${tag}_<số>`);
    if (events.has(e.id)) errors.push(`events: "${e.id}" trùng event đã có`);
    events.add(e.id);
    newEventIds.add(e.id);
  }
  if (d.events.length === 0) errors.push("events trống");
  const needEvent = (id: string, where: string) => {
    if (!events.has(id)) errors.push(`${where}: event "${id}" không tồn tại`);
  };
  for (const e of d.events) {
    if (e.seg_ids.length === 0) errors.push(`events ${e.id}: seg_ids trống`);
    e.seg_ids.forEach((s) => {
      if (!clipSegSet.has(s)) errors.push(`events ${e.id}: segId "${s}" không thuộc ${clipId}`);
    });
    e.actors.forEach((a) => needChar(a, `events ${e.id}.actors`));
    arr(e.props).forEach((p) => needProp(p, `events ${e.id}.props`));
    arr(e.caused_by).forEach((c) => {
      if (c === e.id) errors.push(`events ${e.id}: caused_by trỏ chính nó`);
      else needEvent(c, `events ${e.id}.caused_by`);
    });
    if (!e.summary?.trim()) errors.push(`events ${e.id}: summary trống`);
  }

  // Knowledge.
  const facts = new Set(mem.knowledge.map((f) => f.id));
  const factPattern = new RegExp(`^F${tag}_\\d+$`);
  for (const f of arr(d.knowledge)) {
    if (!factPattern.test(f.id)) errors.push(`knowledge: id "${f.id}" phải dạng F${tag}_<số>`);
    if (facts.has(f.id)) errors.push(`knowledge: "${f.id}" đã tồn tại — dùng knowledge_updates`);
    facts.add(f.id);
    f.known_by.forEach((k) => {
      needChar(k.char_id, `knowledge ${f.id}.known_by`);
      needEvent(k.since_event, `knowledge ${f.id}.known_by`);
    });
    if (f.audience_knows_since) needEvent(f.audience_knows_since, `knowledge ${f.id}.audience_knows_since`);
  }
  for (const u of arr(d.knowledge_updates)) {
    if (!facts.has(u.id)) errors.push(`knowledge_updates: fact "${u.id}" không tồn tại`);
    arr(u.known_by_add).forEach((k) => {
      needChar(k.char_id, `knowledge_updates ${u.id}`);
      needEvent(k.since_event, `knowledge_updates ${u.id}`);
    });
    if (u.audience_knows_since) needEvent(u.audience_knows_since, `knowledge_updates ${u.id}`);
  }

  // Threads: mở mới theo clip; cập nhật chỉ THÊM event, không xoá.
  const threads = new Set(mem.threads.map((t) => t.id));
  const threadPattern = new RegExp(`^T${tag}_\\d+$`);
  for (const t of arr(d.thread_opens)) {
    if (!threadPattern.test(t.id)) errors.push(`thread_opens: id "${t.id}" phải dạng T${tag}_<số>`);
    if (threads.has(t.id)) errors.push(`thread_opens: "${t.id}" đã tồn tại — dùng thread_updates`);
    threads.add(t.id);
    if (t.setup_events.length === 0) errors.push(`thread_opens ${t.id}: setup_events trống`);
    t.setup_events.forEach((e) => needEvent(e, `thread_opens ${t.id}`));
    t.payoff_events.forEach((e) => needEvent(e, `thread_opens ${t.id}`));
  }
  for (const u of arr(d.thread_updates)) {
    if (!threads.has(u.id)) errors.push(`thread_updates: thread "${u.id}" không tồn tại`);
    arr(u.add_setup_events).forEach((e) => needEvent(e, `thread_updates ${u.id}`));
    // Payoff có thể là event cũ (nhận ra muộn) — chỉ cần tồn tại.
    arr(u.add_payoff_events).forEach((e) => needEvent(e, `thread_updates ${u.id}`));
  }

  // Reinterpretation: do event MỚI của clip này tiết lộ, đổi nghĩa event CŨ.
  const reinterps = new Set(mem.reinterpretations.map((r) => r.id));
  const reinterpPattern = new RegExp(`^R${tag}_\\d+$`);
  for (const r of arr(d.reinterpretations)) {
    if (!reinterpPattern.test(r.id)) errors.push(`reinterpretations: id "${r.id}" phải dạng R${tag}_<số>`);
    if (reinterps.has(r.id)) errors.push(`reinterpretations: "${r.id}" trùng`);
    reinterps.add(r.id);
    if (!newEventIds.has(r.revealed_by)) errors.push(`reinterpretations ${r.id}: revealed_by phải là event mới của ${clipId}`);
    if (r.affects.length === 0) errors.push(`reinterpretations ${r.id}: affects trống`);
    r.affects.forEach((e) => {
      if (!existingEvents.has(e)) errors.push(`reinterpretations ${r.id}: affects "${e}" phải là event của clip TRƯỚC`);
    });
    arr(r.fact_changes).forEach((fc) => {
      if (!facts.has(fc.fact_id)) errors.push(`reinterpretations ${r.id}: fact "${fc.fact_id}" không tồn tại`);
    });
  }
  return errors;
}

function firstLastSeg(segments: SegmentDescription[], match: (s: SegmentDescription) => boolean): [string?, string?] {
  const hits = segments.filter(match).map((s) => s.id).sort();
  return [hits[0], hits[hits.length - 1]];
}

const uniq = <T>(items: T[]): T[] => [...new Set(items)];

/** Kiểm tra + ghi delta → memory MỚI (không sửa object cũ). Lỗi → DeltaRejected. */
export function applyDelta(
  mem: StoryMemory,
  delta: MemoryDelta,
  tl: GlobalTimeline,
  clipId: string,
  batch: number,
): StoryMemory {
  const errors = validateDelta(mem, delta, tl, clipId);
  if (errors.length > 0) throw new DeltaRejected(errors);

  const next: StoryMemory = structuredClone(mem);
  const order = new Map(tl.segments.map((s, i) => [s.segId, i]));
  const segments = [...delta.segments].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  // Bỏ mô tả trùng segId (giữ bản sau cùng — askGemini có thể gửi lặp khi chia lượt).
  const dedupedSegments = [...new Map(segments.map((s) => [s.id, s])).values()];

  next.clips = [
    ...next.clips.filter((c) => c.clip_id !== clipId),
    { clip_id: clipId, batch, summary: delta.clip_summary, segments: dedupedSegments },
  ];

  for (const c of arr(delta.new_characters)) {
    const [first, last] = firstLastSeg(dedupedSegments, (s) => s.characters.includes(c.id));
    next.characters.push({ ...c, aliases: uniq(arr(c.aliases)), first_seg: first, last_seg: last });
  }
  const charById = new Map(next.characters.map((c) => [c.id, c]));
  for (const u of arr(delta.character_updates)) {
    const c = charById.get(u.id) as CharacterRecord;
    // Danh tính khoá: bỏ qua name/description/first_seg từ update.
    if (u.goals) c.goals = u.goals;
    if (u.relations) c.relations = { ...c.relations, ...u.relations };
    if (u.emotion) c.emotion = u.emotion;
    if (u.status) c.status = u.status;
    if (u.role) c.role = u.role;
    if (u.aliases) c.aliases = uniq([...c.aliases, ...u.aliases]);
  }
  for (const c of next.characters) {
    const [, last] = firstLastSeg(dedupedSegments, (s) => s.characters.includes(c.id));
    if (last) c.last_seg = last;
  }

  for (const p of arr(delta.new_props)) {
    next.props.push({ ...p, type: p.type === "OBJECT" ? "OBJECT" : "PROP" });
  }
  const propById = new Map(next.props.map((p) => [p.id, p]));
  for (const u of arr(delta.prop_updates)) {
    const p = propById.get(u.id) as PropRecord;
    if (u.holder !== undefined) p.holder = u.holder;
    if (u.state) p.state = u.state;
  }
  for (const e of delta.events) {
    for (const pid of arr(e.props)) {
      const p = propById.get(pid);
      if (!p) continue;
      p.first_seg ??= e.seg_ids[0];
      p.last_seg = e.seg_ids[e.seg_ids.length - 1];
    }
  }

  next.locations.push(...arr(delta.new_locations));
  next.events.push(...delta.events.map((e) => ({ ...e, clip_id: clipId, batch })));

  next.knowledge.push(...arr(delta.knowledge));
  const factById = new Map(next.knowledge.map((f) => [f.id, f]));
  for (const u of arr(delta.knowledge_updates)) {
    const f = factById.get(u.id)!;
    if (typeof u.is_true === "boolean") f.is_true = u.is_true;
    if (u.audience_knows_since) f.audience_knows_since = u.audience_knows_since;
    const known = new Set(f.known_by.map((k) => k.char_id));
    for (const k of arr(u.known_by_add)) if (!known.has(k.char_id)) f.known_by.push(k);
  }

  next.threads.push(...arr(delta.thread_opens));
  const threadById = new Map(next.threads.map((t) => [t.id, t]));
  for (const u of arr(delta.thread_updates)) {
    const t = threadById.get(u.id)!;
    t.setup_events = uniq([...t.setup_events, ...arr(u.add_setup_events)]);
    t.payoff_events = uniq([...t.payoff_events, ...arr(u.add_payoff_events)]);
    if (u.status) t.status = u.status;
  }

  for (const r of arr(delta.reinterpretations)) {
    next.reinterpretations.push(r);
    for (const fc of arr(r.fact_changes)) factById.get(fc.fact_id)!.is_true = fc.is_true;
  }

  next.analyzed_clips = uniq([...next.analyzed_clips, clipId]);
  return next;
}

/**
 * Bản rút gọn memory gửi kèm prompt phân tích clip kế tiếp — đủ để LLM dùng
 * lại đúng id và nối mạch, không phình theo độ dài phim: danh tính đầy đủ,
 * tóm tắt mọi clip, thread còn mở, fact, và recentEvents event gần nhất.
 */
export function compactMemory(mem: StoryMemory, recentEvents = 40): unknown {
  const openThreads = mem.threads.filter((t) => t.status === "open");
  const pinned = new Set(openThreads.flatMap((t) => t.setup_events));
  const eventById = new Map(mem.events.map((e) => [e.id, e]));
  const recent = mem.events.slice(-recentEvents);
  const recentIds = new Set(recent.map((e) => e.id));
  const pinnedOld = [...pinned].filter((id) => !recentIds.has(id)).flatMap((id) => (eventById.has(id) ? [eventById.get(id)!] : []));
  const brief = (e: (typeof mem.events)[number]) => ({ id: e.id, clip: e.clip_id, type: e.type, actors: e.actors, summary: e.summary });
  return {
    clips_so_far: mem.clips.map((c) => ({ clip_id: c.clip_id, summary: c.summary })),
    characters: mem.characters.map((c) => ({
      id: c.id, name: c.name, description: c.description, aliases: c.aliases,
      role: c.role, status: c.status, emotion: c.emotion, goals: c.goals, relations: c.relations,
    })),
    props: mem.props.map((p) => ({ id: p.id, type: p.type, description: p.description, holder: p.holder, state: p.state })),
    locations: mem.locations,
    knowledge: mem.knowledge,
    open_threads: openThreads,
    resolved_threads: mem.threads.filter((t) => t.status === "resolved").map((t) => ({ id: t.id, question: t.question })),
    reinterpretations: mem.reinterpretations,
    setup_events_of_open_threads: pinnedOld.map(brief),
    recent_events: recent.map(brief),
    next_ids_hint: "Id mới của clip này: E<số clip>_<n>, F<số clip>_<n>, T<số clip>_<n>, R<số clip>_<n>.",
  };
}
