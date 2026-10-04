import { askChatAIAboutReferenceVideo } from "../src/automation/chatAI";
import { config } from "../src/config";

/**
 * Test độc lập cho askChatAIAboutReferenceVideo (chatAI.ts) — bản ChatGPT
 * (KHÁC askQwenAboutReferenceVideo bên qwenAI.ts, dùng OpenRouter) của tính
 * năng "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL/SCRIPT_REFERENCE_
 * BUTTON_LABEL) — gọi thẳng browser automation thật (cần session đã đăng
 * nhập, xem `npm run login-chatai`), KHÔNG đụng tới bot/queue.
 *
 * Dùng để đối chiếu log chẩn đoán mới (model/reasoning effort, đối chiếu
 * prompt dán vào ô nhập, xác nhận attachment trong composer, ls -lh/
 * sha256sum/ffprobe video) giữa các môi trường (local vs VPS) với ĐÚNG
 * đường upload VIDEO thật — khác test-chatai.ts (chỉ test prompt text
 * thuần, không exercise được nhánh ffprobe/attachment nhị phân).
 *
 * Cách dùng:
 *   npx tsx scripts/test-chatai-video-reference.ts <đường-dẫn-video.mp4> [master-prompt-path] [extra-instruction]
 *
 * master-prompt-path mặc định config.promptSplitVideo (chia SHOT/CLIP theo
 * diễn biến) — truyền prompt_video_reference.txt để test nhánh "chỉ gen 1
 * VIDEO duy nhất" thay vì chia nhỏ.
 */
async function main(): Promise<void> {
  const videoPath = 'test2.mp4';
  const masterPromptPath = config.promptVideoReference
  const extraInstruction = undefined;

  if (!videoPath) {
    console.error(
      "Cách dùng: npx tsx scripts/test-chatai-video-reference.ts <đường-dẫn-video.mp4> [master-prompt-path] [extra-instruction]",
    );
    process.exit(1);
  }

  const jobId = `test-chatai-video-ref-${Date.now()}`;
  console.log(
    `[test-chatai-video-reference] jobId=${jobId}, videoPath=${videoPath}, masterPromptPath=${masterPromptPath}, extraInstruction=${extraInstruction ?? "(không có)"}`,
  );

  const result = await askChatAIAboutReferenceVideo(
    videoPath,
    jobId,
    videoPath.split("/").pop(),
    extraInstruction,
    masterPromptPath,
  );

  console.log("Kết quả:", result);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
