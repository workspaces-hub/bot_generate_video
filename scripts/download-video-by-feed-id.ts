import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { getBrowserContext } from "../src/automation/browser";
import {
  ensureLoggedIn,
  extractDownloadUrlWithoutWatermark,
  fetchWithRetry,
  getFlightDataText,
  gotoWithRetry,
} from "../src/automation/hailuo";

/**
 * Debug/test: tải video KHÔNG watermark khi đã biết sẵn feedId (data-feed-id
 * của video, xem trong URL trang chi tiết /my-work-detail/ai-video/<feedId>
 * hoặc log job cũ) — không cần dò lại trong lịch sử như
 * download-last-video.ts. Dùng chung logic extractDownloadUrlWithoutWatermark
 * đã sửa (chọn đúng theo khoảng cách ký tự gần feedId nhất trong flight
 * data, xem chú thích hàm đó trong hailuo.ts) để tránh tải nhầm video khác.
 */
async function main(): Promise<void> {
  const feedId = process.argv[2];
  if (!feedId) {
    console.error("Cách dùng: npm run download-video -- <feedId>");
    process.exit(1);
  }

  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const detailUrl = new URL(`/my-work-detail/ai-video/${feedId}`, config.hailuoBaseUrl);
    detailUrl.searchParams.set("source-page", "create");
    await gotoWithRetry(page, detailUrl.toString());
    await ensureLoggedIn(page);

    // gotoWithRetry chỉ chờ domcontentloaded — trang chi tiết là SPA, cần
    // chờ tới khi flight data thật sự xuất hiện trước khi trích xuất.
    await page
      .waitForFunction(
        () => document.documentElement.innerHTML.includes("downloadURLWithoutWatermark"),
        { timeout: 60_000 },
      )
      .catch(() => {});

    const flightData = await getFlightDataText(page);
    const noWatermarkUrl = extractDownloadUrlWithoutWatermark(flightData, feedId);
    console.log(`Đã tìm thấy URL không watermark: ${noWatermarkUrl}`);

    const response = await fetchWithRetry(page, noWatermarkUrl);

    await fs.promises.mkdir(config.downloadDir, { recursive: true });
    const filePath = path.join(config.downloadDir, `${feedId}.mp4`);
    await fs.promises.writeFile(filePath, await response.body());

    console.log(`Đã tải về: ${filePath}`);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Tải video thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
