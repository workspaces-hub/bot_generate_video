/**
 * Chạy thử askGemini/askGeminiAboutReferenceVideo ngoài bot — dùng để kiểm tra
 * selector Gemini (geminiSelectors.ts) trên tài khoản thật. Mỗi lượt chụp
 * debug vào storage/debug/<jobId>_gemini-*.html/png.
 *
 *   npx tsx scripts/test-gemini.ts "<prompt>"
 *   npx tsx scripts/test-gemini.ts --video <đường dẫn video> [--prompt-file <master prompt>] [caption]
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../src/config";
import { askGemini, askGeminiAboutReferenceVideo } from "../src/automation/geminiAI";
import { getGeminiBrowserContext } from "../src/automation/geminiBrowser";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jobId = `test-gemini-${randomUUID().slice(0, 8)}`;
  const videoIdx = args.indexOf("--video");
  let result: { downloadedFiles: string[] };
  if (videoIdx >= 0) {
    const videoPath = args[videoIdx + 1];
    const promptIdx = args.indexOf("--prompt-file");
    const masterPromptPath =
      promptIdx >= 0 ? args[promptIdx + 1] : config.promptVideoReference;
    const rest = args.filter(
      (_, i) => ![videoIdx, videoIdx + 1, promptIdx, promptIdx + 1].includes(i),
    );
    result = await askGeminiAboutReferenceVideo(
      videoPath,
      jobId,
      path.basename(videoPath),
      rest.join(" ") || undefined,
      masterPromptPath,
    );
  } else {
    const prompt =
      args.join(" ") ||
      'Trả về JSON array gồm 5 object {"id": số, "name": tên một loại trái cây}.';
    result = await askGemini(prompt, jobId, `${jobId}.txt`);
  }
  console.log("Kết quả:", result);
  await getGeminiBrowserContext.close();
}

main().catch(async (err) => {
  console.error(err);
  await getGeminiBrowserContext.close().catch(() => {});
  process.exit(1);
});
