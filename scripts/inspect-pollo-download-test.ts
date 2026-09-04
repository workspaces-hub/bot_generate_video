import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/** One-off: mở /create, click Download > "Download with watermark" cho record CUỐI, chờ sự kiện download thật. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-download-test-wm";
  try {
    await page.goto(new URL("/create", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const downloadButton = page
      .locator('[data-testid="record-action"][aria-label="Download"]')
      .last();
    await downloadButton.scrollIntoViewIfNeeded();
    await downloadButton.click({ timeout: 10_000 });
    await page.waitForTimeout(800);

    const withWatermarkItem = page
      .locator('[data-testid="record-action"][data-action-key="with-watermark"]')
      .last();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      withWatermarkItem.click({ timeout: 10_000 }),
    ]);

    const savePath = path.resolve("./storage/debug/pollo-download-test-wm.mp4");
    await download.saveAs(savePath);
    console.log(`Đã tải về: ${savePath}`);
    console.log(`Suggested filename: ${download.suggestedFilename()}`);
    console.log(`URL: ${download.url()}`);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();
