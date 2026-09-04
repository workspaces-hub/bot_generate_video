import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { firstVisible } from "../src/automation/selectors";
import {
  generateButtonLocator,
  promptEditorLocator,
  resultCardLocator,
  signInIndicatorCandidates,
} from "../src/automation/polloSelectors";

/** Debug: từng bước gõ log rõ ràng để tìm chỗ generateVideo() bị treo. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-video";
  try {
    console.log("1. goto /video...");
    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    console.log("2. goto done, URL:", page.url());

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    console.log("3. networkidle done (or timed out, ignored)");
    await page.waitForTimeout(2000);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    console.log("4. signedOut check done:", signedOut);

    const editor = promptEditorLocator(page).first();
    console.log("5. about to click editor...");
    await editor.click({ timeout: 10_000 });
    console.log("6. editor clicked");

    await page.keyboard.insertText("a paper airplane gliding through a sunny office, slow motion");
    console.log("7. text inserted");
    await page.waitForTimeout(300);

    const baselineCount = await resultCardLocator(page).count();
    console.log("8. baseline count:", baselineCount);

    const generateButton = generateButtonLocator(page).first();
    const isDisabled = await generateButton.getAttribute("aria-disabled");
    console.log("9. generate button aria-disabled:", isDisabled);

    console.log("10. about to click generate...");
    await generateButton.click({ timeout: 10_000 });
    console.log("11. generate clicked!");

    await page.waitForTimeout(5000);
    const countAfter = await resultCardLocator(page).count();
    console.log("12. count after click:", countAfter, "URL:", page.url());

    await captureSnapshot(page, jobId, "debug-after-click");
    console.log("Done, snapshot saved.");
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
