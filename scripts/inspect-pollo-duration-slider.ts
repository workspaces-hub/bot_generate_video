import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import { modelChipLocator } from "../src/automation/polloSelectors";

/** One-off: tìm xem slider "Video Length" (input[type=range], min=4 max=15)
 * user báo trên /reference-to-video?...&modelName=minimax-hailuo-03 nằm ở
 * ĐÂU — hiện sẵn ngay khi load trang, hay phải bấm gì đó (model chip?) mới
 * lộ ra. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-duration-slider";
  try {
    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const sliderCountBefore = await page.locator('input[type="range"]').count();
    const sliderVisibleBefore = sliderCountBefore > 0
      ? await page.locator('input[type="range"]').first().isVisible().catch(() => false)
      : false;
    console.log(`BEFORE any click: input[type=range] count=${sliderCountBefore}, first visible=${sliderVisibleBefore}`);

    if (sliderCountBefore === 0) {
      console.log("Not present on load. Clicking model chip to open its popup...");
      await modelChipLocator(page).first().click({ timeout: 10_000 });
      await page.waitForTimeout(800);
      const sliderCountAfterModelClick = await page.locator('input[type="range"]').count();
      console.log(`AFTER clicking model chip: input[type=range] count=${sliderCountAfterModelClick}`);
      if (sliderCountAfterModelClick > 0) {
        const html = await page
          .locator('input[type="range"]')
          .first()
          .evaluate((el) => {
            let node: Element | null = el;
            for (let i = 0; i < 6 && node?.parentElement; i++) node = node.parentElement;
            return node?.outerHTML.slice(0, 4000) ?? "(no ancestor)";
          })
          .catch((e) => `ERROR: ${e}`);
        console.log("Ancestor HTML around slider (after model click):");
        console.log(html);
      }
      await captureSnapshot(page, jobId, "after-model-click");
    } else {
      const html = await page
        .locator('input[type="range"]')
        .first()
        .evaluate((el) => {
          let node: Element | null = el;
          for (let i = 0; i < 6 && node?.parentElement; i++) node = node.parentElement;
          return node?.outerHTML.slice(0, 4000) ?? "(no ancestor)";
        })
        .catch((e) => `ERROR: ${e}`);
      console.log("Ancestor HTML around slider (visible on load):");
      console.log(html);
      await captureSnapshot(page, jobId, "on-load");
    }

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
