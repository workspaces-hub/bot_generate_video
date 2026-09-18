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
    "./storage/debug/bottle/CHAR_ISABEAU_RENAUDIN.png",
    "./storage/debug/bottle/CHAR_MAXENCE_DE_VILLANDRY.png",
    "./storage/debug/bottle/CHAR_PROP_PRESSURE_MANIFOLD.png",
    "./storage/debug/bottle/LOC_MAISON_VILLANDRY_GRAND_CHALK_CELLARS.png",
  ]
  const prompt = "5-second vertical 9:16, 24 fps photorealistic rescue impact continuing from Isabeau Renaudin reaching toward the west-wall pressure manifold. Isabeau starts camera-left, right fingers inches from the red lever, body pitched west, left palm cut, left foot bare and right heel on. Maxence de Villandry enters rapidly from camera-right already soaked in champagne, eyes locked on the collapsing rack above Isabeau, not on the manifold. In the first 1.5 seconds, Maxence plants his right foot east of Isabeau, aligns both shoulders toward Isabeau and seizes Isabeau securely around the waist with both arms. Over the next 2 seconds, Maxence drives backward east, pulling Isabeau hard against his chest behind the central chalk shelter pillar; Isabeau's extended right hand is pulled away from the lever and her loosened hair, wet gown and earrings follow with believable inertia. Maxence's left forearm receives a small flying-crystal cut and his tuxedo tears at the right shoulder during the retreat. At 3.5 seconds the rack crashes exactly onto Isabeau's former position west of the pillar, never onto either person. Camera: 32mm west-facing medium-wide, fast lateral track with their retreat for 3 seconds; match-on-action hard cut to 65mm tight two-shot behind the pillar as debris explodes past its west edge for 2 seconds. Cool practicals, warm champagne bounce and dust remain consistent. Sound: Maxence shouts in natural English with exact lip sync, 'Leave it!' followed by stone-shaking rack impact, glass thunder, cloth strain and their cut-off breaths; score hits once at impact. End with Maxence and Isabeau pressed upright behind the pillar, Maxence's hands protective around Isabeau's waist and lower back, Isabeau's fingers gripping Maxence's torn wet shirt, both shielded from the rack; manifold remains west and untouched. Preserve identity, costume damage, one lost heel, wounds, prop count, screen axis and full-body impact physics. No jump cuts, no hidden scene change, no extra events, no modern elements."
  const durationArg = '5'
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
  console.log("referenceImagePaths:", referenceImagePaths);
  console.log("prompt:", prompt);
  console.log("duration:", duration, "giây");
  console.log("aspectRatio:", aspectRatio ?? "(mặc định 16:9)");

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
