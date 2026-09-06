import { randomUUID } from "node:crypto";
import { generateImage } from "../src/automation/polloImage";

/** Test THẬT generateImage() end-to-end (theo yêu cầu "test gen 1 ảnh bất kì") — xác nhận toàn bộ luồng sau các fix gần đây (goto retry, composer-ready, unlimited credit, download) hoạt động đúng. */
async function main(): Promise<void> {
  const jobId = `test-gen-${randomUUID()}`;
  console.log("Bắt đầu generate ảnh, jobId:", jobId);
  const t0 = Date.now();
  const { filePaths, polloResultId } = await generateImage(
    "A simple photorealistic green apple sitting on a wooden table, soft natural lighting, shallow depth of field",
    {},
    jobId,
  );
  console.log(`\nXong sau ${Date.now() - t0}ms`);
  console.log("File(s) đã tải:", filePaths);
  console.log("polloResultId:", polloResultId);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Lỗi:", err);
    process.exit(1);
  });
