import { askChatAI } from "../src/automation/chatAI";

/**
 * Test độc lập cho askChatAI (chatAI.ts) — gọi thẳng browser automation
 * thật (cần session đã đăng nhập, xem `npm run login-chatai`), KHÔNG đụng
 * tới bot/queue. Dùng để đối chiếu log chẩn đoán mới (model/reasoning
 * effort, đối chiếu prompt dán vào ô nhập, xác nhận attachment trong
 * composer, ls -lh/sha256sum/ffprobe file đính kèm) giữa các môi trường
 * (local vs VPS) mà không cần chạy qua Telegram.
 *
 * Cách dùng:
 *   npx tsx scripts/test-chatai.ts "<prompt>"
 *   npx tsx scripts/test-chatai.ts "<prompt>" <đường-dẫn-file-đính-kèm> [--binary]
 *
 * --binary: đánh dấu file đính kèm là NHỊ PHÂN (video/ảnh, tương ứng
 * attachmentIsScript=false trong askChatAI) thay vì file kịch bản .txt/.md.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isBinaryFlagIndex = args.indexOf("--binary");
  const isBinary = isBinaryFlagIndex !== -1;
  if (isBinary) args.splice(isBinaryFlagIndex, 1);

  const prompt = args[0];
  const attachmentPath = args[1];

  if (!prompt) {
    console.error(
      'Cách dùng: npx tsx scripts/test-chatai.ts "<prompt>" [đường-dẫn-file-đính-kèm] [--binary]',
    );
    process.exit(1);
  }

  const jobId = `test-chatai-${Date.now()}`;
  const promptFileName = attachmentPath ? attachmentPath.split("/").pop() : undefined;

  console.log(
    `[test-chatai] jobId=${jobId}, attachment=${attachmentPath ?? "(không có)"}, isBinary=${isBinary}`,
  );

  const result = await askChatAI(
    prompt,
    jobId,
    promptFileName,
    attachmentPath,
    !isBinary,
  );

  console.log("Kết quả:", result);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
