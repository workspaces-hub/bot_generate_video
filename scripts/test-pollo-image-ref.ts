import path from "node:path";
import { generateImage } from "../src/automation/polloImage";

async function main(): Promise<void> {
  const refPath = path.resolve("./storage/downloads/test-pollo-image-e2e.png");
  const paths = await generateImage(
    "Using the reference image, show the same red bicycle now parked on a snowy mountain trail",
    { referenceImagePaths: [refPath] },
    "test-pollo-image-ref-e2e",
  );
  console.log("OK, đã tải về:", paths);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
