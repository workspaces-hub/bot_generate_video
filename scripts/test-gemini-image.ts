/**
 * Chạy thử generateImageGemini ngoài bot — ảnh tải về config.downloadDir (storage/downloads/<jobId>.<đuôi>).
 *
 *   npx tsx scripts/test-gemini-image.ts "<prompt>" [--ref <ảnh tham chiếu> ...]
 */
import { randomUUID } from "node:crypto";
import { generateImageGemini } from "../src/automation/geminiImage";
import { getGeminiImageBrowserContext } from "../src/automation/geminiBrowser";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refs: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref") refs.push(args[++i]);
    else words.push(args[i]);
  }
  const prompt =
    words.join(" ") ||
    "A cozy wooden cabin in a snowy pine forest at dusk, warm light in the windows, cinematic.";
  const jobId = `test-gemini-image-${randomUUID().slice(0, 8)}`;
  const result = await generateImageGemini(prompt, jobId, refs);
  console.log("Kết quả:", result);
  await getGeminiImageBrowserContext.close();
}

main().catch(async (err) => {
  console.error(err);
  await getGeminiImageBrowserContext.close().catch(() => {});
  process.exit(1);
});
