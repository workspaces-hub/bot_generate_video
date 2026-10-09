/**
 * So sánh 2 video có GIỐNG NHAU không về kịch bản, hành động nhân vật và lời
 * thoại — nhân vật được phép là người khác, thoại được phép khác ngôn ngữ
 * (so theo NGHĨA). Gemini xem cả 2 video (+ thoại Whisper có mốc giây nếu
 * có) → JSON (code kiểm tra) → báo cáo Markdown. Dùng bởi scripts/compare-same.ts.
 */
import { config } from "../config";
import { jsonSection, runFilmStage } from "./llm";

export type SameStatus = "khớp" | "lệch" | "thiếu" | "thêm";
const STATUSES: SameStatus[] = ["khớp", "lệch", "thiếu", "thêm"];
const ASPECTS = ["story", "action", "dialogue"] as const;
const VERDICTS = ["giống", "gần giống", "khác"] as const;

export interface SameAspect {
  score: number;
  summary: string;
}

export interface SameResult {
  overall_match: number;
  verdict: (typeof VERDICTS)[number];
  summary: string;
  character_mapping: { original: string; remake: string; note?: string }[];
  story: SameAspect;
  actions: SameAspect;
  dialogue: SameAspect;
  timeline: {
    aspect: (typeof ASPECTS)[number];
    status: SameStatus;
    original_time: string;
    remake_time: string;
    original: string;
    remake: string;
    note?: string;
  }[];
  top_differences: string[];
}

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const clean = (t: unknown): string =>
  typeof t === "string" ? t.replace(/\[cite[^\]]*\]/gi, " ").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim() : "";

function normalize(raw: unknown): SameResult {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<SameResult>;
  const aspect = (a: Partial<SameAspect> | undefined): SameAspect => ({ score: Number(a?.score), summary: clean(a?.summary) });
  return {
    overall_match: Number(r.overall_match),
    verdict: r.verdict as SameResult["verdict"],
    summary: clean(r.summary),
    character_mapping: arr(r.character_mapping).map((c) => ({ original: clean(c.original), remake: clean(c.remake), note: clean(c.note) })),
    story: aspect(r.story),
    actions: aspect(r.actions),
    dialogue: aspect(r.dialogue),
    timeline: arr(r.timeline).map((t) => ({
      ...t,
      original_time: clean(t.original_time),
      remake_time: clean(t.remake_time),
      original: clean(t.original),
      remake: clean(t.remake),
      note: clean(t.note),
    })),
    top_differences: arr(r.top_differences).map(clean).filter(Boolean),
  };
}

function validate(r: SameResult): string[] {
  const errors: string[] = [];
  if (!(r.overall_match >= 0 && r.overall_match <= 100)) errors.push("overall_match phải là số 0–100");
  if (!VERDICTS.includes(r.verdict)) errors.push(`verdict phải là một trong ${VERDICTS.join(" | ")}`);
  if (!r.summary) errors.push("summary trống");
  for (const [name, a] of [["story", r.story], ["actions", r.actions], ["dialogue", r.dialogue]] as const) {
    if (!(a.score >= 0 && a.score <= 10)) errors.push(`${name}.score phải là số 0–10`);
    if (!a.summary) errors.push(`${name}.summary trống`);
  }
  if (r.timeline.length === 0) errors.push("timeline trống — phải đối chiếu từng beat của video gốc");
  r.timeline.forEach((t, i) => {
    if (!STATUSES.includes(t.status)) errors.push(`timeline[${i}].status phải là một trong ${STATUSES.join(" | ")}`);
    if (!ASPECTS.includes(t.aspect)) errors.push(`timeline[${i}].aspect phải là story | action | dialogue`);
    if (t.status !== "thêm" && !t.original) errors.push(`timeline[${i}]: thiếu mô tả beat gốc`);
    if (t.status !== "thiếu" && !t.remake) errors.push(`timeline[${i}]: thiếu mô tả beat video mới`);
  });
  return errors;
}

export async function compareSameVideos(opts: {
  jobId: string;
  originalVideo: string;
  newVideo: string;
  /** Thông số + thoại Whisper 2 video (tuỳ chọn) — đưa vào file .txt. */
  facts: unknown;
  outPath: string;
  onStatus?: (text: string) => Promise<void>;
}): Promise<SameResult> {
  return runFilmStage({
    jobId: opts.jobId,
    name: "compare_same",
    label: "So sánh 2 video: kịch bản, hành động, lời thoại",
    promptPath: config.promptFilmCompareSame,
    context: [
      "## HAI VIDEO\nVideo đính kèm thứ NHẤT = VIDEO GỐC, thứ HAI = VIDEO MỚI.",
      jsonSection("THÔNG SỐ + THOẠI NHẬN DẠNG TỰ ĐỘNG (Whisper, có thể sai chữ — đối chiếu với âm thanh)", opts.facts),
    ].join(""),
    videoPath: opts.originalVideo,
    extraVideoPaths: [opts.newVideo],
    outPath: opts.outPath,
    parse: normalize,
    validate,
    onStatus: opts.onStatus,
  });
}

const STATUS_ICON: Record<SameStatus, string> = { khớp: "✅", lệch: "⚠️", thiếu: "❌", thêm: "➕" };
const ASPECT_NAME = { story: "Kịch bản", action: "Hành động", dialogue: "Lời thoại" } as const;

export function renderSameReport(opts: { original: string; remake: string; result: SameResult }): string {
  const { result: r } = opts;
  const count = (s: SameStatus, a?: string) => r.timeline.filter((t) => t.status === s && (!a || t.aspect === a)).length;
  const lines = [
    `# So sánh: ${opts.original} ↔ ${opts.remake}`,
    "",
    `**${r.verdict.toUpperCase()} — ${r.overall_match}/100**`,
    "",
    r.summary,
    "",
    "| Mặt | Điểm | ✅ khớp | ⚠️ lệch | ❌ thiếu | ➕ thêm | Nhận xét |",
    "|---|---|---|---|---|---|---|",
    ...([["story", r.story], ["action", r.actions], ["dialogue", r.dialogue]] as const).map(
      ([key, a]) =>
        `| ${ASPECT_NAME[key]} | ${a.score}/10 | ${count("khớp", key)} | ${count("lệch", key)} | ${count("thiếu", key)} | ${count("thêm", key)} | ${a.summary} |`,
    ),
    "",
  ];
  if (r.character_mapping.length > 0) {
    lines.push("## Ghép cặp nhân vật", "", "| Video gốc | Video mới | Ghi chú |", "|---|---|---|");
    for (const c of r.character_mapping) lines.push(`| ${c.original} | ${c.remake} | ${c.note ?? ""} |`);
    lines.push("");
  }
  if (r.top_differences.length > 0) {
    lines.push("## Khác biệt quan trọng nhất", ...r.top_differences.map((d, i) => `${i + 1}. ${d}`), "");
  }
  lines.push("## Đối chiếu từng beat", "", "| | Mặt | Gốc | Nội dung gốc | Mới | Nội dung mới | Ghi chú |", "|---|---|---|---|---|---|---|");
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
  for (const t of r.timeline) {
    lines.push(
      `| ${STATUS_ICON[t.status]} ${t.status} | ${ASPECT_NAME[t.aspect]} | ${t.original_time} | ${cell(t.original)} | ${t.remake_time} | ${cell(t.remake)} | ${cell(t.note ?? "")} |`,
    );
  }
  return lines.join("\n");
}
