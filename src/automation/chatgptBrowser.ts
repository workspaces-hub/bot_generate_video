import type { Page } from "playwright";
import { config } from "../config";
import { createBrowserContextManager } from "./browser";

/**
 * BrowserContext RIÊNG cho chatgpt.com — khác domain, khác session hoàn
 * toàn với hailuoai.video, nên KHÔNG dùng chung getBrowserContext() (sẽ lẫn
 * cookie 2 site vào nhau). Đăng nhập qua scripts/login-chatgpt.ts.
 *
 * Xác nhận qua debug thật (job afd3c6d8): từng thử tắt proxy cho GPT — IP
 * thẳng của VPS lập tức bị chatgpt.com chặn bằng Cloudflare "Verify you are
 * human" challenge, không vào được trang thật. Phải DÙNG LẠI proxy (đánh đổi
 * lấy việc qua được Cloudflare).
 */
export const getChatGptBrowserContext = createBrowserContextManager(
  config.chatGptStorageStatePath,
  "chatgpt-browser",
  'Chạy "npm run login-chatgpt" trước khi dùng tính năng GPT.',
);

/**
 * Cloudflare "Verify you are human" (managed challenge, Turnstile) đôi khi
 * chặn chatgpt.com trước khi vào được trang thật — DOM thật xác nhận (job
 * afd3c6d8, 30520119): page.content() chỉ ~10KB, có text "Verify you are
 * human" + script challenges.cloudflare.com/turnstile, tất cả selector khác
 * (#prompt-textarea...) đều không tìm thấy vì trang thật chưa hề load.
 *
 * Checkbox Turnstile nằm trong 1 iframe RIÊNG do Cloudflare chèn vào (không
 * phải DOM chính của trang, không đọc được qua page.content()) — dò qua TẤT
 * CẢ frame Playwright thấy được trên trang (page.frames() nhìn xuyên được
 * iframe cross-origin, khác với JS thường trong trang bị same-origin policy
 * chặn), bấm checkbox ĐẦU TIÊN tìm thấy (best-effort, im lặng bỏ qua nếu
 * không có/không bấm được — trang có thể không phải lúc nào cũng bị chặn).
 * Session dùng chung 1 browser context cho mọi job (xem getChatGptBrowserContext)
 * nên cookie cf_clearance sau khi pass 1 lần thường được giữ lại cho các job
 * sau trong CÙNG lần chạy bot.
 */
export async function dismissCloudflareChallengeIfPresent(page: Page): Promise<void> {
  const isChallengePage = await page
    .getByText(/verify you are human/i)
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (!isChallengePage) return;

  console.warn("[chatgpt-browser] Gặp Cloudflare challenge — thử tự bấm checkbox xác nhận...");

  for (const frame of page.frames()) {
    const clicked = await frame
      .locator('input[type="checkbox"]')
      .first()
      .click({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) break;
  }

  // Chờ Cloudflare xử lý xong — trang tự chuyển qua giao diện thật nếu pass
  // được challenge (best-effort, không throw nếu vẫn còn kẹt: các bước sau
  // tự nhiên sẽ báo lỗi "không tìm thấy ô nhập prompt" như bình thường).
  await page
    .waitForFunction(() => !document.body.innerText.includes("Verify you are human"), {
      timeout: 15_000,
    })
    .catch(() => {});
}
