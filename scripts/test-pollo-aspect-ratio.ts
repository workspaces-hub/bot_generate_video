import { randomUUID } from "node:crypto";
import path from "node:path";
import { generateVideo } from "../src/automation/pollo";

/**
 * Test extractAspectRatioFromPrompt/selectAspectRatioIfNeeded (pollo.ts) với
 * 1 prompt chứa "9:16" — dùng cổng debug POLLO_DEBUG_STOP_BEFORE_GENERATE=1
 * để dừng NGAY TRƯỚC khi bấm Generate thật (không tốn credit/thời gian chờ
 * render), chỉ cần xác nhận Aspect Ratio đã chọn đúng trên trang qua debug
 * snapshot (storage/debug/<jobId>_stop-before-generate.{png,html}).
 */
async function main(): Promise<void> {
  process.env.POLLO_DEBUG_STOP_EARLY = "1";

  const jobId = `test-aspect-ratio-${randomUUID()}`;
  console.log("Bắt đầu test aspect ratio 9:16, jobId:", jobId);

  try {
    await generateVideo(
      "Vertical portrait shot, aspect ratio 9:16. Gentle camera push-in toward the scene, soft ambient light shifting slowly",
      {
        referenceImagePaths: [
          path.resolve(
            "./storage/reference-images/cay_khe/LOC_TREASURE_ISLAND.png",
          ),
        ],
        model: "MiniMax H3",
      },
      jobId,
    );
    console.error(
      "KHÔNG như mong đợi: generateVideo chạy hết mà không dừng ở cổng debug — kiểm tra lại POLLO_DEBUG_STOP_BEFORE_GENERATE.",
    );
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("POLLO_DEBUG_STOP_EARLY")) {
      console.log("Đã dừng đúng lúc (sớm). Xem debug snapshot:");
      console.log(`  storage/debug/${jobId}_stop-early.png`);
      console.log(`  storage/debug/${jobId}_stop-early.html`);
      process.exit(0);
    }
    console.error("Lỗi KHÔNG mong đợi (không phải cổng debug):", err);
    process.exit(1);
  }
}

main();
