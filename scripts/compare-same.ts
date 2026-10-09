/**
 * So sánh 2 video có GIỐNG NHAU không về KỊCH BẢN, HÀNH ĐỘNG NHÂN VẬT và LỜI
 * THOẠI — nhân vật được phép là người khác, thoại được phép khác ngôn ngữ (so
 * theo nghĩa). Gemini xem cả 2 video + thoại Whisper (có mốc giây, nếu đã cài
 * faster-whisper) → báo cáo .md + .json: điểm từng mặt, ghép cặp nhân vật,
 * đối chiếu từng beat (khớp / lệch / thiếu / thêm) kèm mốc mm:ss.
 *
 *   npm run compare-same -- <video_goc> <video_moi> [--out file.md] [--reuse] [--no-whisper]
 *
 * Model: FILM_GEMINI_MODEL_LABEL (để trống = GEMINI_MODEL_LABEL).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getGeminiBrowserContext } from "../src/automation/geminiBrowser";
import { compareSameVideos, renderSameReport } from "../src/film/compareSame";
import { probeClip, transcribeFile } from "../src/film/timeline";

function usage(message?: string): never {
  if (message) console.error(`❌ ${message}\n`);
  console.error("Cách dùng: npm run compare-same -- <video_goc> <video_moi> [--out file.md] [--reuse] [--no-whisper]");
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  console.log("🚀 ~ main ~ argv:", argv)
  const flags = new Set(argv.filter((a) => a === "--reuse" || a === "--no-whisper"));
  const outIdx = argv.indexOf("--out");
  // Bỏ cờ và giá trị đi sau "--out" (chỉ khi có "--out" — indexOf = -1 thì không bỏ gì).
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));
  if (positional.length !== 2) usage("Cần đúng 2 video: <video_goc> <video_moi>.");
  const [original, remake] = positional.map((p) => path.resolve(p));
  for (const v of [original, remake]) if (!fs.existsSync(v)) usage(`Không thấy file "${v}".`);
  const reportPath = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(path.dirname(remake), `${path.parse(remake).name}_giong_goc.md`));
  const resultPath = reportPath.replace(/\.md$/i, "") + ".json";
  if (!flags.has("--reuse")) await fsp.unlink(resultPath).catch(() => {});

  const [a, b] = await Promise.all([probeClip(original), probeClip(remake)]);
  console.log(`Video gốc: ${original} (${a.duration}s)`);
  console.log(`Video mới: ${remake} (${b.duration}s)`);

  // Thoại có mốc giây cho cả 2 video — căn cứ đối chiếu câu thoại + thời điểm nói.
  const speech = async (file: string) => {
    if (flags.has("--no-whisper")) return null;
    const t = await transcribeFile(file);
    return t.available ? { language: t.language, lines: t.segments.map((s) => ({ t: `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`, text: s.text })) } : null;
  };
  console.log("Nhận dạng thoại (Whisper, nếu có)...");
  const [speechA, speechB] = [await speech(original), await speech(remake)];
  console.log(`  gốc: ${speechA ? `${speechA.lines.length} câu (${speechA.language})` : "không có"} | mới: ${speechB ? `${speechB.lines.length} câu (${speechB.language})` : "không có"}`);

  console.log("Đang nhờ Gemini so sánh (mở trình duyệt, upload 2 video)...");
  const result = await compareSameVideos({
    jobId: `same-${randomUUID().slice(0, 8)}`,
    originalVideo: original,
    newVideo: remake,
    facts: {
      video_goc: { duration_s: a.duration, thoai_whisper: speechA ?? "không có" },
      video_moi: { duration_s: b.duration, thoai_whisper: speechB ?? "không có" },
    },
    outPath: resultPath,
    onStatus: async (text) => console.log(text),
  });

  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, renderSameReport({ original: path.basename(original), remake: path.basename(remake), result }), "utf-8");
  const c = (s: string) => result.timeline.filter((t) => t.status === s).length;
  console.log(`\n${result.verdict.toUpperCase()} — ${result.overall_match}/100`);
  console.log(`Kịch bản ${result.story.score}/10 · Hành động ${result.actions.score}/10 · Lời thoại ${result.dialogue.score}/10`);
  console.log(`Beat: ✅ ${c("khớp")} khớp · ⚠️ ${c("lệch")} lệch · ❌ ${c("thiếu")} thiếu · ➕ ${c("thêm")} thêm`);
  console.log(`\nBáo cáo: ${reportPath}\nJSON   : ${resultPath}`);
  await getGeminiBrowserContext.close();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await getGeminiBrowserContext.close().catch(() => {});
  process.exit(1);
});
