import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { dismissBlockingOverlays } from "../src/automation/pollo";

/**
 * Test THẬT qua đúng proxy trong .env (khác curl: dùng browser thật + session
 * đã đăng nhập, vượt qua Cloudflare challenge tự nhiên) — theo yêu cầu người
 * dùng, để xem lỗi "Network error"/ảnh vỡ có tái hiện qua chính code path
 * thật của bot không, và bắt log request/response thật nếu có.
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();

  const failedRequests: string[] = [];
  const badResponses: string[] = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    console.log("Đang mở:", url);
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`goto xong sau ${Date.now() - t0}ms`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch((e) => {
      console.log("networkidle timeout:", e instanceof Error ? e.message : e);
    });
    await page.waitForTimeout(3000);
    await dismissBlockingOverlays(page);

    const networkErrorToast = page.getByText(/network error/i);
    const toastVisible = await networkErrorToast.first().isVisible({ timeout: 2000 }).catch(() => false);
    console.log("\nToast 'Network error' đang hiện?", toastVisible);

    const brokenImgCount = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      return imgs.filter((img) => img.complete && img.naturalWidth === 0 && img.src).length;
    });
    console.log("Số <img> bị vỡ (complete nhưng naturalWidth=0):", brokenImgCount);

    console.log("\n--- Request thất bại (requestfailed) ---");
    console.log(failedRequests.length ? failedRequests.join("\n") : "(không có)");

    console.log("\n--- Response lỗi (status >= 400) ---");
    console.log(badResponses.length ? badResponses.join("\n") : "(không có)");

    await page.screenshot({ path: "storage/debug/test-pollo-live-network.png", fullPage: false });
    console.log("\nScreenshot: storage/debug/test-pollo-live-network.png");
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
