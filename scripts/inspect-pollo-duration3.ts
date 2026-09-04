import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";

/** One-off: mở chip settings (params thứ 2, dạng "5s | 480p | 16:9 | 1") trên
 * /video mặc định — xem cấu trúc DOM khi mở ra (options độ dài cụ thể nào,
 * có "6s" không) — rồi thử tương tự sau khi đổi sang model MiniMax H3 xem
 * option độ dài có đổi theo model không. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-duration3";
  try {
    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const settingsChips = page.locator('div[data-button-name="params"]');
    const count = await settingsChips.count();
    console.log(`Found ${count} [data-button-name="params"] elements.`);
    for (let i = 0; i < count; i++) {
      const text = await settingsChips.nth(i).innerText().catch(() => "");
      console.log(`  [${i}] text="${text}"`);
    }

    // Chip thứ 2 (index 1) là settings (duration/resolution/aspect/count) —
    // click vào PHẦN "5s" cụ thể (thường mỗi segment tự là 1 button con riêng).
    const settingsChip = settingsChips.nth(1);
    console.log("Clicking settings chip (index 1)...");
    await settingsChip.click({ timeout: 10_000 });
    await page.waitForTimeout(800);

    const popupHtml = await page
      .locator('[data-slot="popover-popup"], [role="dialog"], .chat-popup-surface')
      .first()
      .evaluate((el) => el.outerHTML)
      .catch((e) => `ERROR: ${e}`);
    console.log("=== Popup HTML (first 6000 chars) ===");
    console.log(String(popupHtml).slice(0, 6000));

    await captureSnapshot(page, jobId, "settings-popup-pollo2");
    console.log("Snapshot saved (Pollo 2.0 default model).");
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
