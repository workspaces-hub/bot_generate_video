import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";

/** One-off: tìm control chọn ĐỘ DÀI video trên composer /reference-to-video
 * (deep-link với model MiniMax H3) — in ra toàn bộ nội dung text/HTML của div
 * [data-button-name="params"] để xem có chip/button nào khác model không
 * (vd "5s"/"6s"/"10s"), rồi thử bấm nếu tìm thấy ứng viên rõ ràng. */
async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-duration";
  try {
    const url = new URL(
      "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
      config.polloBaseUrl,
    ).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    const paramsHtml = await page
      .locator('div[data-button-name="params"]')
      .first()
      .evaluate((el) => el.outerHTML)
      .catch((e) => `ERROR: ${e}`);
    console.log("=== params div outerHTML ===");
    console.log(paramsHtml);

    // Cũng in text toàn bộ composer area (khu vực chứa prompt editor + các chip)
    // để không bỏ sót nếu duration nằm NGOÀI div params.
    const composerText = await page
      .locator('[data-testid="prompt-editor"]')
      .first()
      .evaluate((el) => {
        // Đi lên vài cấp cha để lấy toàn bộ vùng chip phía trên/dưới prompt.
        let node: Element | null = el;
        for (let i = 0; i < 4 && node?.parentElement; i++) node = node.parentElement;
        return node?.outerHTML ?? "(no parent found)";
      })
      .catch((e) => `ERROR: ${e}`);
    console.log("=== composer ancestor outerHTML (truncated to 8000 chars) ===");
    console.log(String(composerText).slice(0, 8000));

    await captureSnapshot(page, jobId, "duration-inspect");
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
