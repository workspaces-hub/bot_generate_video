import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/** Dry-run: verify setSliderValue thật (copy logic y hệt pollo.ts) trên
 * /reference-to-video + MiniMax H3 — set slider "Video Length" (mặc định 5s,
 * range 4-15) sang 9s, kiểm tra value + text "9s" hiển thị cạnh slider có đổi
 * đúng không. Miễn phí, KHÔNG bấm Generate. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-duration-slider-real";
  try {
    const pollo = await import("../src/automation/pollo");
    const selectors = await import("../src/automation/polloSelectors");

    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await pollo.dismissBlockingOverlays(page);

    const slider = selectors.videoLengthSliderInputLocator(page).first();
    const exists = (await slider.count().catch(() => 0)) > 0;
    console.log("Slider found:", exists);
    if (!exists) {
      console.log("FAILED: slider not found via videoLengthSliderInputLocator");
      process.exit(1);
    }

    console.log("Value before:", await slider.getAttribute("value"));
    console.log("Min/Max:", await slider.getAttribute("min"), await slider.getAttribute("max"));

    await slider.evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, String(val));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, 9);
    await page.waitForTimeout(300);

    console.log("Value after:", await slider.getAttribute("value"));
    console.log("aria-valuenow after:", await slider.getAttribute("aria-valuenow"));

    // Text hiển thị "9s" cạnh slider (span cuối cùng trong content div)
    const displayedText = await page
      .locator("div.text-f-text-quaternary.text-xs.font-normal")
      .filter({ hasText: /^Video Length$/ })
      .locator("xpath=following-sibling::div[1]")
      .innerText()
      .catch(() => "(not found)");
    console.log("Displayed text near slider:", displayedText);

    await captureSnapshot(page, jobId, "after-slider-set");
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
