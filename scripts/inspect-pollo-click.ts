import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Giống inspect-pollo.ts nhưng CLICK LẦN LƯỢT qua nhiều selector (Playwright
 * locator syntax — CSS thường, hoặc "text=..."/"role=...") trước khi chụp —
 * dùng để lấy bằng chứng DOM của các dialog/popover chỉ xuất hiện SAU khi
 * tương tác (vd mở dropdown mode rồi chọn 1 option trong đó).
 *
 * Cách dùng:
 *   npm run inspect-pollo-click -- <label> <url> <selector1> [selector2] [selector3] ...
 * Ví dụ (mở dropdown mode rồi chọn "Frames to Video"):
 *   npm run inspect-pollo-click -- video-frames-mode /video "button[data-button-name='func']" "text=Frames to Video"
 */
async function main(): Promise<void> {
  const [label, targetPath, ...selectors] = process.argv.slice(2);
  if (!label || !targetPath || selectors.length === 0) {
    console.error(
      "Thiếu tham số. Cách dùng: npm run inspect-pollo-click -- <label> <url> <selector1> [selector2] ...",
    );
    process.exit(1);
  }
  const url = new URL(targetPath, config.polloBaseUrl).toString();

  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = `inspect-pollo-${label}`;
  try {
    console.log(`Đang mở ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    for (const selector of selectors) {
      console.log(`Đang click "${selector}"...`);
      await page.locator(selector).first().click({ timeout: 10_000 });
      await page.waitForTimeout(1000);
    }

    await captureSnapshot(page, jobId, label);
    console.log(
      `Đã chụp SAU KHI click: storage/debug/${jobId}.png và storage/debug/${jobId}.html`,
    );
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
