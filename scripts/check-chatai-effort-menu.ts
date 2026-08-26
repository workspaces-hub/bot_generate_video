import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import {
  modelSelectorButtonCandidates,
  signInIndicatorCandidates,
} from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";
import { selectMaxReasoningEffort, selectWorkMode } from "../src/automation/chatAI";

/**
 * Test trực tiếp selectMaxReasoningEffort (chatAI.ts) — chuyển sang mode
 * "Work", đọc nhãn mức hỗ trợ TRƯỚC, gọi hàm chọn mức tối đa, rồi đọc lại
 * nhãn SAU để xác nhận đã đổi đúng thành mức cao nhất.
 *
 * Cách dùng: npm run check-chatai-effort-menu
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "chatai-effort-menu";
  try {
    await page.goto(config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 5000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      console.log("❌ Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai");
      process.exit(1);
    }

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    await selectWorkMode(page);

    const button = await firstVisible(modelSelectorButtonCandidates(page), 10_000);
    const labelBefore = await button.innerText().catch(() => "<không đọc được>");
    console.log(`Nhãn TRƯỚC: "${labelBefore.trim()}" — đang gọi selectMaxReasoningEffort...`);

    await selectMaxReasoningEffort(page);
    await page.waitForTimeout(500);

    const labelAfter = await button.innerText().catch(() => "<không đọc được>");
    console.log(`Nhãn SAU: "${labelAfter.trim()}"`);

    await captureSnapshot(page, jobId, "after-select-max-effort");
    console.log(
      `\nĐã chụp debug trạng thái cuối: storage/debug/${jobId}.png / .html — kiểm tra nhãn SAU có đúng mức cao nhất không.`,
    );
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
