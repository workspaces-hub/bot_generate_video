import { generateSceneImagesForFile } from "../src/automation/storyboardPipeline";

/**
 * CLI mỏng cho generateSceneImagesForFile (xem src/automation/storyboardPipeline.ts
 * — logic dùng chung với bước xử lý job "gpt" trong src/queue.ts).
 *
 * Cách dùng: npm run generate-scene-images -- <inputJsonPath>
 *
 * Yêu cầu: đã chạy npm run generate-reference-images trước đó cho CÙNG file
 * input này nếu entry SCENE_SETTING có "ref" trỏ tới CHARACTER/LOCATION —
 * ảnh ref phải tồn tại sẵn trong reference-images/<tên file input>/ để
 * upload lên làm ảnh tham chiếu.
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Cách dùng: npm run generate-scene-images -- <inputJsonPath>");
    process.exit(1);
  }

  const { outputDir, succeeded, failed } = await generateSceneImagesForFile(inputPath);
  console.log(`\nHoàn tất: ${succeeded} thành công, ${failed} lỗi. Output: ${outputDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
