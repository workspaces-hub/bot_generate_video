import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Mở pollo.ai bằng session đã lưu (npm run login-pollo) rồi điều hướng tới 1
 * URL cụ thể, chụp lại screenshot + HTML vào storage/debug/<label>.png/.html
 * — dùng để lấy BẰNG CHỨNG DOM THẬT trước khi viết selector cho
 * polloSelectors.ts/pollo.ts/polloImage.ts (clone aiVideo.ts/aiVideoImage.ts
 * sang provider pollo.ai), thay vì đoán mù cấu trúc trang.
 *
 * Cách dùng:
 *   npm run inspect-pollo -- <label> [url tương đối hoặc tuyệt đối, mặc định "/"]
 * Ví dụ:
 *   npm run inspect-pollo -- home
 *   npm run inspect-pollo -- create-image /create/image
 */
async function main(): Promise<void> {
  const label = process.argv[2];
  if (!label) {
    console.error(
      'Thiếu tham số. Cách dùng: npm run inspect-pollo -- <label> [url tương đối hoặc tuyệt đối, mặc định "/"]',
    );
    process.exit(1);
  }
  const targetPath = process.argv[3] ?? "/";
  const url = new URL(targetPath, config.polloBaseUrl).toString();

  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = `inspect-pollo-${label}`;
  try {
    console.log(`Đang mở ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    // Chờ thêm 1 nhịp — SPA có thể còn hydrate sau khi mạng đã rảnh (cùng lý
    // do đã xác nhận với AIVideo/ChatAI).
    await page.waitForTimeout(3000);

    await captureSnapshot(page, jobId, label);
    console.log(`URL cuối cùng: ${page.url()}`);
    console.log(
      `Đã chụp: storage/debug/${jobId}.png và storage/debug/${jobId}.html`,
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
