import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import {
  assetPickerCardLocator,
  uploadCardButtonForImage,
  uploadDialogFileInputLocator,
} from "../src/automation/polloSelectors";

/**
 * One-off: thử upload lại ĐÚNG file LOC_LUXURY_HOTEL_HALLWAY.jpg (đã đổi
 * đuôi đúng .jpg) vào mode Reference to Video, chụp snapshot NHIỀU LẦN trong
 * lúc chờ (5s, 15s, 25s) thay vì chờ hết 30s mới chụp 1 lần lúc lỗi — để
 * xem CÓ toast/thông báo từ chối nào thoáng qua không (nghi ảnh bị từ chối
 * do "Image too small" — ảnh 720x1280, cạnh ngắn 720px, có thể dưới ngưỡng
 * tối thiểu của model 768p).
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-upload-stuck";
  try {
    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    await uploadCardButtonForImage(page).first().click({ timeout: 10_000 });
    console.log("Đã bấm nút upload, dialog nên đang mở.");

    const cards = assetPickerCardLocator(page);
    const countBefore = await cards.count();
    console.log("Số card trước khi upload:", countBefore);

    const filePath = path.resolve(
      "./storage/generated/microdrama_co_dau_phan_boi_twist_prompt/LOC_LUXURY_HOTEL_HALLWAY.jpg",
    );
    console.log("Upload file:", filePath);
    await uploadDialogFileInputLocator(page).setInputFiles(filePath, { timeout: 10_000 });
    console.log("setInputFiles xong, bắt đầu theo dõi...");

    for (const waitMs of [5000, 10000, 10000]) {
      await page.waitForTimeout(waitMs);
      const count = await cards.count();
      const toastText = await page
        .locator('[data-slot="toast-viewport"]')
        .innerText()
        .catch(() => "(không đọc được)");
      console.log(`[+${waitMs}ms] số card hiện tại: ${count}, toast: "${toastText}"`);
      await captureSnapshot(page, jobId, `after-${waitMs}ms`);
    }

    console.log("Hoàn tất theo dõi 25s.");
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
