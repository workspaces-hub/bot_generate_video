import { askQwenAboutReferenceVideo } from "../src/automation/qwenAI";

/**
 * Test độc lập cho askQwenAboutReferenceVideo (qwenAI.ts) — gọi thẳng API
 * OpenRouter, KHÔNG đụng tới bot/queue/browser automation. Dùng để kiểm tra
 * model slug (config.qwenOmniModel/QWEN_OPENROUTER_MODEL), API key
 * (OPENROUTER_API_KEY) và giới hạn kích thước video (base64 inline) trước
 * khi wire vào luồng thật.
 *
 * Cách dùng: npx tsx scripts/test-qwen-omni.ts <đường-dẫn-video.mp4> [master-prompt-path]
 */
async function main(): Promise<void> {
  const videoPath = 'video_3.mp4'
  const masterPromptPath = 'prompt_video_reference.txt'
  if (!videoPath) {
    console.error(
      "Cách dùng: npx tsx scripts/test-qwen-omni.ts <đường-dẫn-video.mp4> [master-prompt-path]",
    );
    process.exit(1);
  }

  const jobId = `test-qwen-${Date.now()}`;
  const result = await askQwenAboutReferenceVideo(
    videoPath,
    jobId,
    videoPath.split("/").pop(),
    undefined,
    masterPromptPath,
  );
  console.log("Kết quả:", result);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
