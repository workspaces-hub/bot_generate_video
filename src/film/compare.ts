/**
 * "Test prompt remake phim" — bước cuối: Gemini xem VIDEO GỐC + VIDEO REMAKE
 * (đã gen + ghép) của cùng 1 tập, chấm mức giữ lại "chất drama" theo từng
 * tiêu chí trong COMPARE_CRITERIA. Kết quả JSON (code kiểm đủ tiêu chí + điểm
 * hợp lệ) → báo cáo Markdown gửi user.
 *
 * Danh sách tiêu chí nằm ở code (không ở prompt) để validate khớp đúng — sửa
 * tiêu chí thì sửa mảng dưới đây.
 */
import { config } from "../config";
import { jsonSection, runFilmStage } from "./llm";

export const COMPARE_CRITERIA = [
  { id: "emotion_curve", name: "Đường cong cảm xúc", what: "người xem cảm thấy gì ở từng thời điểm" },
  { id: "emotion_intensity", name: "Cường độ cảm xúc", what: "mức độ mạnh/yếu của từng cảm xúc ở từng thời điểm" },
  { id: "emotion_rhythm", name: "Nhịp cảm xúc", what: "căng thẳng → thư giãn → căng hơn → bùng nổ → giải tỏa..." },
  { id: "scene_function", name: "Chức năng của từng cảnh", what: "gây tò mò, tạo xung đột, tăng bất công, tạo hy vọng, phá hy vọng, đảo chiều, giải tỏa..." },
  { id: "story_structure", name: "Cấu trúc câu chuyện", what: "thứ tự các giai đoạn lớn của câu chuyện" },
  { id: "hook_positions", name: "Vị trí điểm thu hút người xem", what: "thời điểm xuất hiện sự kiện/thông tin khiến người xem muốn xem tiếp" },
  { id: "conflict_escalation", name: "Vị trí và nhịp tăng xung đột", what: "khi nào xung đột xuất hiện, khi nào tăng cấp, tăng mạnh đến mức nào" },
  { id: "reversals", name: "Vị trí các cú đảo chiều", what: "thời điểm tình thế, thông tin hoặc cán cân quyền lực thay đổi" },
  { id: "climax", name: "Vị trí cao trào", what: "thời điểm cảm xúc/xung đột đạt đỉnh" },
  { id: "segment_cliffhanger", name: "Tình tiết gây tò mò cuối đoạn", what: "thời điểm tạo câu hỏi hoặc biến cố khiến người xem muốn xem tiếp" },
  { id: "information_control", name: "Che giấu và tiết lộ thông tin", what: "người xem biết gì, từng nhân vật biết gì, thông tin nào bị giấu và khi nào được tiết lộ" },
  { id: "power_relations", name: "Quan hệ quyền lực giữa các vai", what: "ai mạnh, ai yếu, ai kiểm soát tình thế, cán cân thay đổi thế nào" },
  { id: "protagonist_pressure", name: "Tăng khó khăn cho nhân vật chính", what: "vấn đề ngày càng nghiêm trọng thế nào trước khi được giải quyết" },
  { id: "emotion_buildup", name: "Cách tích tụ cảm xúc", what: "tức giận, lo lắng, tò mò, thương cảm... được tích tụ trong bao lâu, bằng nhịp nào" },
  { id: "emotional_payoff", name: "Cách trả thưởng cảm xúc", what: "thời điểm và cách người xem được hả hê, thỏa mãn, xúc động, bất ngờ hoặc giải tỏa" },
  { id: "narrative_pacing", name: "Nhịp kể chuyện", what: "đoạn nào nhanh, đoạn nào chậm, khi nào tăng tốc, khi nào cho người xem nghỉ" },
  { id: "scene_length_ratio", name: "Độ dài tương đối của từng cảnh", what: "cảnh nào ngắn, cảnh nào dài, tỷ lệ thời lượng giữa các loại cảnh" },
  { id: "event_density", name: "Mật độ sự kiện", what: "bao lâu xuất hiện một hành động, biến cố hoặc thay đổi mới" },
  { id: "conflict_density", name: "Mật độ xung đột", what: "tần suất va chạm, trở ngại hoặc đối đầu" },
  { id: "information_density", name: "Mật độ thông tin mới", what: "bao lâu người xem nhận được thông tin, manh mối, bí mật hoặc phát hiện mới" },
  { id: "dialogue_action_ratio", name: "Tỷ lệ thoại và hành động", what: "bao nhiêu phần truyện kể bằng lời thoại so với hành động/hình ảnh" },
  { id: "reaction_style", name: "Kiểu phản ứng của nhân vật", what: "phản ứng, biểu cảm, khoảng dừng được dùng để khuếch đại cảm xúc" },
  { id: "cinematic_language", name: "Ngôn ngữ điện ảnh tổng quát", what: "cận/trung/toàn cảnh, chuyển động máy, cách nhấn khoảnh khắc quan trọng" },
  { id: "editing_rhythm", name: "Nhịp dựng", what: "tần suất cắt cảnh, thời gian giữ khuôn hình, tốc độ chuyển cảnh" },
  { id: "sound_music", name: "Âm thanh và âm nhạc", what: "nhạc bắt đầu, tăng, giảm, dừng khi nào; âm thanh hỗ trợ cảm xúc thế nào" },
  { id: "episode_ending", name: "Cách kết thúc đoạn/tập", what: "câu hỏi, biến cố, bí mật hoặc tình huống chưa giải quyết kéo người xem sang phần sau" },
] as const;

export type CriterionVerdict = "giữ được" | "lệch một phần" | "mất";

export interface CompareResult {
  episode: number;
  /** 0–100: trung bình có trọng số do Gemini đánh giá tổng thể. */
  overall_score: number;
  summary: string;
  criteria: {
    id: string;
    score: number; // 0–10
    verdict: CriterionVerdict;
    original: string;
    remake: string;
    fix: string;
  }[];
  top_fixes: string[];
}

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const VERDICTS: CriterionVerdict[] = ["giữ được", "lệch một phần", "mất"];

/** Bỏ chú thích trích dẫn Gemini tự chèn ("[cite: 1, 2]", "[cite_start]"). */
function clean(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\[cite[^\]]*\]/gi, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalize(raw: unknown, episode: number): CompareResult {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<CompareResult>;
  return {
    episode,
    overall_score: Number(r.overall_score),
    summary: clean(r.summary),
    criteria: arr(r.criteria).map((c) => ({
      ...c,
      score: Number(c.score),
      original: clean(c.original),
      remake: clean(c.remake),
      fix: clean(c.fix),
    })),
    top_fixes: arr(r.top_fixes).map(clean).filter(Boolean),
  };
}

function validate(r: CompareResult): string[] {
  const errors: string[] = [];
  if (!(r.overall_score >= 0 && r.overall_score <= 100)) errors.push("overall_score phải là số 0–100");
  if (!r.summary.trim()) errors.push("summary trống");
  const byId = new Map(r.criteria.map((c) => [c.id, c]));
  for (const c of COMPARE_CRITERIA) {
    const got = byId.get(c.id);
    if (!got) {
      errors.push(`thiếu tiêu chí "${c.id}" (${c.name})`);
      continue;
    }
    if (!(got.score >= 0 && got.score <= 10)) errors.push(`${c.id}: score phải là số 0–10`);
    if (!VERDICTS.includes(got.verdict)) errors.push(`${c.id}: verdict phải là một trong ${VERDICTS.join(" | ")}`);
    if (!got.original?.trim() || !got.remake?.trim()) errors.push(`${c.id}: thiếu mô tả original/remake`);
  }
  const known = new Set<string>(COMPARE_CRITERIA.map((c) => c.id));
  for (const c of r.criteria) if (!known.has(c.id)) errors.push(`tiêu chí lạ "${c.id}"`);
  return errors;
}

/** So sánh video gốc ↔ video remake của 1 tập (Gemini xem cả 2 video). */
export async function compareEpisode(opts: {
  jobId: string;
  episode: number;
  originalVideo: string;
  remakeVideo: string;
  /** Phân tích sẵn của tập gốc (scene/beat/cảm xúc) — tham khảo, không thay thế việc xem video. Không có thì bỏ qua. */
  originalAnalysis?: unknown;
  /** Tóm tắt kịch bản remake của tập (để biết ý đồ từng clip). Không có thì bỏ qua. */
  remakeScript?: unknown;
  outPath: string;
  onStatus?: (text: string) => Promise<void>;
}): Promise<CompareResult> {
  const context = [
    `## TẬP ĐANG SO SÁNH\nTập ${opts.episode}. Video đính kèm thứ NHẤT = VIDEO GỐC, thứ HAI = VIDEO REMAKE (do AI tạo theo kịch bản remake, đã ghép đủ các clip).`,
    jsonSection(
      `TIÊU CHÍ (${COMPARE_CRITERIA.length} — chấm ĐỦ TẤT CẢ, dùng đúng "id")`,
      COMPARE_CRITERIA.map((c) => ({ id: c.id, name: c.name, cần_đánh_giá: c.what })),
    ),
    opts.originalAnalysis != null
      ? jsonSection("PHÂN TÍCH SẴN CỦA TẬP GỐC (tham khảo — vẫn phải tự xem video)", opts.originalAnalysis)
      : "",
    opts.remakeScript != null
      ? jsonSection("KỊCH BẢN REMAKE CỦA TẬP (ý đồ từng clip — đánh giá theo video THẬT đã tạo, không theo ý đồ)", opts.remakeScript)
      : "",
  ].join("");
  return runFilmStage({
    jobId: opts.jobId,
    name: `compare_tap${opts.episode}`,
    label: `[test] So sánh video gốc ↔ remake tập ${opts.episode} (${COMPARE_CRITERIA.length} tiêu chí)`,
    promptPath: config.promptFilmCompare,
    context,
    videoPath: opts.originalVideo,
    extraVideoPaths: [opts.remakeVideo],
    outPath: opts.outPath,
    parse: (raw) => normalize(raw, opts.episode),
    validate,
    onStatus: opts.onStatus,
  });
}

const VERDICT_ICON: Record<CriterionVerdict, string> = { "giữ được": "✅", "lệch một phần": "⚠️", mất: "❌" };

/** Báo cáo Markdown cho user — 1 file gộp mọi tập đã test. */
export function renderCompareReport(opts: {
  filmId: string;
  remakeName: string;
  note?: string;
  results: CompareResult[];
}): string {
  const lines: string[] = [
    `# So sánh video gốc ↔ remake — ${opts.filmId} → ${opts.remakeName}`,
    "",
    opts.note ? `Yêu cầu riêng của bản remake: ${opts.note}\n` : "",
  ];
  if (opts.results.length > 1) {
    const avg = Math.round(opts.results.reduce((s, r) => s + r.overall_score, 0) / opts.results.length);
    lines.push(`**Điểm trung bình: ${avg}/100** (${opts.results.map((r) => `tập ${r.episode}: ${r.overall_score}`).join(", ")})`, "");
    // Tiêu chí yếu nhất trên mọi tập — chỗ prompt cần sửa trước.
    const weakest = COMPARE_CRITERIA.map((c) => ({
      c,
      avg: opts.results.reduce((s, r) => s + (r.criteria.find((x) => x.id === c.id)?.score ?? 0), 0) / opts.results.length,
    }))
      .sort((a, b) => a.avg - b.avg)
      .slice(0, 5);
    lines.push("**Tiêu chí yếu nhất (trung bình các tập):** " + weakest.map((w) => `${w.c.name} ${w.avg.toFixed(1)}/10`).join(", "), "");
  }
  for (const r of opts.results) {
    lines.push(`## Tập ${r.episode} — ${r.overall_score}/100`, "", r.summary, "");
    const counts = VERDICTS.map((v) => `${VERDICT_ICON[v]} ${v}: ${r.criteria.filter((c) => c.verdict === v).length}`);
    lines.push(counts.join(" · "), "");
    lines.push("| # | Tiêu chí | Điểm | Kết luận |", "|---|---|---|---|");
    COMPARE_CRITERIA.forEach((c, i) => {
      const got = r.criteria.find((x) => x.id === c.id)!;
      lines.push(`| ${i + 1} | ${c.name} | ${got.score}/10 | ${VERDICT_ICON[got.verdict]} ${got.verdict} |`);
    });
    lines.push("", "### Ưu tiên sửa", ...r.top_fixes.map((f, i) => `${i + 1}. ${f}`), "", "### Chi tiết từng tiêu chí", "");
    for (const c of COMPARE_CRITERIA) {
      const got = r.criteria.find((x) => x.id === c.id)!;
      lines.push(
        `#### ${VERDICT_ICON[got.verdict]} ${c.name} — ${got.score}/10`,
        `- **Video gốc:** ${got.original}`,
        `- **Video remake:** ${got.remake}`,
        ...(got.fix?.trim() ? [`- **Cách sửa:** ${got.fix}`] : []),
        "",
      );
    }
  }
  return lines.join("\n");
}
