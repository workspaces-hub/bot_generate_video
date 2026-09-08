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
  assetPickerCardLocator,
  uploadCardButtonForImage,
  uploadDialogSelectButtonLocator,
} from "../src/automation/polloSelectors";
import path from "node:path";

/**
 * Tiếp nối test-pollo-multi-ref-picker: xác nhận nút "Select" TÍCH LŨY số
 * đã chọn qua các lần mở lại dialog riêng biệt ("Select (1/9)" xuất hiện
 * NGAY khi mở lại, trước khi bấm ảnh mới). Giờ dump outerHTML của các card
 * để tìm đúng attribute/class đánh dấu "đã chọn" — cần biết để viết code
 * bỏ chọn (uncheck) trước khi chọn ảnh mới, tránh tích lũy dẫn tới lỗi thật
 * (Select (3/9) kích hoạt navigation lạ, reset composer).
 */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const url = new URL(
    "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
    config.polloBaseUrl,
  ).toString();

  await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissBlockingOverlays(page);
  await ensureComposerReadyOrThrow(page, url, "inspect picker selection");

  const openDialog = () =>
    ensureUploadDialogOpen(page, uploadCardButtonForImage(page).first());

  await openDialog();
  const imagePath = path.resolve("./storage/reference-images/cay_khe/LOC_TREASURE_ISLAND.png");
  await submitAssetUpload(page, imagePath, openDialog);
  console.log("Upload #1 xong. URL:", page.url());

  // Mở lại dialog — kỳ vọng thấy "Select (1/9)" (tích lũy từ lần trước).
  await openDialog();
  const btnText = await uploadDialogSelectButtonLocator(page).innerText().catch(() => "(?)");
  console.log("Nút Select khi mở lại:", btnText);

  const cards = assetPickerCardLocator(page);
  const count = await cards.count();
  console.log(`Tổng số card trong picker: ${count}`);
  for (let i = 0; i < Math.min(count, 5); i++) {
    const html = await cards.nth(i).evaluate((el) => el.outerHTML).catch(() => "(lỗi đọc)");
    console.log(`\n--- card[${i}] outerHTML ---\n${html.slice(0, 1000)}`);
  }

  await page.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
