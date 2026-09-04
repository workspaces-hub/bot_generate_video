import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import {
  generateButtonLocator,
  promptEditorLocator,
  resultCardLocator,
  resultImageLocator,
} from "../src/automation/polloSelectors";

/** Debug: gõ prompt, bấm generate, rồi LOG chi tiết mỗi vòng poll (count card, generating-marker, image count, URL hiện tại) — để tìm hiểu vì sao waitForNewResult không detect được lúc trước. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-wait";
  try {
    await page.goto(new URL("/image", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const baselineCount = await resultCardLocator(page).count();
    console.log(`Baseline count: ${baselineCount}, URL: ${page.url()}`);

    const editor = promptEditorLocator(page).first();
    await editor.click();
    await page.keyboard.insertText("a green teapot on a wooden table, soft morning light");
    await page.waitForTimeout(300);

    await generateButtonLocator(page).first().click({ timeout: 10_000 });
    console.log("Clicked generate.");

    for (let tick = 0; tick < 20; tick++) {
      await page.waitForTimeout(8000);
      const count = await resultCardLocator(page).count();
      const url = page.url();
      let generatingCount = -1;
      let imageCount = -1;
      if (count > baselineCount) {
        const last = resultCardLocator(page).last();
        generatingCount = await last.locator('[data-slot="task-card-generating"]').count();
        imageCount = await resultImageLocator(last).count();
      }
      console.log(
        `tick ${tick}: count=${count} url=${url} generatingCount=${generatingCount} imageCount=${imageCount}`,
      );
      if (count > baselineCount && generatingCount === 0 && imageCount > 0) {
        console.log("DONE DETECTED");
        break;
      }
    }

    await captureSnapshot(page, jobId, "debug-final");
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();


function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
}