/**
 * Schema chung của pipeline "Remake phim" (xem pipeline.ts):
 *
 *   clip nguồn → [1] manifest → [2] Global Timeline → [3] phân tích từng clip
 *   (memory cuốn chiếu) → [4] Global Story Memory → [5] Story Structure →
 *   [6–7] Bible/Arc/từng tập (seriesScript.ts) → adaptation map → [8] ảnh/
 *   video (luồng storyboard có sẵn).
 *
 * Hai nguồn chuẩn:
 * - GlobalTimeline: THỜI GIAN — chỉ code ghi (ffprobe/ffmpeg/worker Python).
 * - StoryMemory: TRẠNG THÁI + CÁCH HIỂU câu chuyện — LLM đề xuất delta, code
 *   kiểm tra rồi mới ghi (memory.ts).
 * LLM KHÔNG BAO GIỜ trả timestamp: mọi vị trí tham chiếu bằng segId.
 *
 * Khoá JSON phía LLM đọc/ghi dùng snake_case + "id" (askGemini gộp/khử trùng
 * mảng theo "id" khi kết quả chia nhiều lượt).
 */

// ---------- Stage 1–2: nguồn + timeline (code) ----------

export interface SourceClip {
  clipId: string; // "C01", "C02"... theo thứ tự phim, bất biến
  fileName: string;
  path: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Đợt nạp clip (1 = lần remake đầu, 2 = "làm thêm"...). */
  batch: number;
  /** Số tập đọc từ tên file (naming.ts) — null nếu tên không có số tập. */
  sourceEpisode: number | null;
  /** "<kích thước>-<mtime>" của file lúc nạp — phân biệt video khác cùng tên (gửi lại). */
  fingerprint?: string;
}

export interface ClipPlacement {
  clipId: string;
  batch: number;
  /** Giây trên timeline toàn phim nơi phần dùng được của clip bắt đầu. */
  globalOffset: number;
  /** Số giây đầu clip bị bỏ vì lặp lại đuôi clip trước. */
  trimHead: number;
  effectiveDuration: number;
  /** 0..1 — khung cuối clip trước giống khung đầu clip này (sau trim). */
  continuity: number;
  overlapScore: number;
}

export interface Segment {
  segId: string; // "S0001"... bất biến, tăng dần theo timeline
  clipId: string;
  batch: number;
  localStart: number;
  localEnd: number;
  globalStart: number;
  globalEnd: number;
}

export interface TimelineBatch {
  batch: number;
  clipIds: string[];
  firstSegId: string;
  lastSegId: string;
}

export interface GlobalTimeline {
  version: 1;
  clips: ClipPlacement[];
  segments: Segment[];
  batches: TimelineBatch[];
  totalDuration: number;
  /** Hash của segments — append đợt mới phải giữ nguyên hash phần cũ. */
  checksum: string;
}

export interface TranscriptLine {
  segId: string;
  text: string;
  /** Mốc câu thoại trong FILE clip (giây) — chỉ dùng cho người viết remake/kiểm tra nhịp thoại, không gửi bước phân tích. */
  start?: number;
  end?: number;
}

export interface ClipTranscript {
  clipId: string;
  available: boolean;
  language: string | null;
  lines: TranscriptLine[];
}

// ---------- Stage 3: delta do LLM đề xuất cho 1 clip ----------

export type SegmentKind = "story" | "recap" | "credits" | "preview" | "other";

export interface SegmentDescription {
  id: string; // segId
  kind: SegmentKind;
  location?: string; // LOC_*
  characters: string[]; // CHAR_*
  action: string;
  dialogue: { speaker: string; text: string }[];
  emotion?: string;
  /** Cường độ cảm xúc khán giả cảm nhận ở shot này, 1–10. */
  intensity?: number;
  /** Phản ứng/khoảng dừng khuếch đại cảm xúc (ánh mắt giữ lâu, nghiến răng, im lặng trước khi đáp...). */
  reaction?: string;
  /** Âm thanh/nhạc: nhạc vào/tăng/giảm/dừng, im lặng, SFX nhấn — và tương quan với thoại. */
  sound?: string;
  /** Nhân vật trong shot → id bộ trang phục đang mặc (CharacterRecord.outfits), vd {"CHAR_LAN":"W2"}. */
  wardrobe?: Record<string, string>;
  camera?: string;
}

/** 1 bộ trang phục của nhân vật (id W1, W2... trong phạm vi nhân vật). */
export interface OutfitRecord {
  id: string;
  description: string;
}

export interface CharacterRecord {
  id: string; // CHAR_*
  name: string;
  description: string;
  aliases: string[];
  /**
   * Danh mục trang phục xuyên phim — để remake nói RÕ mỗi clip nhân vật mặc
   * bộ nào (ảnh tham chiếu chỉ có 1 bộ; không nói rõ thì model gen chọn ngẫu nhiên).
   */
  outfits?: OutfitRecord[];
  role?: string;
  goals?: string[];
  relations?: Record<string, string>;
  emotion?: string;
  status?: string;
  first_seg?: string;
  last_seg?: string;
}

export interface PropRecord {
  id: string; // PROP_* | OBJ_*
  type: "PROP" | "OBJECT";
  description: string;
  holder?: string;
  state?: string;
  first_seg?: string;
  last_seg?: string;
}

export interface LocationRecord {
  id: string; // LOC_*
  description: string;
}

export type EventType = "action" | "reveal" | "decision" | "conflict" | "emotion" | "relationship";

export interface StoryEvent {
  id: string; // E<clip>_<n>, vd "E03_7"
  seg_ids: string[];
  actors: string[];
  props?: string[];
  type: EventType;
  summary: string;
  caused_by?: string[];
  /** Gán bởi code khi merge. */
  clip_id?: string;
  batch?: number;
}

export interface KnowledgeFact {
  id: string; // F<clip>_<n>
  statement: string;
  is_true: boolean;
  known_by: { char_id: string; since_event: string }[];
  audience_knows_since?: string;
}

export interface StoryThread {
  id: string; // T<clip>_<n>
  question: string;
  status: "open" | "resolved";
  setup_events: string[];
  payoff_events: string[];
}

export interface Reinterpretation {
  id: string; // R<clip>_<n>
  revealed_by: string;
  affects: string[];
  old_reading: string;
  new_reading: string;
  fact_changes?: { fact_id: string; is_true: boolean }[];
}

export interface MemoryDelta {
  clip_id: string;
  clip_summary: string;
  segments: SegmentDescription[];
  new_characters?: CharacterRecord[];
  /** add_outfits: bộ trang phục MỚI của nhân vật đã có (id nối tiếp W2, W3...). */
  character_updates?: (Partial<CharacterRecord> & { id: string; add_outfits?: OutfitRecord[] })[];
  new_props?: PropRecord[];
  prop_updates?: (Partial<PropRecord> & { id: string })[];
  new_locations?: LocationRecord[];
  events: StoryEvent[];
  knowledge?: KnowledgeFact[];
  knowledge_updates?: {
    id: string;
    is_true?: boolean;
    known_by_add?: { char_id: string; since_event: string }[];
    audience_knows_since?: string;
  }[];
  thread_opens?: StoryThread[];
  thread_updates?: {
    id: string;
    add_setup_events?: string[];
    add_payoff_events?: string[];
    status?: "open" | "resolved";
  }[];
  reinterpretations?: Reinterpretation[];
}

// ---------- Stage 4: Global Story Memory (code merge) ----------

export interface ClipStoryRecord {
  clip_id: string;
  batch: number;
  summary: string;
  segments: SegmentDescription[];
}

export interface StoryMemory {
  version: 1;
  analyzed_clips: string[];
  clips: ClipStoryRecord[];
  characters: CharacterRecord[];
  props: PropRecord[];
  locations: LocationRecord[];
  events: StoryEvent[];
  knowledge: KnowledgeFact[];
  threads: StoryThread[];
  reinterpretations: Reinterpretation[];
}

// ---------- Stage 5: Story Structure (LLM, kiểm bằng code) ----------

export interface StoryScene {
  id: string; // SC<n>
  clip_id: string;
  seg_ids: string[];
  location?: string;
  summary: string;
  beats: {
    id: string; // B<n>
    event_ids: string[];
    function: string;
    emotion: string;
    intensity: number;
  }[];
}

export interface CauseEffectLink {
  cause: string; // eventId
  effect: string; // eventId
  note?: string;
}

export interface SetupPayoff {
  thread_id?: string;
  setup_events: string[];
  payoff_events: string[];
  note: string;
}

export interface StoryStructure {
  batch: number;
  scenes: StoryScene[];
  cause_effect: CauseEffectLink[];
  setup_payoff: SetupPayoff[];
  emotion_curve: { clip_id: string; intensity: number; dominant_emotion: string; note: string }[];
  twists: { event_id: string; type: string; withheld_from: string; reinterpretation_id?: string; note: string }[];
  power_shifts: { event_id: string; before: string; after: string }[];
  arcs: { char_id: string; arc: string }[];
}

// ---------- Stage 6: ánh xạ nguồn → remake ----------

export interface AdaptationMap {
  updated_after_episode: number;
  characters: { source_id: string; target_id: string | null; note?: string }[];
  props: { source_id: string; target_id: string | null; note?: string }[];
  threads: {
    source_thread_id: string;
    target_thread: string | null; // null = remake đã bỏ mạch này
    setup_episodes: number[];
    payoff_episodes: number[];
    status: "open" | "resolved" | "dropped";
    note?: string;
  }[];
}

// ---------- Hồ sơ phim ----------
//
// Hai tầng: PHIM GỐC (phân tích 1 lần, dùng chung) và các BẢN REMAKE (mỗi bản
// 1 series riêng + adaptation map riêng + yêu cầu riêng). Remake lại phim
// gốc nhiều lần KHÔNG phải phân tích lại.

/** 1 đợt nạp + phân tích phim gốc (Stage 1–5). */
export interface SourceBatch {
  batch: number;
  clipIds: string[];
  /** SỐ TẬP GỐC (theo tên file) đầu/cuối của đợt — các tập trong đợt liền nhau. */
  firstEpisode: number;
  lastEpisode: number;
  /** Đã phân tích xong (timeline + memory + structure). */
  analyzed: boolean;
}

/**
 * "replica" (mặc định): TÁI TẠO đúng video gốc — giữ nhân vật gốc, bối cảnh,
 * hành động, thoại nguyên văn ngôn ngữ gốc; ảnh tham chiếu lấy từ frame thật.
 * "faithful": giống gốc nhưng THAY nhân vật, thoại dịch tiếng Anh.
 * "transform": đổi cả thế giới, giữ chất drama.
 */
export type RemakeMode = "replica" | "faithful" | "transform";

/** 1 đợt tập của 1 bản remake (Stage 6–7). */
export interface RemakeBatch {
  firstEpisode: number;
  lastEpisode: number;
  /** Đủ tập + đã cập nhật adaptation map. */
  done: boolean;
}

export interface RemakeRecord {
  /** Tên series, vd "sinhton_remake_2" — storage/series/<name>/. */
  name: string;
  createdAt: string;
  /** Yêu cầu riêng của bản này (thể loại/bối cảnh/...) — áp cho mọi đợt của bản. */
  note?: string;
  /**
   * "source": tập remake mang SỐ TẬP GỐC (tập gốc 2 → tập remake 2), batches
   * ghi số tập gốc. Không có = bản cũ đánh số liên tục 1, 2, 3... theo thứ tự
   * phân tích — không tạo tiếp được (lệch số với cách mới).
   */
  numbering?: "source";
  /**
   * "faithful" (mặc định từ nay): video remake GIỐNG GỐC — giữ bối cảnh/hành
   * động/góc máy/nhịp, chỉ thay nhân vật, thoại dịch tiếng Anh. "transform":
   * đổi cả thế giới, giữ chất drama. Không có = bản cũ (transform).
   */
  mode?: RemakeMode;
  batches: RemakeBatch[];
}

export interface FilmRecord {
  /** 3: sourceBatches + tên file structure theo số tập gốc (2: theo vị trí/số đợt). */
  version: 3;
  filmId: string;
  createdAt: string;
  sourceBatches: SourceBatch[];
  remakes: RemakeRecord[];
}
