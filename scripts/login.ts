import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

/**
 * Mở một cửa sổ Chrome thật để bạn đăng nhập tay vào hailuoai.video (kể cả
 * "Đăng nhập bằng Google"). Sau khi đăng nhập xong, quay lại terminal và
 * nhấn Enter để lưu cookies/localStorage vào STORAGE_STATE_PATH. Bot sẽ
 * dùng file này để tự động thao tác mà không cần đăng nhập lại.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.hailuoBaseUrl);

  console.log("Hãy đăng nhập thủ công trong cửa sổ trình duyệt vừa mở.");
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await waitForEnter();

  fs.mkdirSync(path.dirname(config.storageStatePath), { recursive: true });
  await context.storageState({ path: config.storageStatePath });
  console.log(`Đã lưu session vào ${config.storageStatePath}`);

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
