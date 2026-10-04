import { randomUUID } from "node:crypto";
import {
  generateVideoComfyMiniMaxH3,
  MAX_MINIMAX_H3_REFERENCE_IMAGES,
  type ComfyAspectRatio,
} from "../src/automation/comfyui";

/**
 * Test THẬT generateVideoComfyMiniMaxH3() end-to-end — gọi thẳng REST API
 * của server ComfyUI thật (đổi COMFYUI_BASE_URL trong .env nếu server không
 * chạy ở 127.0.0.1:8188 mặc định), upload tối đa MAX_MINIMAX_H3_REFERENCE_IMAGES
 * (9) ảnh tham chiếu, submit workflow MiniMax H3 "Reference to Video", chờ
 * xong rồi tải video kết quả về DOWNLOAD_DIR.
 *
 * Cách dùng:
 *   npx tsx scripts/test-comfyui-generate-video-minimax-h3.ts <refImagePaths (phân tách bằng dấu phẩy)> <prompt> [durationSeconds] [aspectRatio]
 *
 * Ví dụ:
 *   npx tsx scripts/test-comfyui-generate-video-minimax-h3.ts \
 *     ./storage/reference-images/CHAR_ISABEAU.png,./storage/reference-images/LOC_CELLARS.png \
 *     "Gentle camera push-in, soft ambient light shifting slowly" \
 *     5 9:16
 */
async function main(): Promise<void> {
  // const [refImagePathsArg, prompt, durationArg, aspectRatioArg] =
  //   process.argv.slice(2);
  const referenceImagePaths: string[] = [
    "./storage/generated/test_audio_remake_5/LOC_HARROW_SALE_PAVILION.png",
    "./storage/generated/test_audio_remake_5/CHAR_EVAN_HARROW.png",
  ]
  const prompt = `<Picture 1> is LOC_HARROW_SALE_PAVILION. <Picture 2> is CHAR_EVAN_HARROW.

CLIP SPEC: 5s, 9:16 vertical, 24fps, live-action photorealistic Western microdrama.

IMPORTANT AUDIO REQUIREMENT: THIS SCENE HAS CONTINUOUS CINEMATIC BACKGROUND MUSIC WHILE THE CHARACTER SPEAKS. DO NOT GENERATE A VOICE-ONLY SOUNDTRACK.

BACKGROUND SCORE: A clearly audible dramatic instrumental score is playing continuously from the very first frame to the very last frame. The score uses a repeating mid-register hammered-dulcimer motif, sustained cello harmony, and a steady frame-drum pulse. The music remains obviously audible during all dialogue.

CAST AND VOICE: SPEECH MODE: SPOKEN_DIALOGUE. SINGLE VISIBLE CHARACTER: CHAR_EVAN_HARROW. SOLE VOICE OWNER: CHAR_EVAN_HARROW. No other human voice.

START FRAME: Clean medium close-up of Evan alone against pale oak and cream stone. Background music is already clearly playing before he starts speaking.

ACTION AND PERFORMANCE: Evan holds a brief recognition beat, then speaks in stunned disbelief. His eyes narrow and his voice hardens into accusation.

SPEECH: EXACT SPOKEN TEXT: "You vanished over Red Hollow on that horse. Who the hell are you?"

AUDIO: Keep BOTH Evan's dialogue AND the cinematic instrumental score audible at the same time. Do not generate dialogue alone. Do not stop, mute, or remove the music during speech. The instrumental motif must remain clearly heard underneath every word. Dialogue is intelligible, but music stays strong and obvious.

As Evan becomes accusatory, strengthen the frame-drum pulse and cello tension slightly.

ROOM SOUND: extremely low room tone only.

END FRAME: Evan finishes with jaw set while the same instrumental score is still clearly playing.`
  const durationArg = '6'
  const aspectRatioArg = '9:16'


  if (referenceImagePaths.length === 0) {
    console.error("refImagePaths rỗng sau khi tách dấu phẩy.");
    process.exit(1);
  }
  if (referenceImagePaths.length > MAX_MINIMAX_H3_REFERENCE_IMAGES) {
    console.error(
      `Quá nhiều ảnh tham chiếu (${referenceImagePaths.length}/${MAX_MINIMAX_H3_REFERENCE_IMAGES}).`,
    );
    process.exit(1);
  }

  const duration = durationArg ? Number(durationArg) : 5;
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error(`durationSeconds không hợp lệ: "${durationArg}"`);
    process.exit(1);
  }

  let aspectRatio: ComfyAspectRatio | undefined;
  if (aspectRatioArg) {
    if (aspectRatioArg !== "9:16" && aspectRatioArg !== "16:9") {
      console.error(
        `aspectRatio không hợp lệ (chỉ nhận "9:16"/"16:9"): "${aspectRatioArg}"`,
      );
      process.exit(1);
    }
    aspectRatio = aspectRatioArg;
  }

  const jobId = `test-comfyui-minimax-h3-${randomUUID()}`;
  console.log("Bắt đầu generate video qua ComfyUI (MiniMax H3), jobId:", jobId);
  // console.log("referenceImagePaths:", referenceImagePaths);
  // console.log("prompt:", prompt);
  // console.log("duration:", duration, "giây");
  // console.log("aspectRatio:", aspectRatio ?? "(mặc định 16:9)");

  const t0 = Date.now();
  const { filePath, promptId } = await generateVideoComfyMiniMaxH3(
    referenceImagePaths,
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
