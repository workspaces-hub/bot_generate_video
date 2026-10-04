import path from "node:path";
import fs from "node:fs";
import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

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

  console.log("Hãy đăng nhập tài khoản Google trong cửa sổ trình duyệt vừa mở, mở được trang chat Gemini.");
  console.log("Xong rồi quay lại đây và nhấn Enter...");
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  fs.mkdirSync(path.dirname(config.geminiStorageStatePath), { recursive: true });
  await context.storageState({ path: config.geminiStorageStatePath });
  console.log(`Đã lưu session vào ${config.geminiStorageStatePath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
