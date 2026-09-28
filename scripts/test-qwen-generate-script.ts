import { askQwen } from "../src/automation/qwenAI";

/**
 * Test độc lập cho askQwen (qwenAI.ts) — dùng chung cho "chatAI" và "Tạo
 * kịch bản mới" (xem docstring askQwen). KHÔNG đụng bot/queue.
 *
 * Cách dùng: npx tsx scripts/test-qwen-generate-script.ts <prompt-text> [đường-dẫn-file-đính-kèm]
 */
async function main(): Promise<void> {
  const prompt = 'Thực hiện yêu cầu trong file';
  const attachmentPath = './beggar.txt';
  if (!prompt) {
    console.error(
      "Cách dùng: npx tsx scripts/test-qwen-generate-script.ts <prompt-text> [đường-dẫn-file-đính-kèm]",
    );
    process.exit(1);
  }

  const jobId = `test-qwen-generate-${Date.now()}`;
  const result = await askQwen(
    prompt,
    jobId,
    attachmentPath?.split("/").pop(),
    attachmentPath,
  );
  console.log("Kết quả:", result);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
