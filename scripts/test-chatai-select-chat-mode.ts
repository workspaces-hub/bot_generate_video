import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import { selectChatMode, selectWorkMode } from "../src/automation/chatAI";
import {
  chatModeToggleLocator,
  workModeToggleLocator,
  signInIndicatorCandidates,
} from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot } from "../src/automation/aiVideo";

/**
 * Test THẬT selectChatMode (chatAI.ts) — theo yêu cầu "sửa askChatAI chọn
 * chat thay vì work". Chuyển sang Work trước (để đảm bảo có thay đổi thật
 * sự cần xác nhận, không phải đã sẵn ở Chat từ trước), rồi gọi
 * selectChatMode và đọc lại DOM để xác nhận đã về đúng "Chat".
 *
 * Cách dùng: npx tsx scripts/test-chatai-select-chat-mode.ts
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "test-chatai-select-chat-mode";
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
      console.log("Chưa đăng nhập ChatAI. Chạy: npm run login-chatai");
      process.exit(1);
    }

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    console.log("Chuyển sang Work trước (để có thay đổi thật cần xác nhận)...");
    await selectWorkMode(page, jobId);
    await page.waitForTimeout(500);
    const workCheckedBefore = await workModeToggleLocator(page)
      .first()
      .getAttribute("aria-checked")
      .catch(() => null);
    console.log(`Work aria-checked (trước khi gọi selectChatMode): "${workCheckedBefore}"`);

    console.log("\nGọi selectChatMode...");
    await selectChatMode(page, jobId);
    await page.waitForTimeout(500);

    const chatChecked = await chatModeToggleLocator(page)
      .first()
      .getAttribute("aria-checked")
      .catch(() => null);
    const workCheckedAfter = await workModeToggleLocator(page)
      .first()
      .getAttribute("aria-checked")
      .catch(() => null);
    console.log(`Chat aria-checked (sau): "${chatChecked}"`);
    console.log(`Work aria-checked (sau): "${workCheckedAfter}"`);

    if (chatChecked === "true" && workCheckedAfter !== "true") {
      console.log("\n✅ selectChatMode hoạt động đúng — đã chuyển về Chat.");
    } else {
      console.log("\n❌ selectChatMode KHÔNG chuyển đúng sang Chat.");
      process.exit(1);
    }
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
