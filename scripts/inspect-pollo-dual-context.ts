import { config } from "../src/config";
import { getPolloBrowserContext, getPolloImageBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { signInIndicatorCandidates } from "../src/automation/polloSelectors";
import { firstVisible } from "../src/automation/selectors";

/** One-off: mở 2 BrowserContext RIÊNG (getPolloBrowserContext cho video,
 * getPolloImageBrowserContext cho ảnh) CÙNG LÚC, cùng đăng nhập 1 tài khoản
 * pollo.ai (đọc chung storageState) — kiểm tra xem có bị đăng xuất/xung đột
 * gì không khi cả 2 cùng hoạt động song song. Miễn phí, chỉ điều hướng +
 * kiểm tra trạng thái đăng nhập, KHÔNG generate gì. */
async function main(): Promise<void> {
  const videoContext = await getPolloBrowserContext();
  const imageContext = await getPolloImageBrowserContext();
  const videoPage = await videoContext.newPage();
  const imagePage = await imageContext.newPage();
  try {
    console.log("Navigating BOTH pages concurrently...");
    await Promise.all([
      videoPage.goto(new URL("/video", config.polloBaseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      }),
      imagePage.goto(new URL("/image", config.polloBaseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      }),
    ]);
    await Promise.all([
      videoPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
      imagePage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    ]);
    await videoPage.waitForTimeout(2000);
    await imagePage.waitForTimeout(2000);

    const videoSignedOut = await firstVisible(signInIndicatorCandidates(videoPage), 3000)
      .then(() => true)
      .catch(() => false);
    const imageSignedOut = await firstVisible(signInIndicatorCandidates(imagePage), 3000)
      .then(() => true)
      .catch(() => false);

    console.log("Video page signed out?", videoSignedOut);
    console.log("Image page signed out?", imageSignedOut);

    // Đợi thêm 1 nhịp rồi kiểm tra lại — phòng trường hợp site cần vài giây
    // để phát hiện + đăng xuất phiên trùng (nếu có cơ chế đó).
    await videoPage.waitForTimeout(5000);
    const videoSignedOutAfterWait = await firstVisible(signInIndicatorCandidates(videoPage), 3000)
      .then(() => true)
      .catch(() => false);
    const imageSignedOutAfterWait = await firstVisible(signInIndicatorCandidates(imagePage), 3000)
      .then(() => true)
      .catch(() => false);
    console.log("Video page signed out (after 5s wait)?", videoSignedOutAfterWait);
    console.log("Image page signed out (after 5s wait)?", imageSignedOutAfterWait);

    await captureSnapshot(videoPage, "dual-context-video", "dual-context-video");
    await captureSnapshot(imagePage, "dual-context-image", "dual-context-image");
    console.log("Snapshots saved for both pages.");
  } catch (err) {
    await captureErrorSnapshot(videoPage, "dual-context-video", err);
    await captureErrorSnapshot(imagePage, "dual-context-image", err);
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await videoPage.close();
    await imagePage.close();
    process.exit(0);
  }
}

main();
