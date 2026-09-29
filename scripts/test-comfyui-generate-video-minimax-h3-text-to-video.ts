import { randomUUID } from "node:crypto";
import {
  generateVideoComfyMiniMaxH3TextToVideo,
  type ComfyAspectRatio,
} from "../src/automation/comfyui";

/**
 * Test THẬT generateVideoComfyMiniMaxH3TextToVideo() end-to-end — gọi thẳng
 * REST API của server ComfyUI thật (đổi COMFYUI_BASE_URL trong .env nếu
 * server không chạy ở 127.0.0.1:8188 mặc định), submit workflow MiniMax H3
 * "Text to Video" (KHÔNG cần ảnh tham chiếu nào), chờ xong rồi tải video kết
 * quả về DOWNLOAD_DIR.
 *
 * Cách dùng:
 *   npx tsx scripts/test-comfyui-generate-video-minimax-h3-text-to-video.ts <prompt> [durationSeconds] [aspectRatio]
 *
 * Ví dụ:
 *   npx tsx scripts/test-comfyui-generate-video-minimax-h3-text-to-video.ts \
 *     "A lone astronaut walks across a red Martian dune at sunset, dust drifting in slow motion, wide cinematic shot" \
 *     5 9:16
 */
async function main(): Promise<void> {
  const prompt = "A turtle and a rabbit racing on a snowy road";

  const duration = 5;

  const aspectRatio: ComfyAspectRatio | undefined = "9:16";

  const jobId = `test-comfyui-minimax-h3-t2v-${randomUUID()}`;
  console.log(
    "Bắt đầu generate video qua ComfyUI (MiniMax H3 Text to Video), jobId:",
    jobId,
  );
  console.log("prompt:", prompt);
  console.log("duration:", duration, "giây");
  console.log("aspectRatio:", aspectRatio ?? "(mặc định 16:9)");

  const t0 = Date.now();
  const { filePath, promptId } = await generateVideoComfyMiniMaxH3TextToVideo(
    prompt,
    duration,
    jobId,
    aspectRatio,
  );
  console.log(`\nXong sau ${Date.now() - t0}ms`);
  console.log("promptId:", promptId);
  console.log("File đã tải:", filePath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Lỗi:", err);
    process.exit(1);
  });
