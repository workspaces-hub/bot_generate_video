import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import {
  selectWorkMode,
  selectModelGPT6AstraMediumEffort,
} from "../src/automation/chatAI";
import {
  effortSliderThumbLocator,
  signInIndicatorCandidates,
} from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Test THẬT selectModelGPT6AstraMediumEffort (chatAI.ts) — theo yêu cầu
 * "thêm bước chọn model GPT-6 Astra mức độ vừa" trong askChatAI/
 * askChatAIWithInlineContent. Chỉ gọi ĐÚNG hàm chọn model/effort (không chạy
 * cả askChatAI tốn thời gian chờ trả lời), rồi đọc lại DOM thật để xác nhận
 * model + effort đã chọn đúng.
 *
 * Cách dùng: npx tsx scripts/test-chatai-select-model.ts
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "test-chatai-select-model";
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

    await selectWorkMode(page, jobId);
    await selectModelGPT6AstraMediumEffort(page, jobId);

    // Đọc lại DOM THẬT sau khi hàm chạy xong (không tin log của chính hàm —
    // xác minh độc lập) — bấm lại nút toolbar để xem nhãn model/effort hiện
    // tại đang hiển thị gì.
    await page.waitForTimeout(1000);
    const toolbarButton = page.locator("button:has(span[data-max-effort])").first();
    const toolbarText = await toolbarButton.innerText().catch(() => "(không đọc được)");
    console.log(`\nNhãn nút toolbar sau khi chọn: "${toolbarText.trim().replace(/\n/g, " | ")}"`);

    await toolbarButton.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const thumb = effortSliderThumbLocator(page).first();
    const valueNow = await thumb.getAttribute("aria-valuenow").catch(() => null);
    const valueMax = await thumb.getAttribute("aria-valuemax").catch(() => null);
    console.log(`Slider effort: aria-valuenow="${valueNow}" aria-valuemax="${valueMax}"`);

    await captureSnapshot(page, jobId, "final-state", { includeHtml: false });
    console.log(`\nẢnh debug: storage/debug/${jobId}.png`);
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
