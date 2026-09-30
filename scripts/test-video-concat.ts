import fs from "node:fs";
import path from "node:path";
import { concatVideos } from "../src/automation/videoConcat";

/**
 * CLI test cho concatVideos (src/automation/videoConcat.ts) — ghép TẤT CẢ
 * file .mp4 trong 1 folder lại thành 1 video duy nhất, theo thứ tự TÊN FILE
 * (sort kiểu numeric — "clip2" đứng trước "clip10", không phải sort chuỗi
 * thuần "clip10" trước "clip2").
 *
 * Cách dùng:
 *   npx tsx scripts/test-video-concat.ts <folder> [outputPath]
 *
 * outputPath mặc định: <folder>/_concat-test-output.mp4 — tự loại file này
 * (nếu đã tồn tại từ lần chạy trước, hoặc trùng tên outputPath được truyền
 * vào) ra khỏi danh sách input, tránh ghép nhầm output của chính nó vào lượt
 * chạy sau.
 */
async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) {
    console.error(
      "Cách dùng: npx tsx scripts/test-video-concat.ts <folder> [outputPath]",
    );
    process.exit(1);
  }

  const outputPath = path.resolve(
    process.argv[3] ?? path.join(folder, "_concat-test-output.mp4"),
  );
  const outputBaseName = path.basename(outputPath);

  const files = (await fs.promises.readdir(folder))
    .filter(
      (f) =>
        f.toLowerCase().endsWith(".mp4") && f !== outputBaseName,
    )
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((f) => path.join(folder, f));

  if (files.length === 0) {
    console.error(`Không tìm thấy file .mp4 nào trong "${folder}".`);
    process.exit(1);
  }

  console.log(`Tìm thấy ${files.length} video, theo thứ tự sẽ ghép:`);
  for (const f of files) console.log(`  - ${path.basename(f)}`);

  console.log(`\nĐang ghép -> ${outputPath} ...`);
  const t0 = Date.now();
  await concatVideos(files, outputPath);
  console.log(`\nXong sau ${Date.now() - t0}ms.`);
  const stat = await fs.promises.stat(outputPath);
  console.log(`Output: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
