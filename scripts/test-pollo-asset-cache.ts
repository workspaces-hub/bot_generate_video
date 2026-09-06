import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "./../src/automation/polloBrowser";
import { dismissBlockingOverlays, ensureUploadDialogOpen, submitAssetUpload } from "../src/automation/pollo";
import { uploadCardButtonForImage } from "../src/automation/polloSelectors";

/**
 * Test THẬT cache upload (theo yêu cầu "tận dụng check ảnh tham chiếu đã
 * upload chưa"): gọi submitAssetUpload 2 LẦN LIÊN TIẾP với CÙNG 1 file — lần
 * 1 phải upload thật (chậm hơn), lần 2 phải nhận ra cache và CHỌN LẠI (nhanh
 * hơn hẳn, không setInputFiles lại) — cùng trả về ĐÚNG 1 assetUrl.
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

    const imagePath = path.resolve(
      "./storage/generated/microdrama_co_dau_phan_boi_twist_prompt/LOC_LUXURY_HOTEL_HALLWAY.jpg",
    );
    console.log("Dùng file test:", imagePath);

    const openDialog = () => ensureUploadDialogOpen(page, uploadCardButtonForImage(page).first());

    console.log("\n>>> LẦN 1 (kỳ vọng: upload thật, chậm hơn) ---");
    await openDialog();
    const t1 = Date.now();
    const url1 = await submitAssetUpload(page, imagePath, openDialog);
    console.log(`Lần 1 xong sau ${Date.now() - t1}ms — assetUrl: ${url1}`);

    // Đóng dialog (bấm lại toggle) để mô phỏng đúng luồng thật: mỗi ảnh tham
    // chiếu tiếp theo trong generateVideo() đều tự mở lại dialog riêng.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1000);

    console.log("\n>>> LẦN 2 (kỳ vọng: cache hit, chọn lại, nhanh hơn hẳn) ---");
    await openDialog();
    const t2 = Date.now();
    const url2 = await submitAssetUpload(page, imagePath, openDialog);
    console.log(`Lần 2 xong sau ${Date.now() - t2}ms — assetUrl: ${url2}`);

    console.log("\n=== KẾT QUẢ ===");
    console.log("2 lần trả về CÙNG assetUrl?", url1 === url2);
    console.log("Lần 2 nhanh hơn rõ rệt (cache hit, bỏ qua setInputFiles+poll)?", Date.now() - t2 < 5000);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
