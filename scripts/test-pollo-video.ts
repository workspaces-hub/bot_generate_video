import path from "node:path";
import { generateVideo } from "../src/automation/pollo";

async function main(): Promise<void> {
  const filePath = await generateVideo(
    "A cinematic transition between the two frames, smooth camera motion",
    {
      startFramePath: path.resolve("./storage/reference-images/cay_khe/SCENE_01_START.png"),
      endFramePath: path.resolve("./storage/reference-images/cay_khe/SCENE_01_END.png"),
    },
    "test-pollo-frames-to-video-e2e",
  );
  console.log("OK, đã tải về:", filePath);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
