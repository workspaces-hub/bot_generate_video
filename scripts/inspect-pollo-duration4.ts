import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";

/** One-off: thử deep-link modelName trên /video mặc định (không target) xem
 * có set được model MiniMax H3 không, rồi mở lại settings chip xem "Video
 * Length" có option "6s" không (khác Pollo 2.0 chỉ có 5s/10s). */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-duration4";
  try {
    const url = new URL("/video?modelName=minimax-hailuo-03", config.polloBaseUrl).toString();
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const settingsChips = page.locator('div[data-button-name="params"]');
    const count = await settingsChips.count();
    console.log(`Found ${count} [data-button-name="params"] elements.`);
    for (let i = 0; i < count; i++) {
      const text = await settingsChips.nth(i).innerText().catch(() => "");
      console.log(`  [${i}] text="${text.replace(/\n/g, " / ")}"`);
    }

    if (count >= 2) {
      await settingsChips.nth(1).click({ timeout: 10_000 });
      await page.waitForTimeout(800);
      const lengthOptions = await page
        .locator("text=Video Length")
        .locator("xpath=..")
        .locator("span")
        .allInnerTexts()
        .catch(() => []);
      console.log("Video Length options found near label:", lengthOptions);

      // Fallback: in toàn bộ text các option trong khối đầu tiên của popup.
      const allSpansInPopup = await page
        .locator('[data-slot="popover-popup"] .grid span')
        .allInnerTexts()
        .catch(() => []);
      console.log("All grid span texts in popup:", allSpansInPopup);
    }

    await captureSnapshot(page, jobId, "minimax-settings");
    console.log("Snapshot saved.");
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();
