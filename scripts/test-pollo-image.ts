import { generateImage } from "../src/automation/polloImage";

async function main(): Promise<void> {
  const paths = await generateImage(
    "a small red bicycle leaning against a brick wall, morning light",
    {},
    "test-pollo-image-e2e",
  );
  console.log("OK, đã tải về:", paths);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
