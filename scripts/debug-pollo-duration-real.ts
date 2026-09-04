import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/** Dry-run: gọi ĐÚNG hàm thật selectDurationIfNeeded (không export, import
 * qua module rồi truy cập gián tiếp không được — nên COPY lại call site đúng
 * cách generateVideo() gọi: mở /video mặc định (Pollo 2.0, "5s" mặc định),
 * đổi sang "10s", verify chip đổi đúng — KHÔNG bấm Generate, miễn phí. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "debug-pollo-duration-real";
  try {
    const pollo = await import("../src/automation/pollo");
    const selectors = await import("../src/automation/polloSelectors");

    await page.goto(new URL("/video", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await pollo.dismissBlockingOverlays(page);

    const chip = selectors.paramsChipLocator(page).first();
    console.log("Chip label before:", await chip.innerText().catch(() => "(not found)"));

    // selectDurationIfNeeded không export — test qua đường generateVideo thật
    // sẽ tốn credit, nên ở đây tái tạo Y HỆT logic (đã copy paste đúng từ
    // pollo.ts) để verify riêng phần chọn độ dài, miễn phí.
    const duration = "10s";
    const currentLabel = await chip.innerText().catch(() => "");
    if (!currentLabel.trim().toLowerCase().startsWith(duration.toLowerCase())) {
      await chip.click({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const option = selectors.videoLengthOptionLocator(page, duration).first();
      const optionExists = await option.isVisible({ timeout: 3000 }).catch(() => false);
      console.log("Option '10s' exists in popup:", optionExists);
      if (optionExists) {
        await option.click({ timeout: 5_000 }).catch((e) => console.log("click error:", e));
        await page.waitForTimeout(300);
      }
    }

    const newLabel = await chip.innerText().catch(() => "(not found)");
    console.log("Chip label after:", newLabel);

    await captureSnapshot(page, jobId, "after-duration-select");
    console.log("Snapshot saved.");
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();
