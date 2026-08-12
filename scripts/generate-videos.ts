import { generateVideosForFile } from "../src/automation/storyboardPipeline";

/**
 * CLI mỏng cho generateVideosForFile (xem src/automation/storyboardPipeline.ts
 * — logic dùng chung với bước xử lý job "gpt" trong src/queue.ts).
 *
 * Cách dùng: npm run generate-videos -- <inputJsonPath>
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Cách dùng: npm run generate-videos -- <inputJsonPath>");
    process.exit(1);
  }

  const { outputDir, succeeded, failed } = await generateVideosForFile(inputPath);
  console.log(`\nHoàn tất: ${succeeded} thành công, ${failed} lỗi. Output: ${outputDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
