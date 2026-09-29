import { randomUUID } from "node:crypto";
import {
  generateVideoComfyUI,
  type ComfyAspectRatio,
} from "../src/automation/comfyui";

/**
 * Test THẬT generateVideoComfyUI() end-to-end — gọi thẳng REST API của
 * server ComfyUI thật (đổi COMFYUI_BASE_URL trong .env nếu server không
 * chạy ở 127.0.0.1:8188 mặc định), upload firstFrame/lastFrame, submit
 * workflow LTX-2 frame-to-video, chờ xong rồi tải video kết quả về
 * DOWNLOAD_DIR.
 *
 * Cách dùng:
 *   npx tsx scripts/test-comfyui-generate-video.ts <firstFramePath> <lastFramePath> <prompt> [durationSeconds] [aspectRatio] [frameRate]
 *
 * Ví dụ:
 *   npx tsx scripts/test-comfyui-generate-video.ts \
 *     ./storage/reference-images/SHOT_01_CLIP_02_END.png \
 *     ./storage/reference-images/SHOT_01_CLIP_03_END.png \
 *     "Gentle camera push-in, soft ambient light shifting slowly" \
 *     6 9:16 24
 */
async function main(): Promise<void> {
  const [
    firstFramePath,
    lastFramePath,
    prompt,
    durationArg,
    aspectRatioArg,
    frameRateArg,
  ] = process.argv.slice(2);

  if (!firstFramePath || !lastFramePath || !prompt) {
    console.error(
      "Thiếu tham số. Cách dùng: npx tsx scripts/test-comfyui-generate-video.ts <firstFramePath> <lastFramePath> <prompt> [durationSeconds] [aspectRatio] [frameRate]",
    );
    process.exit(1);
  }

  const duration = durationArg ? Number(durationArg) : 6;
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error(`durationSeconds không hợp lệ: "${durationArg}"`);
    process.exit(1);
  }

  let aspectRatio: ComfyAspectRatio | undefined;
  if (aspectRatioArg) {
    if (aspectRatioArg !== "9:16" && aspectRatioArg !== "16:9") {
      console.error(`aspectRatio không hợp lệ (chỉ nhận "9:16"/"16:9"): "${aspectRatioArg}"`);
      process.exit(1);
    }
    aspectRatio = aspectRatioArg;
  }

  let frameRate: number | undefined;
  if (frameRateArg) {
    frameRate = Number(frameRateArg);
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      console.error(`frameRate không hợp lệ: "${frameRateArg}"`);
      process.exit(1);
    }
  }

  const jobId = `test-comfyui-${randomUUID()}`;
  console.log("Bắt đầu generate video qua ComfyUI, jobId:", jobId);
  console.log("firstFrame:", firstFramePath);
  console.log("lastFrame:", lastFramePath);
  console.log("prompt:", prompt);
  console.log("duration:", duration, "giây");
  console.log("aspectRatio:", aspectRatio ?? "(mặc định 16:9)");
  console.log("frameRate:", frameRate ?? "(mặc định 24)");

  const t0 = Date.now();
  const { filePath, promptId } = await generateVideoComfyUI(
    firstFramePath,
    lastFramePath,
    prompt,
    duration,
    jobId,
    aspectRatio,
    frameRate,
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
