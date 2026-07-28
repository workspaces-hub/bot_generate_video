import { config } from "../src/config";
import { getBrowserContext } from "../src/automation/browser";
import { captureSnapshot, downloadVideo } from "../src/automation/hailuo";
import { historyVideoLocator } from "../src/automation/selectors";

/**
 * Debug/test: tải video CUỐI CÙNG (mới nhất) trong lịch sử tạo video, dùng
 * lại đúng logic downloadVideo() của bot (điều hướng sang trang chi tiết,
 * đọc downloadURLWithoutWatermark từ Next.js flight data, fetch về).
 * Không cần chạy qua Telegram/queue — tiện để test riêng bước tải xuống.
 */
async function main(): Promise<void> {
  const context = await getBrowserContext();
  const page = await context.newPage();

  const url = new URL(config.hailuoCreatePath, config.hailuoBaseUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // "domcontentloaded" fire rất sớm với SPA (React/Next.js) — DOM rỗng đã
  // coi là "loaded" nhưng UI thực tế chưa kịp render/hydrate. Chờ tới khi
  // có video xuất hiện thật sự (hoặc hết 20s) trước khi đếm/chụp debug.
  const videos = historyVideoLocator(page);
  await videos
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});

  await captureSnapshot(page, "download", "download last");

  const count = await videos.count();
  if (count === 0) {
    throw new Error("Không có video nào trong lịch sử để tải (trang có thể chưa render kịp hoặc chưa đăng nhập).");
  }
  console.log(`Tìm thấy ${count} video trong lịch sử, đang tải video cuối cùng...`);

  const lastVideo = videos.last();
  const filePath = await downloadVideo(page, lastVideo, `last-video-${Date.now()}`);
  console.log(`Đã tải về: ${filePath}`);

  await page.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
