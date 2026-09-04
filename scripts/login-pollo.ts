import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

/**
 * Mở một cửa sổ Chrome thật để bạn đăng nhập tay vào pollo.ai (kể cả
 * đăng nhập qua Google/Microsoft/Apple). Sau khi đăng nhập xong, quay lại
 * terminal và nhấn Enter để lưu cookies/localStorage vào
 * POLLO_STORAGE_STATE_PATH. Bot sẽ dùng file này để tự động thao tác mà
 * không cần đăng nhập lại — session RIÊNG với AIVideo/ChatAI.
 * Dùng proxy giống lúc bot thật sự gọi pollo.ai (xem polloBrowser.ts) — tắt
 * proxy có thể khiến IP thẳng của VPS bị chặn bởi Cloudflare/anti-bot.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.polloBaseUrl);

  console.log("Hãy đăng nhập thủ công trong cửa sổ trình duyệt vừa mở.");
  console.log(
    "Sau khi đăng nhập xong, hãy TỰ ĐIỀU HƯỚNG tới đúng trang tạo ảnh và trang tạo video (để lưu URL thật cho bước sau).",
  );
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await waitForEnter();

  fs.mkdirSync(path.dirname(config.polloStorageStatePath), { recursive: true });
  await context.storageState({ path: config.polloStorageStatePath });
  console.log(`Đã lưu session vào ${config.polloStorageStatePath}`);
  console.log(`URL hiện tại lúc lưu: ${page.url()}`);

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
