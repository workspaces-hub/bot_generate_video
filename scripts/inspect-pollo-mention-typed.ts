import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import {
  modeChipLocator,
  modeMenuOptionLocator,
  promptEditorLocator,
} from "../src/automation/polloSelectors";

/** One-off: mở /video, chuyển "Reference to Video", gõ text thường RỒI gõ "@" bằng bàn phím (không click nút Mention chuyên dụng) — xem có mở picker mention tương tự không. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-mention-typed";
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

    const editor = promptEditorLocator(page).first();
    await editor.click();
    await page.keyboard.insertText("A cinematic shot featuring ");
    await page.waitForTimeout(300);
    console.log("Typed base text, now typing @ via keyboard...");
    await page.keyboard.type("@", { delay: 100 });
    await page.waitForTimeout(1000);

    await captureSnapshot(page, jobId, "after-typed-at");
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
