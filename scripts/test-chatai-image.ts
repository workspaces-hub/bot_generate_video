import { generateReferenceImage } from "../src/automation/chatAIImage";
import { config } from "../src/config";

async function main(): Promise<void> {
  const result = await generateReferenceImage(
    "a small red bicycle leaning against a brick wall, morning light",
    config.debugDir,
    "test-chatai-image-e2e",
    "test-chatai-image-e2e",
  );
  console.log("OK, đã tải về:", result.path, "sessionId:", result.sessionId);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
