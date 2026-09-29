import { reviseGenerationPromptQwen } from "../src/automation/qwenAI";

/**
 * Test độc lập cho reviseGenerationPromptQwen (qwenAI.ts) — clone "check
 * prompt" dùng Qwen. KHÔNG đụng bot/queue.
 *
 * Cách dùng: npx tsx scripts/test-qwen-revise-prompt.ts "<prompt gốc>" "<lý do bị từ chối>"
 */
async function main(): Promise<void> {
  const prompt = process.argv[2];
  const violationReason = process.argv[3];
  if (!prompt || !violationReason) {
    console.error(
      'Cách dùng: npx tsx scripts/test-qwen-revise-prompt.ts "<prompt gốc>" "<lý do bị từ chối>"',
    );
    process.exit(1);
  }

  const jobId = `test-qwen-revise-${Date.now()}`;
  const revised = await reviseGenerationPromptQwen(
    prompt,
    violationReason,
    jobId,
  );
  console.log("Prompt viết lại:", revised);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
