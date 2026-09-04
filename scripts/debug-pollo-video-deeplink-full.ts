import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Dry-run KHÔNG bấm Generate — chạy lại đúng phần đầu generateVideo() SAU KHI
 * wire deep-link (goto thẳng /reference-to-video?...&modelName=minimax-hailuo-03,
 * bỏ qua switchModeIfNeeded + selectModel), để verify miễn phí mode chip/model
 * chip đã đúng NGAY TỪ ĐẦU + upload + mention vẫn hoạt động bình thường sau đó.
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-video-deeplink-full";
  try {
    const pollo = await import("../src/automation/pollo");
    const selectors = await import("../src/automation/polloSelectors");

    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    console.log("Navigating to deep-link:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await pollo.dismissBlockingOverlays(page);

    const modeLabel = await selectors.modeChipLocator(page).first().innerText().catch(() => "(not found)");
    const modelLabel = await selectors.modelChipLocator(page).first().innerText().catch(() => "(not found)");
    console.log("Mode chip label (from URL, no click):", modeLabel);
    console.log("Model chip label (from URL, no click):", modelLabel);

    console.log("Uploading reference image...");
    const refPath = path.resolve("./storage/downloads/test-pollo-image-e2e.png");
    await selectors.uploadCardButtonForImage(page).first().click({ timeout: 10_000 });
    const cards = selectors.assetPickerCardLocator(page);
    const countBefore = await cards.count();
    await selectors.uploadDialogFileInputLocator(page).setInputFiles(refPath, { timeout: 10_000 });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="asset-picker-card"]').length >= expected,
      countBefore + 1,
      { timeout: 30_000 },
    );
    const newCardIndex = (await cards.count()) - 1;
    await cards.nth(newCardIndex).click({ timeout: 10_000 });
    await selectors.uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
    console.log("Reference uploaded.");

    console.log("Typing prompt + mention...");
    const editor = selectors.promptEditorLocator(page).first();
    await editor.click();
    await page.keyboard.insertText("A cinematic shot of the bicycle riding through a forest trail");
    await page.waitForTimeout(300);

    await page.keyboard.type(" @", { delay: 50 });
    await page.waitForTimeout(500);
    await page.locator('[data-testid="asset-tab-all"]').first().click({ timeout: 3000 }).catch(() => {});
    const fileNameNoExt = path.basename(refPath, path.extname(refPath));
    await selectors.mentionPickerItemLocator(page, fileNameNoExt).first().click({ timeout: 10_000 });
    console.log("Mention inserted.");

    const modeLabelFinal = await selectors.modeChipLocator(page).first().innerText().catch(() => "(not found)");
    const modelLabelFinal = await selectors.modelChipLocator(page).first().innerText().catch(() => "(not found)");
    console.log("Mode chip label (final):", modeLabelFinal);
    console.log("Model chip label (final):", modelLabelFinal);

    const generateDisabled = await selectors
      .generateButtonLocator(page)
      .first()
      .getAttribute("aria-disabled")
      .catch(() => null);
    console.log("Generate button aria-disabled:", generateDisabled);

    await page.waitForTimeout(500);
    await captureSnapshot(page, jobId, "dry-run-final");
    console.log("Dry-run complete, snapshot saved. NOT clicking Generate.");
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
