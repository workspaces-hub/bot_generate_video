/**
 * So sánh 2 video (GỐC ↔ MỚI/REMAKE) theo các tiêu chí giữ "chất drama"
 * (COMPARE_CRITERIA trong src/film/compare.ts: đường cong cảm xúc, nhịp, đảo
 * chiều, cao trào, cliffhanger, che giấu/tiết lộ thông tin, nhịp dựng, âm
 * nhạc...). Gemini xem cả 2 video, chấm từng tiêu chí 0–10 → báo cáo .md + .json.
 * Cùng bước so sánh với nút "Test prompt remake phim", chạy độc lập ngoài bot.
 *
 *   npm run compare-videos -- <video_goc> <video_moi> [tuỳ chọn]
 *
 * Tuỳ chọn:
 *   --out <file.md>          nơi lưu báo cáo (mặc định: cạnh video mới, "<tên>_so_sanh.md")
 *   --episode <N>            số tập ghi trong báo cáo (mặc định 1)
 *   --script <tap.json>      JSON kịch bản remake của tập — Gemini biết ý đồ từng clip
 *   --film <tên phim>        dùng phân tích sẵn của tập gốc (storage/films/<phim>, cần --episode)
 *   --note "<yêu cầu>"       yêu cầu riêng của bản remake (chỉ ghi vào báo cáo)
 *   --reuse                  có sẵn kết quả .json thì dùng lại, không chấm lại
 *
 * Model: FILM_GEMINI_MODEL_LABEL (để trống = GEMINI_MODEL_LABEL).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getGeminiBrowserContext } from "../src/automation/geminiBrowser";
import { COMPARE_CRITERIA, compareEpisode, renderCompareReport } from "../src/film/compare";
import { episodeAnalysisSummary } from "../src/film/pipeline";
import { probeClip } from "../src/film/timeline";

function usage(message?: string): never {
  if (message) console.error(`❌ ${message}\n`);
  console.error(
    "Cách dùng: npm run compare-videos -- <video_goc> <video_moi> [--out file.md] [--episode N] [--script tap.json] [--film tenphim] [--note \"...\"] [--reuse]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "reuse") flags[key] = true;
    else if (i + 1 < argv.length) flags[key] = argv[++i];
    else usage(`Thiếu giá trị cho --${key}`);
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2) usage("Cần đúng 2 video: <video_goc> <video_moi>.");
  const [original, remake] = positional.map((p) => path.resolve(p));
  for (const v of [original, remake]) if (!fs.existsSync(v)) usage(`Không thấy file "${v}".`);

  const episode = flags.episode ? Number(flags.episode) : 1;
  if (!Number.isInteger(episode) || episode < 1) usage("--episode phải là số nguyên ≥ 1.");
  const reportPath = path.resolve(
    typeof flags.out === "string" ? flags.out : path.join(path.dirname(remake), `${path.parse(remake).name}_so_sanh.md`),
  );
  const resultPath = reportPath.replace(/\.md$/i, "") + ".json";
  if (!flags.reuse) await fsp.unlink(resultPath).catch(() => {});

  const [a, b] = await Promise.all([probeClip(original), probeClip(remake)]);
  console.log(`Video gốc : ${original} (${a.duration}s, ${a.width}x${a.height}, ${a.fps}fps)`);
  console.log(`Video mới : ${remake} (${b.duration}s, ${b.width}x${b.height}, ${b.fps}fps)`);

  // Tài liệu tham khảo (tuỳ chọn): kịch bản remake + phân tích sẵn của tập gốc.
  let remakeScript: unknown;
  if (typeof flags.script === "string") {
    const entries = JSON.parse(await fsp.readFile(flags.script, "utf-8")) as { type?: string; id?: string; duration?: number; prompt?: string }[];
    remakeScript = entries
      .filter((e) => e.type === "VIDEO")
      .map((e) => ({ id: e.id, duration: e.duration, prompt: (e.prompt ?? "").slice(0, 500) }));
  }
  let originalAnalysis: unknown;
  if (typeof flags.film === "string") {
    originalAnalysis = await episodeAnalysisSummary(flags.film, episode);
    if (!originalAnalysis) console.warn(`⚠️ Phim "${flags.film}" chưa có phân tích tập ${episode} — bỏ qua phân tích sẵn.`);
  }

  console.log(`\nĐang nhờ Gemini so sánh theo ${COMPARE_CRITERIA.length} tiêu chí (mở trình duyệt, upload 2 video)...`);
  const result = await compareEpisode({
    jobId: `compare-${randomUUID().slice(0, 8)}`,
    episode,
    originalVideo: original,
    remakeVideo: remake,
    originalAnalysis,
    remakeScript,
    outPath: resultPath,
    onStatus: async (text) => console.log(text),
  });

  const report = renderCompareReport({
    filmId: path.parse(original).name,
    remakeName: path.parse(remake).name,
    note: typeof flags.note === "string" ? flags.note : undefined,
    results: [result],
  });
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, report, "utf-8");

  const weak = [...result.criteria].sort((x, y) => x.score - y.score).slice(0, 5);
  const name = (id: string) => COMPARE_CRITERIA.find((c) => c.id === id)?.name ?? id;
  console.log(`\n✅ Điểm tổng: ${result.overall_score}/100 — ${result.summary}`);
  console.log(`Yếu nhất: ${weak.map((c) => `${name(c.id)} ${c.score}/10`).join(", ")}`);
  console.log(`\nBáo cáo: ${reportPath}\nJSON   : ${resultPath}`);
  await getGeminiBrowserContext.close();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await getGeminiBrowserContext.close().catch(() => {});
  process.exit(1);
});
