import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { dismissBlockingOverlays, deleteStaleUploadedAssets } from "../src/automation/pollo";
import { assetPickerCardLocator, uploadCardButtonForImage } from "../src/automation/polloSelectors";

/** URL asset pollo.ai luôn có dạng ".../<13 số epoch ms>-<uuid>.<ext>" — copy từ pollo.ts để log tuổi từng card mà không cần export thêm. */
function extractAssetTimestampMs(url: string): number | null {
  const m = url.match(/\/(\d{13})-/);
  return m ? Number(m[1]) : null;
}

/**
 * Test THẬT deleteStaleUploadedAssets (đã export tạm cho mục đích test) —
 * theo yêu cầu người dùng "test lại xoá ảnh thật". Mở dialog Uploads, log
 * tuổi vài card cũ nhất TRƯỚC khi xoá, gọi hàm thật, rồi log lại SAU khi xoá
 * để xác nhận card cũ (>60 phút, xem STALE_ASSET_THRESHOLD_MS trong pollo.ts)
 * đã biến mất thật, còn card mới (<60 phút) vẫn còn nguyên.
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
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
    await page.waitForTimeout(1500);

    const cards = assetPickerCardLocator(page);
    const countBefore = await cards.count();
    console.log("Số card TRƯỚC khi xoá:", countBefore);

    const now = Date.now();
    console.log("--- 5 card cũ nhất TRƯỚC khi xoá ---");
    for (let i = 0; i < Math.min(5, countBefore); i++) {
      const idx = countBefore - 1 - i;
      const u = await cards.nth(idx).getAttribute("data-asset-url").catch(() => null);
      const ts = u ? extractAssetTimestampMs(u) : null;
      const ageMin = ts ? Math.round((now - ts) / 60000) : null;
      console.log(`[${idx}] tuổi ~${ageMin} phút — ${u}`);
    }

    console.log("\n>>> Gọi deleteStaleUploadedAssets thật...\n");
    await deleteStaleUploadedAssets(page);

    const countAfter = await cards.count();
    console.log("Số card SAU khi xoá:", countAfter);
    console.log("Đã xoá:", countBefore - countAfter, "card (lưu ý: có thể có card MỚI của job khác chèn vào giữa lúc test, số liệu chỉ mang tính tham khảo).");

    console.log("--- 5 card cũ nhất SAU khi xoá ---");
    const countAfter2 = await cards.count();
    for (let i = 0; i < Math.min(5, countAfter2); i++) {
      const idx = countAfter2 - 1 - i;
      const u = await cards.nth(idx).getAttribute("data-asset-url").catch(() => null);
      const ts = u ? extractAssetTimestampMs(u) : null;
      const ageMin = ts ? Math.round((Date.now() - ts) / 60000) : null;
      console.log(`[${idx}] tuổi ~${ageMin} phút — ${u}`);
    }
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
