import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Gõ prompt + bấm Generate THẬT trên pollo.ai (tốn credit thật của tài
 * khoản) rồi chụp lại DOM ở nhiều mốc thời gian trong lúc chờ — dùng để lấy
 * bằng chứng THẬT về cấu trúc kết quả thành công/lỗi trong lịch sử, trước khi
 * viết waitForNewResult / download cho pollo.ts/polloImage.ts. CHỈ chạy khi
 * người dùng đã đồng ý tốn credit test.
 *
 * Cách dùng:
 *   npm run inspect-pollo-generate -- <label> <url> "<prompt>" [số giây chờ, mặc định 90]
 */
async function main(): Promise<void> {
  const [label, targetPath, prompt, waitSecArg] = process.argv.slice(2);
  if (!label || !targetPath || !prompt) {
    console.error(
      'Thiếu tham số. Cách dùng: npm run inspect-pollo-generate -- <label> <url> "<prompt>" [số giây chờ]',
    );
    process.exit(1);
  }
  const waitSec = Number(waitSecArg ?? 90);
  const url = new URL(targetPath, config.polloBaseUrl).toString();

  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = `inspect-pollo-${label}`;
  try {
    console.log(`Đang mở ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const editor = page.locator('[data-testid="prompt-editor"] [contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(500);

    await captureSnapshot(page, `${jobId}-before-generate`, "before-generate");

    const generateButton = page.locator('[data-testid="prompt-generate-btn"]').first();
    await generateButton.click({ timeout: 10_000 });
    console.log("Đã bấm Generate, đang chờ + chụp định kỳ...");

    const start = Date.now();
    let tick = 0;
    while (Date.now() - start < waitSec * 1000) {
      await page.waitForTimeout(15_000);
      tick += 1;
      await captureSnapshot(page, `${jobId}-tick-${tick}`, `tick-${tick}`);
      console.log(`  đã chụp tick ${tick} (${Math.round((Date.now() - start) / 1000)}s)`);
    }

    await captureSnapshot(page, `${jobId}-final`, "final");
    console.log(`Xong. Kiểm tra storage/debug/${jobId}-*.png/.html`);
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
