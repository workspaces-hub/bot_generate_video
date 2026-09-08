import path from "node:path";
import { generateVideosForFilePollo } from "../src/automation/storyboardPipeline";

/**
 * Test THẬT generateVideosForFilePollo() cho ĐÚNG 1 entry SHOT_05_CLIP_01_VIDEO
 * của file storage/generated/test_normal_6_rep/test_normal_6_rep.json — job
 * này từng bị "đứng hình" sau khi API báo "succeed" (xem log production thật:
 * in ra "[pollo] API record 124125779 status: succeed" rồi không có gì thêm).
 * Dùng để xác nhận sau 2 lần sửa gần đây (dùng thẳng mediaUrl khi API xác
 * nhận xong, bỏ hẳn bước chờ DOM đủ 1 lượt timeout mới) đã hết bị treo.
 *
 * onlyEntryIds giới hạn ĐÚNG entry này dù file hiện chỉ có 1 entry — an toàn
 * nếu sau này file được bổ sung thêm entry khác.
 */
const JSON_PATH = path.resolve(
  "./storage/generated/test_normal_6_rep/test_normal_6_rep.json",
);
const ENTRY_ID = "SHOT_05_CLIP_01_VIDEO";

async function main(): Promise<void> {
  console.log(`Bắt đầu generate video cho entry "${ENTRY_ID}" (${JSON_PATH})`);
  const t0 = Date.now();

  const result = await generateVideosForFilePollo(
    JSON_PATH,
    async (filePath) => {
      console.log(`Entry xong, file: ${filePath}`);
    },
    async (filePath, errorMessage) => {
      console.error(`Entry lỗi (${filePath}): ${errorMessage}`);
    },
    [ENTRY_ID],
  );

  console.log(`\nXong sau ${Date.now() - t0}ms`);
  console.log("Kết quả:", result);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Lỗi:", err);
    process.exit(1);
  });
