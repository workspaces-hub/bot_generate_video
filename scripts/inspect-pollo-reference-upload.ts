import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import {
  assetPickerCardLocator,
  modeChipLocator,
  modeMenuOptionLocator,
  uploadDialogFileInputLocator,
  uploadDialogSelectButtonLocator,
} from "../src/automation/polloSelectors";

/** One-off: mở /video, chuyển mode "Reference to Video", upload 1 ảnh tham chiếu, chụp lại composer SAU khi upload xong (để xem thumbnail/@ mention xuất hiện thế nào), rồi bấm nút "@" để xem picker. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-reference-upload";
  try {
    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    await modeChipLocator(page).first().click({ timeout: 10_000 });
    await modeMenuOptionLocator(page, "Reference to Video").first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    console.log("Switched to Reference to Video mode.");

    const imageUploadButton = page.locator(
      'div.group\\/image-upload [data-testid="upload-card-asset-picker"]',
    );
    await imageUploadButton.first().click({ timeout: 10_000 });
    console.log("Opened upload dialog.");

    const cards = assetPickerCardLocator(page);
    const countBefore = await cards.count();
    const refPath = path.resolve("./storage/downloads/test-pollo-image-e2e.png");
    await uploadDialogFileInputLocator(page).setInputFiles(refPath, { timeout: 10_000 });
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-testid="asset-picker-card"]').length >= expected,
      countBefore + 1,
      { timeout: 30_000 },
    );
    console.log("Uploaded, thumbnail appeared.");

    const newCardIndex = (await cards.count()) - 1;
    await cards.nth(newCardIndex).click({ timeout: 10_000 });
    await uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
    console.log("Selected + confirmed.");

    await page.waitForTimeout(1000);
    await captureSnapshot(page, jobId, "after-upload-select");
    console.log("Snapshot after upload+select saved.");

    // getByRole KHÔNG dùng được — nút "@" nằm trong placeholder có
    // aria-hidden="true" trên div cha (ẩn khỏi accessibility tree dù
    // pointer-events vẫn "auto"/vẫn click được thật bằng chuột) — dùng
    // locator theo attribute thay vì role.
    const mentionButton = page.locator('button[aria-label="Mention"]');
    await mentionButton.first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    await captureSnapshot(page, `${jobId}-mention-picker`, "mention-picker");
    console.log("Snapshot of mention picker saved.");
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
