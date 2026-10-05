import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

const target = (process.argv[2] ?? "main").toLowerCase();
if (target !== "main" && target !== "image") {
  console.error('Tham số phải là "main" hoặc "image" (mặc định "main"). Cách dùng: npm run login-gemini -- image');
  process.exit(1);
}
// "main": askGemini (GEMINI_STORAGE_STATE_PATH); "image": tạo ảnh bằng Gemini
// (GEMINI_IMAGE_STORAGE_STATE_PATH, tài khoản riêng — xem geminiImage.ts).
const storageStatePath =
  target === "main" ? config.geminiStorageStatePath : config.geminiImageStorageStatePath;

/**
 * Mở Chrome thật để đăng nhập tay tài khoản Google dùng cho Gemini web
 * (gemini.google.com). Đăng nhập xong quay lại terminal nhấn Enter — lưu
 * session vào GEMINI_STORAGE_STATE_PATH (mặc định storage/gemini-session.json),
 * bot dùng file này cho askGemini (xem geminiAI.ts). Dùng cùng cấu hình proxy
 * như lúc bot chạy thật (GEMINI_USE_PROXY) để Google không thấy đổi IP.
 */
async function main(): Promise<void> {
  const browser = await launchRealChrome(config.geminiUseProxy, undefined, true, false);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.geminiBaseUrl);

  console.log(
    `Hãy đăng nhập tài khoản Google (dùng cho "${target}") trong cửa sổ trình duyệt vừa mở, mở được trang chat Gemini.`,
  );
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  console.log(`Đã lưu session vào ${storageStatePath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
