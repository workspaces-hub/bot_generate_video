import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

const target = (process.argv[2] ?? "main").toLowerCase();
if (target !== "main" && target !== "revise") {
  console.error(
    'Tham số phải là "main" hoặc "revise" (mặc định "main"). Cách dùng: npm run login-chatai -- revise',
  );
  process.exit(1);
}
const storageStatePath =
  target === "main"
    ? config.chatAIStorageStatePath
    : config.chatAIReviseStorageStatePath;

/**
 * Mở một cửa sổ Chrome thật để bạn đăng nhập tay vào ChatAI (kể cả
 * đăng nhập qua Google/Microsoft/Apple). Sau khi đăng nhập xong, quay lại
 * terminal và nhấn Enter để lưu cookies/localStorage vào đúng session file
 * của tài khoản đang chọn ("main": CHATAI_STORAGE_STATE_PATH — dùng cho
 * askChatAI; "revise": CHATAI_REVISE_STORAGE_STATE_PATH — dùng RIÊNG cho
 * reviseGenerationPrompt, xem config.chatAIReviseStorageStatePath để biết lý
 * do tách tài khoản). Bot sẽ dùng file này để tự động thao tác mà không cần
 * đăng nhập lại. Dùng proxy giống lúc bot thật sự gọi ChatAI (xem
 * chatAIBrowser.ts) — tắt proxy khiến IP thẳng của VPS bị ChatAI chặn bằng
 * Cloudflare challenge.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.chatAIBaseUrl);

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
