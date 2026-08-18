import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

const target = (process.argv[2] ?? "video").toLowerCase();
if (target !== "video" && target !== "image") {
  console.error(
    'Tham số phải là "video" hoặc "image" (mặc định "video"). Cách dùng: npm run login -- image',
  );
  process.exit(1);
}
const storageStatePath =
  target === "video" ? config.storageStatePath : config.aiVideoImageStorageStatePath;

/**
 * Mở một cửa sổ Chrome thật để bạn đăng nhập tay vào AIVideo (kể cả
 * "Đăng nhập bằng Google"). Sau khi đăng nhập xong, quay lại terminal và
 * nhấn Enter để lưu cookies/localStorage vào đúng session file của tài
 * khoản đang chọn (video: STORAGE_STATE_PATH, ảnh:
 * AIVIDEO_IMAGE_STORAGE_STATE_PATH — xem getImageBrowserContext/
 * getVideoBrowserContext trong src/automation/browser.ts, hàng đợi ảnh và
 * video giờ dùng 2 TÀI KHOẢN KHÁC NHAU). Bot sẽ dùng file này để tự động
 * thao tác mà không cần đăng nhập lại.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.aiVideoBaseUrl);

  console.log(
    `Hãy đăng nhập thủ công trong cửa sổ trình duyệt vừa mở (tài khoản dùng cho "${target}").`,
  );
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await waitForEnter();

  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  console.log(`Đã lưu session vào ${storageStatePath}`);

  await browser.close();
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
