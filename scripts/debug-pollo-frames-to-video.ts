import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Dry-run KHÔNG bấm Generate — test mode "Frames to Video" (chưa từng test
 * live trong session này, khác "Reference to Video" đã test kỹ) bằng ảnh
 * start/end THẬT lấy từ 1 storyboard đã chạy AIVideo trước đó (cay_khe,
 * SCENE_01_START/END.png) — dùng ĐÚNG hàm thật trong pollo.ts (không viết lại
 * logic riêng) để verify: chuyển mode, upload Start, upload End, gõ prompt,
 * xem Generate có enable không. Miễn phí.
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-frames-to-video";
  try {
    const pollo = await import("../src/automation/pollo");
    const selectors = await import("../src/automation/polloSelectors");

    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await pollo.dismissBlockingOverlays(page);

    console.log("Switching to Frames to Video...");
    const modeChip = selectors.modeChipLocator(page).first();
    console.log("Mode before:", await modeChip.innerText().catch(() => "?"));
    await modeChip.click({ timeout: 10_000 });
    await selectors.modeMenuOptionLocator(page, "Frames to Video").first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    console.log("Mode after:", await modeChip.innerText().catch(() => "?"));

    const startPath = path.resolve("./storage/reference-images/cay_khe/SCENE_01_START.png");
    const endPath = path.resolve("./storage/reference-images/cay_khe/SCENE_01_END.png");

    async function uploadFrame(label: "Start" | "End", imagePath: string): Promise<void> {
      console.log(`Uploading ${label} frame: ${imagePath}`);
      await selectors.uploadCardButtonByLabel(page, label).first().click({ timeout: 10_000 });
      const cards = selectors.assetPickerCardLocator(page);
      const countBefore = await cards.count();
      await selectors.uploadDialogFileInputLocator(page).setInputFiles(imagePath, { timeout: 10_000 });
      await page.waitForFunction(
        (expected) => document.querySelectorAll('[data-testid="asset-picker-card"]').length >= expected,
        countBefore + 1,
        { timeout: 30_000 },
      );
      const newCardIndex = (await cards.count()) - 1;
      await cards.nth(newCardIndex).click({ timeout: 10_000 });
      await selectors.uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
      console.log(`${label} frame uploaded + selected.`);
    }

    await uploadFrame("Start", startPath);
    await page.waitForTimeout(500);
    await uploadFrame("End", endPath);
    await page.waitForTimeout(500);

    console.log("Typing prompt...");
    const editor = selectors.promptEditorLocator(page).first();
    await editor.click();
    await page.keyboard.insertText("A cinematic transition between the two frames, smooth camera motion");
    await page.waitForTimeout(300);

    const generateDisabled = await selectors
      .generateButtonLocator(page)
      .first()
      .getAttribute("aria-disabled")
      .catch(() => null);
    console.log("Generate button aria-disabled:", generateDisabled);

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
