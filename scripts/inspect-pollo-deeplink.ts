import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import { modeChipLocator, modelChipLocator } from "../src/automation/polloSelectors";

/** One-off: kiểm tra URL deep-link user tìm ra — điều hướng thẳng tới
 * /reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03
 * xem mode chip + model chip có tự set đúng "Reference to Video" / "MiniMax H3"
 * hay không, KHÔNG cần bấm popup nào cả (né hẳn bug click bị chặn). */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-deeplink";
  try {
    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const modeLabel = await modeChipLocator(page).first().innerText().catch(() => "(not found)");
    const modelLabel = await modelChipLocator(page).first().innerText().catch(() => "(not found)");
    console.log("Mode chip label:", modeLabel);
    console.log("Model chip label:", modelLabel);
    console.log("Current page URL after load:", page.url());

    await captureSnapshot(page, jobId, "after-deeplink");
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
