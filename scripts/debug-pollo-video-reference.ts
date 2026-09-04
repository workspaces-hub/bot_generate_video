import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot, clickWithForceFallback } from "../src/automation/aiVideo";

/**
 * Dry-run KHÔNG bấm Generate — chỉ chạy hết các bước chuẩn bị (chuyển mode
 * Reference to Video, upload ref, chọn model MiniMax H3, gõ prompt + mention)
 * rồi dừng lại chụp ảnh, để verify miễn phí (không tốn credit) trước khi
 * chạy generateVideo() thật.
 */
async function main(): Promise<void> {
  // Import động các hàm private-ish qua module — gọi lại đúng logic thật
  // bằng cách generateVideo với 1 "cờ dry-run" không tồn tại thì phức tạp,
  // nên ở đây COPY lại đúng trình tự các bước đầu của generateVideo (KHÔNG
  // gọi generateButtonLocator.click()) để kiểm tra trực quan qua screenshot.
  const { getPolloBrowserContext: getCtx } = await import("../src/automation/polloBrowser");
  const context = await getCtx();
  const page = await context.newPage();
  const jobId = "debug-pollo-video-reference";
  try {
    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const pollo = await import("../src/automation/pollo");
    await pollo.dismissBlockingOverlays(page);

    const selectors = await import("../src/automation/polloSelectors");

    console.log("Switching to Reference to Video...");
    const chip = selectors.modeChipLocator(page).first();
    await chip.click({ timeout: 10_000 });
    await selectors.modeMenuOptionLocator(page, "Reference to Video").first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);

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

    console.log("Selecting model MiniMax H3 (retry-loop approach, 9th attempt)...");
    await pollo.dismissBlockingOverlays(page);
    const modelChip = selectors.modelChipLocator(page).first();
    const currentModelLabel = await modelChip.innerText().catch(() => "");
    console.log("Current model label before:", currentModelLabel);
    await modelChip.click({ timeout: 10_000 });
    const searchInput = page.locator('input[placeholder="Search…"]');
    await searchInput.fill("MiniMax H3").catch(() => {});
    await page.waitForTimeout(800);
    const row = selectors.modelDialogOptionLocator(page, "MiniMax H3").first();
    await row.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await page.waitForTimeout(300);

    console.log("Hovering over row first (theory: popover only lifts its inert-lock after a real pointermove/hover over its content, which a direct click-jump may skip)...");
    const hoverResult = await row.hover({ timeout: 3000 }).then(() => "ok").catch((e) => String(e));
    console.log("Hover result:", hoverResult);
    await page.waitForTimeout(1000);

    const retryDeadline = Date.now() + 20_000;
    let attempts = 0;
    let lastError: unknown;
    while (Date.now() < retryDeadline) {
      attempts += 1;
      try {
        await row.click({ timeout: 1_500, position: { x: 10, y: 5 } });
        lastError = undefined;
        console.log(`Click succeeded on attempt #${attempts}`);
        break;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(400);
      }
    }
    console.log(`Total click attempts: ${attempts}`);
    if (lastError) {
      console.log("Last error:", lastError instanceof Error ? lastError.message : lastError);
    }

    await page.waitForTimeout(500);
    const modelLabelAfter = await modelChip.innerText().catch(() => "");
    console.log("Model label after:", modelLabelAfter);

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
