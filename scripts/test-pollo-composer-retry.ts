import { config } from "../src/config";
import { getPolloImageBrowserContext } from "../src/automation/polloBrowser";
import { dismissBlockingOverlays, gotoPolloWithRetry, waitForComposerReady } from "../src/automation/pollo";

/** Test đúng luồng thật của generateImage() (goto retry + composer-ready + reload fallback) để xem có vượt qua được tình trạng proxy hiện tại không. */
async function main(): Promise<void> {
  const context = await getPolloImageBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    const t0 = Date.now();
    await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
    console.log(`goto xong sau ${Date.now() - t0}ms`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    let composerReady = await waitForComposerReady(page, 15_000);
    console.log("Composer sẵn sàng (lần 1, chưa reload)?", composerReady);

    if (!composerReady) {
      console.log("Thử reload lại 1 lần...");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 0 }).catch((e) => console.log("reload lỗi:", e));
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await dismissBlockingOverlays(page);
      composerReady = await waitForComposerReady(page, 20_000);
      console.log("Composer sẵn sàng (SAU reload)?", composerReady);
    }

    console.log("\n=== KẾT QUẢ CUỐI: composer sẵn sàng?", composerReady, "===");
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
