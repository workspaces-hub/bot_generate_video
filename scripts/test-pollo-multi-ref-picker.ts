import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import {
  dismissBlockingOverlays,
  ensureComposerReadyOrThrow,
  ensureUploadDialogOpen,
  gotoPolloWithRetry,
  submitAssetUpload,
} from "../src/automation/pollo";
import {
  uploadCardButtonForImage,
  uploadDialogSelectButtonLocator,
} from "../src/automation/polloSelectors";
import path from "node:path";

/**
 * Test THẬT (KHÔNG generate, chỉ upload+select 3 ảnh liên tiếp giống hệt
 * loop trong generateVideo) — kiểm tra xem nút "Select (x/y)" trong asset
 * picker có TÍCH LŨY selection qua các lần gọi submitAssetUpload riêng biệt
 * hay không (nghi vấn từ lỗi thật job test_normal_7_rep_SHOT_04_CLIP_02:
 * click "Select (3/9)" kích hoạt navigation thật, reset sạch composer,
 * canonical URL rơi về "/reference-to-video" không còn query deep-link).
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const url = new URL(
    "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
    config.polloBaseUrl,
  ).toString();

  const images = [
    path.resolve("./storage/reference-images/cay_khe/LOC_TREASURE_ISLAND.png"),
    path.resolve("./storage/reference-images/cay_khe/SCENE_04_START.png"),
    path.resolve("./storage/reference-images/cay_khe/SCENE_09_START.png"),
  ];

  await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissBlockingOverlays(page);
  await ensureComposerReadyOrThrow(page, url, "test multi-ref picker");

  for (const [i, imagePath] of images.entries()) {
    const openDialog = () =>
      ensureUploadDialogOpen(page, uploadCardButtonForImage(page).first());
    await openDialog();
    console.log(`\n--- Upload #${i + 1}: ${path.basename(imagePath)} ---`);
    const selectBtnBefore = await uploadDialogSelectButtonLocator(page)
      .innerText()
      .catch(() => "(không đọc được)");
    console.log("Nút Select TRƯỚC khi chọn thumbnail:", selectBtnBefore);
    await submitAssetUpload(page, imagePath, openDialog);
    console.log("URL sau khi Select:", page.url());
  }

  console.log("\n=== XONG, URL cuối:", page.url());
  await page.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
