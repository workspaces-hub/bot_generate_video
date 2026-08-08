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
 * Nhận diện trang Cloudflare challenge — DOM thật xác nhận (job afd3c6d8,
 * 30520119): <title>Just a moment...</title> + 1 <script
 * src="https://challenges.cloudflare.com/turnstile/...">. QUAN TRỌNG: chữ
 * "Verify you are human" + checkbox nằm BÊN TRONG iframe Turnstile (Cloudflare
 * tự chèn), KHÔNG nằm ở document chính — page.getByText("verify you are
 * human") KHÔNG BAO GIỜ khớp được (đã xác nhận qua log thật: isChallengePage
 * luôn false dù ảnh chụp rõ ràng đang ở trang challenge), vì getByText mặc
 * định chỉ tìm trong frame chính. Phải dùng tín hiệu THẬT nằm ở document
 * chính: title trang hoặc thẻ <script> nói trên.
 */
async function isCloudflareChallengePage(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => "");
  if (/just a moment/i.test(title)) return true;

  const hasTurnstileScript =
    (await page
      .locator('script[src*="challenges.cloudflare.com"]')
      .count()
      .catch(() => 0)) > 0;
  return hasTurnstileScript;
}

/**
 * Cloudflare "Verify you are human" (managed challenge, Turnstile) đôi khi
 * chặn chatgpt.com trước khi vào được trang thật.
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
  if (!(await isCloudflareChallengePage(page))) return;

  console.warn(
    '[chatgpt-browser] Gặp Cloudflare challenge (title "Just a moment...") — thử tự bấm checkbox xác nhận...',
  );

  // Iframe Turnstile do Cloudflare chèn vào bằng JS SAU khi trang load, cần
  // vài giây để render xong — tìm checkbox ngay có thể chưa thấy gì cả (chưa
  // kịp chèn iframe/checkbox vào DOM). Đợi 10s trước khi dò qua các frame.
  await page.waitForTimeout(10_000);

  // Log chi tiết — page.content()/screenshot debug snapshot KHÔNG thấy được
  // bên trong iframe (khác browsing context), nên đây là cách DUY NHẤT biết
  // được lần chạy thật có tìm/bấm được checkbox hay không khi xem log job.
  const frames = page.frames();
  console.warn(
    `[chatgpt-browser] Đang dò ${frames.length} frame để tìm checkbox: ${frames.map((f) => f.url()).join(", ")}`,
  );

  let clickedFrameUrl: string | null = null;
  for (const frame of frames) {
    const checkboxCount = await frame
      .locator('input[type="checkbox"], [role="checkbox"]')
      .count()
      .catch(() => 0);
    if (checkboxCount === 0) continue;

    console.warn(
      `[chatgpt-browser] Frame ${frame.url()} có ${checkboxCount} checkbox — thử bấm...`,
    );
    const clicked = await frame
      .locator('input[type="checkbox"], [role="checkbox"]')
      .first()
      .click({ timeout: 3000 })
      .then(() => true)
      .catch((err) => {
        console.warn(`[chatgpt-browser] Bấm checkbox ở frame ${frame.url()} lỗi:`, err instanceof Error ? err.message : err);
        return false;
      });
    if (clicked) {
      clickedFrameUrl = frame.url();
      break;
    }
  }
  console.warn(
    clickedFrameUrl
      ? `[chatgpt-browser] Đã bấm checkbox ở frame ${clickedFrameUrl}, chờ Cloudflare xác nhận...`
      : "[chatgpt-browser] KHÔNG tìm/bấm được checkbox nào trong bất kỳ frame nào.",
  );

  // Chờ Cloudflare xử lý xong — trang tự chuyển qua giao diện thật nếu pass
  // được challenge (best-effort, không throw nếu vẫn còn kẹt: các bước sau
  // tự nhiên sẽ báo lỗi "không tìm thấy ô nhập prompt" như bình thường). Poll
  // bằng isCloudflareChallengePage (cùng tín hiệu title/script ở document
  // chính) — KHÔNG dùng document.body.innerText như trước (luôn sai, xem
  // isCloudflareChallengePage).
  const pollDeadline = Date.now() + 15_000;
  let stillChallenge = true;
  while (Date.now() < pollDeadline) {
    stillChallenge = await isCloudflareChallengePage(page);
    if (!stillChallenge) break;
    await page.waitForTimeout(1000);
  }
  console.warn(
    stillChallenge
      ? "[chatgpt-browser] Vẫn còn kẹt ở trang Cloudflare challenge sau khi chờ."
      : "[chatgpt-browser] Đã qua được Cloudflare challenge.",
  );
}
