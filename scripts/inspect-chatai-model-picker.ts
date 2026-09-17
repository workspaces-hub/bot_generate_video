import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import { signInIndicatorCandidates } from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot } from "../src/automation/aiVideo";
import { captureSnapshot } from "../src/automation/aiVideo";

/**
 * Khảo sát DOM thật của toolbar composer ChatGPT — theo yêu cầu "thêm bước
 * chọn model GPT-6 Astra mức độ vừa" trong askChatAI/askChatAIWithInlineContent
 * — hiện CHƯA có bằng chứng DOM nào cho 1 model picker tên "GPT-6 Astra"
 * (chỉ có effortSliderControlLocator/modelSelectorButtonCandidates, xác nhận
 * là 1 THANH TRƯỢT "Power" 5 nấc, không phải danh sách model có tên). Mở
 * trang, chụp toolbar + thử bấm từng nút khả nghi để tìm đúng model picker.
 *
 * Cách dùng: npx tsx scripts/inspect-chatai-model-picker.ts
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-chatai-model-picker";
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
    await page.waitForTimeout(2000);

    console.log("Chuyển sang mode 'Work' trước khi khảo sát model picker (theo yêu cầu người dùng — model có thể chỉ xuất hiện ở mode này)...");
    const workToggle = page.locator('button[role="radio"][data-tpp-toggle-value="work"]').first();
    const workAlreadyOn =
      (await workToggle.getAttribute("aria-checked").catch(() => null)) === "true";
    if (!workAlreadyOn) {
      await workToggle.click({ timeout: 10_000 });
      await page.waitForTimeout(1500);
    }
    console.log(`Mode Work: ${workAlreadyOn ? "đã bật sẵn" : "vừa bật"}.`);

    await captureSnapshot(page, jobId, "before-any-click", { includeHtml: true });
    console.log("Đã chụp storage/debug/inspect-chatai-model-picker.{png,html} — trang composer TRƯỚC khi bấm gì.");

    // Liệt kê MỌI button trong khu vực composer (thường ở cuối trang, gần ô
    // nhập) có thể là model picker — in text + vài attribute quan trọng.
    const buttons = await page.locator("main button").all();
    console.log(`\nTìm thấy ${buttons.length} <button> trong <main> — in các nút có text ngắn (khả nghi model/effort selector):`);
    for (const btn of buttons) {
      const text = await btn.innerText().catch(() => "");
      const trimmed = text.trim();
      if (trimmed && trimmed.length < 40) {
        const ariaLabel = await btn.getAttribute("aria-label").catch(() => null);
        const testId = await btn.getAttribute("data-testid").catch(() => null);
        console.log(`  text="${trimmed}" aria-label="${ariaLabel}" data-testid="${testId}"`);
      }
    }

    console.log("\nBấm nút chọn model/effort (toolbar) để xem popup mở ra...");
    const mediumButton = page
      .locator("button:has(span[data-max-effort])")
      .first();
    await mediumButton.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await captureSnapshot(page, jobId, "after-click-medium", { includeHtml: true });
    console.log("Đã chụp storage/debug/inspect-chatai-model-picker.{png,html} (đè lên bản trước) — popup sau khi bấm 'Medium'.");

    const menuItems = await page.locator('[role="menuitem"], [role="menuitemradio"], [role="option"]').all();
    console.log(`\nTìm thấy ${menuItems.length} menuitem/option trong popup — in text + role + aria-label:`);
    for (const item of menuItems) {
      const text = await item.innerText().catch(() => "");
      const role = await item.getAttribute("role").catch(() => null);
      const ariaLabel = await item.getAttribute("aria-label").catch(() => null);
      console.log(`  role="${role}" aria-label="${ariaLabel}" text="${text.trim().replace(/\n/g, " | ")}"`);
    }

    console.log("\nBấm 'Select model' (chevron) để chuyển sang advanced view (danh sách model đầy đủ)...");
    const selectModelToggle = page
      .locator('[role="menuitem"][aria-label="Select model"]')
      .first();
    await selectModelToggle.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await captureSnapshot(page, jobId, "after-click-select-model", {
      includeHtml: true,
    });
    console.log("Đã chụp storage/debug/inspect-chatai-model-picker.{png,html} (đè lên bản trước) — advanced view.");

    const advancedRadios = await page
      .locator('[data-testid="composer-model-picker-slider-advanced-view"] [role="menuitemradio"]')
      .all();
    console.log(`\nTìm thấy ${advancedRadios.length} model trong advanced view:`);
    for (const item of advancedRadios) {
      const text = await item.innerText().catch(() => "");
      const checked = await item.getAttribute("aria-checked").catch(() => null);
      console.log(`  aria-checked="${checked}" text="${text.trim().replace(/\n/g, " | ")}"`);
    }

    console.log("\nBấm chọn 'GPT-6 Astra'...");
    const astraOption = page
      .locator('[role="menuitemradio"]')
      .filter({ hasText: /^GPT-6 Astra$/ })
      .first();
    await astraOption.click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    await captureSnapshot(page, jobId, "after-select-astra", { includeHtml: true });
    console.log("Đã chụp — sau khi chọn GPT-6 Astra.");

    console.log("\nMở lại menu để xem các mức effort khả dụng cho GPT-6 Astra...");
    const toolbarButtonAfter = page.locator("button:has(span[data-max-effort])").first();
    await toolbarButtonAfter.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await captureSnapshot(page, jobId, "astra-effort-menu", { includeHtml: true });
    console.log("Đã chụp — menu effort cho GPT-6 Astra.");

    const effortItems = await page
      .locator('[role="menuitemradio"], [role="menuitem"][aria-label="Power"], [role="slider"]')
      .all();
    console.log(`\nTìm thấy ${effortItems.length} phần tử liên quan effort:`);
    for (const item of effortItems) {
      const text = await item.innerText().catch(() => "");
      const role = await item.getAttribute("role").catch(() => null);
      const valuenow = await item.getAttribute("aria-valuenow").catch(() => null);
      const valuemax = await item.getAttribute("aria-valuemax").catch(() => null);
      const checked = await item.getAttribute("aria-checked").catch(() => null);
      console.log(
        `  role="${role}" text="${text.trim().replace(/\n/g, " | ")}" aria-checked="${checked}" aria-valuenow="${valuenow}" aria-valuemax="${valuemax}"`,
      );
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
