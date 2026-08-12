import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

/**
 * Mở một cửa sổ Chrome thật để bạn đăng nhập tay vào ChatAI (kể cả
 * đăng nhập qua Google/Microsoft/Apple). Sau khi đăng nhập xong, quay lại
 * terminal và nhấn Enter để lưu cookies/localStorage vào
 * CHATAI_STORAGE_STATE_PATH. Bot sẽ dùng file này để tự động thao tác mà
 * không cần đăng nhập lại — session RIÊNG với AIVideo (npm run login).
 * Dùng proxy giống lúc bot thật sự gọi ChatAI (xem chatAIBrowser.ts) — tắt
 * proxy khiến IP thẳng của VPS bị ChatAI chặn bằng Cloudflare challenge.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.chatAIBaseUrl);

  console.log("Hãy đăng nhập thủ công trong cửa sổ trình duyệt vừa mở.");
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await waitForEnter();

  fs.mkdirSync(path.dirname(config.chatAIStorageStatePath), { recursive: true });
  await context.storageState({ path: config.chatAIStorageStatePath });
  console.log(`Đã lưu session vào ${config.chatAIStorageStatePath}`);

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
