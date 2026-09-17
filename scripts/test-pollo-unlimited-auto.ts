import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { dismissBlockingOverlays, enableUnlimitedIfNotEnoughCredit } from "../src/automation/pollo";

/** Test thật enableUnlimitedIfNotEnoughCredit trên /image (credit tài khoản test hiện = 0). */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const sw = page.locator('div[data-button-name="is_unlimited"] [role="switch"]').first();
    console.log("aria-checked TRƯỚC:", await sw.getAttribute("aria-checked").catch(() => "(không tìm thấy)"));

    await enableUnlimitedIfNotEnoughCredit(page, "test-pollo-unlimited-auto");

    console.log("aria-checked SAU:", await sw.getAttribute("aria-checked").catch(() => "(không tìm thấy)"));

    // Gọi lại lần 2 — kỳ vọng: đã bật rồi thì bỏ qua (không throw, không log "tự bật").
    console.log("\n>>> Gọi lại lần 2 (kỳ vọng: bỏ qua vì đã bật) ---");
    await enableUnlimitedIfNotEnoughCredit(page, "test-pollo-unlimited-auto");
    console.log("aria-checked sau lần gọi thứ 2:", await sw.getAttribute("aria-checked").catch(() => "(?)"));
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
