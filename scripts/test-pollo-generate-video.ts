import { randomUUID } from "node:crypto";
import path from "node:path";
import { generateVideo } from "../src/automation/pollo";

/**
 * Test THẬT generateVideo() end-to-end qua đúng mode "Reference to Video"
 * (referenceImagePaths + model MiniMax H3 — giống hệt production dùng trong
 * generateVideosForFilePollo) — theo yêu cầu "đã fix tương tự với tạo video
 * pollo chưa", xác nhận captureGenerationRecordId/waitForGenerationApiStatus
 * hoạt động đúng ở nhánh video (đã xác nhận ở nhánh ảnh, chưa test riêng
 * video vì tốn thời gian/credit hơn).
 */
async function main(): Promise<void> {
  const jobId = `test-gen-video-${randomUUID()}`;
  console.log("Bắt đầu generate video, jobId:", jobId);
  const t0 = Date.now();
  const { filePath, polloResultId } = await generateVideo(
    "The apple slowly rotates on the table, soft light shifting gently across its surface",
    {
      referenceImagePaths: [
        path.resolve("./storage/downloads/test-gen-75274774-0d30-4084-bc6d-afe27fc5c3c1.png"),
      ],
      model: "MiniMax H3",
    },
    jobId,
  );
  console.log(`\nXong sau ${Date.now() - t0}ms`);
  console.log("File đã tải:", filePath);
  console.log("polloResultId:", polloResultId);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Lỗi:", err);
    process.exit(1);
  });
