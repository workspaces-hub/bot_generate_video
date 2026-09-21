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
    "./storage/generated/6_babies-WESTERN_MASTER_PROMPT/CHAR_ADRIAN_CROSS.png",
    "./storage/generated/6_babies-WESTERN_MASTER_PROMPT/CHAR_EXECUTIVE_SECRETARY.png",
    "./storage/generated/6_babies-WESTERN_MASTER_PROMPT/LOC_CROSS_DOMINION_EXECUTIVE_CORRIDOR.png",
  ]
  const prompt = "<Picture 1> is Adrian Cross (CHAR_ADRIAN_CROSS), the exact character identity reference. <Picture 2> is Adrian's executive secretary (CHAR_EXECUTIVE_SECRETARY), the exact character identity reference. <Picture 3> is Cross Dominion executive corridor (LOC_CROSS_DOMINION_EXECUTIVE_CORRIDOR), the exact location/environment reference. Preserve all referenced character identities, environment layouts and prop/object designs exactly. Premium stylized 3D animated cinematic film, fully CGI characters, props and locations, unmistakably stylized Western feature-animation geometry, Western/European-descended human cast, Western Manhattan cultural world, NOT live-action, NOT photoreal humans, NOT real objects. Duration exactly 5 seconds, 9:16 vertical, 24 fps, virtual CGI cinematography. ENGLISH-ONLY SPOKEN AUDIO; use the exact English dialogue and voice-over written below; no language switching. ACTIVE CHARACTERS: Adrian Cross, the executive secretary. No other person may become hero-readable or receive camera focus. The clip opens with this exact physical state: Adrian Cross (CHAR_ADRIAN_CROSS) is walking east along the corridor centerline 4.5 m from the elevator bank with right foot in forward stride, torso and gaze still aimed east; the executive secretary (CHAR_EXECUTIVE_SECRETARY) walks 0.6 m to his north side and half a step behind, tablet held at mid-torso, turning her eyes toward Adrian while keeping pace; the office door remains 11.5 m farther east. Across the clip: The secretary turns her eyes toward Adrian while keeping pace and says immediately, SPEECH START 0.05 s: \"Mr. Cross, there's a very large package in your office.\" Adrian does not stop; he flicks his eyes north toward her while his head stays aimed east. SPEECH START 2.8 s: Adrian asks, \"Sender?\" The secretary answers at 3.35 s, \"No name.\" Adrian's brows tighten and jaw sets as they approach the office door. Use alternating 65 mm clean singles with one 0.5 s tablet insert; SFX FOOTSTEPS and TABLET TAP. SPEECH END 4.0 s. MAXIMUM AUDIO GAP 0.2 s. AUDIO BRIDGE: footsteps continue to the doorway. The clip ends on this exact physical state: Adrian Cross (CHAR_ADRIAN_CROSS) has reached a point 1.2 m west of his office door on the east wall, still on the corridor centerline, shoulders squared east; the executive secretary (CHAR_EXECUTIVE_SECRETARY) is 0.6 m north of him and half a step behind, tablet held against her torso; Adrian's brows are drawn together and both are about to enter the office. Preserve exact face, hair, body proportions, current costume state, prop count and ownership, location geography, lighting direction, eyelines, screen direction and natural stylized physics. Keep at least 90% of visual time in ECU/CU/MCU unless the described geography insert is necessary. Use controlled high-energy microdrama editing, meaningful hard cuts only, no slow motion, no empty reaction tail.  No jump cuts, no hidden scene change, no extra events, no modern elements."
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
