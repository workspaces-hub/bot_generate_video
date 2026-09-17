import { config } from "../src/config";
import { getPolloImageBrowserContext } from "../src/automation/polloBrowser";
import { gotoPolloWithRetry, dismissBlockingOverlays, selectModel } from "../src/automation/pollo";
import { signInIndicatorCandidates } from "../src/automation/polloSelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureSnapshot, captureErrorSnapshot } from "../src/automation/aiVideo";

/**
 * Tái hiện lỗi thật (job người_vợ_báo_thù_-Y_CHARACTER_LIN_YIN, 2026-09-17):
 * selectModel(page, "GPT Image 2") timeout 10s vì 1 <rect> SVG trong suốt
 * (pointer-events: auto, x=191, width=calc(100vw - 191px), height=100%)
 * chặn click — chưa rõ đây là overlay gì, dismissBlockingOverlays hiện
 * KHÔNG xử lý được. Mở /image, dismissBlockingOverlays, chụp DOM NGAY
 * TRƯỚC lúc gọi selectModel để tìm đúng phần tử này.
 *
 * Cách dùng: npx tsx scripts/inspect-pollo-model-overlay.ts
 */
async function main(): Promise<void> {
  const context = await getPolloImageBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-model-overlay";
  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      console.log("Chưa đăng nhập pollo.ai. Chạy: npm run login-pollo");
      process.exit(1);
    }

    await captureSnapshot(page, jobId, "before-select-model", { includeHtml: true });
    console.log(`Đã chụp storage/debug/${jobId}.{png,html} — ngay trước selectModel.`);

    // Tìm mọi <rect> có pointer-events: auto trên trang — nghi là thủ phạm.
    const rects = await page.locator("rect").all();
    console.log(`\nTìm thấy ${rects.length} <rect> trên trang — in các rect có pointer-events auto:`);
    for (const rect of rects) {
      const style = await rect.getAttribute("style").catch(() => null);
      const pointerEvents = await rect.getAttribute("pointer-events").catch(() => null);
      if ((style && style.includes("pointer-events")) || pointerEvents === "auto") {
        const outerHtml = await rect.evaluate((el) => el.outerHTML).catch(() => "");
        const parentHtml = await rect
          .evaluate((el) => el.parentElement?.outerHTML.slice(0, 300))
          .catch(() => "");
        console.log(`  rect: ${outerHtml}`);
        console.log(`  parent: ${parentHtml}\n`);
      }
    }

    console.log("Thử gọi selectModel(page, 'GPT Image 2')...");
    try {
      await selectModel(page, "GPT Image 2");
      console.log("selectModel THÀNH CÔNG — không tái hiện được lỗi lần này.");
    } catch (err) {
      console.log("selectModel LỖI (tái hiện được):", err instanceof Error ? err.message : err);
      await captureSnapshot(page, jobId, "after-select-model-fail", { includeHtml: true });
      console.log(`Đã chụp storage/debug/${jobId}.{png,html} — lúc lỗi.`);
    }
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
