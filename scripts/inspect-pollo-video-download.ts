import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/** One-off: mở /create, click nút Download của record CUỐI CÙNG (video vừa test), chụp dropdown xuất hiện. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-video-download-menu";
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
    await page.waitForTimeout(1000);

    await captureSnapshot(page, jobId, "download-menu");
    console.log(`Đã chụp: storage/debug/${jobId}.png / .html`);
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
