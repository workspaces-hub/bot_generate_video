import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import { config } from "../src/config";
import { signInIndicatorCandidates } from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot, captureSnapshot } from "../src/automation/aiVideo";

/**
 * Đọc Custom Instructions / Personalization của tài khoản ChatGPT đang đăng
 * nhập (session dùng chung với bot, xem getChatAIBrowserContext) — dùng để
 * SO SÁNH cấu hình cá nhân hoá giữa 2 tài khoản (local vs VPS), nghi vấn là
 * nguyên nhân khiến 2 bên trả lời với độ chi tiết khác hẳn nhau dù cùng 1
 * prompt_master.txt (xem so sánh output_local.json/output_vps.json — VPS
 * luôn trả lời ngắn/súc tích hơn hẳn, dưới cả mốc từ tối thiểu mà prompt yêu
 * cầu).
 *
 * CHƯA có DOM thật xác nhận cấu trúc modal Settings/Personalization (khác
 * hẳn phần chat đã tự động hoá kỹ ở nơi khác) — script này thử vài cách mở
 * menu/tab phổ biến, và LUÔN in ra toàn bộ text thô của khu vực đang xem
 * (kèm chụp debug snapshot ở từng bước) dù có tách được đúng từng field cụ
 * thể hay không, để còn đối chiếu thủ công nếu selector sai/site đã đổi
 * giao diện — chạy trên CẢ 2 máy (local + VPS) rồi so sánh output.
 *
 * Cách dùng: npm run check-chatai-personalization
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "check-chatai-personalization";
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
      console.log(
        "❌ Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai",
      );
      process.exit(1);
    }

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    // Mở menu tài khoản — testid xác nhận qua DOM thật (before-click ask.html,
    // aria-label "Mr An Plus, open profile menu"). Xác nhận qua log lỗi thật:
    // testid này khớp 2 phần tử (1 bản sao ẩn/thu gọn của sidebar không có
    // tên tài khoản trong aria-label, và 1 bản hiện thật có tên tài khoản) —
    // lọc lấy đúng phần tử ĐANG HIỂN THỊ (":visible") để tránh strict mode
    // violation khi click.
    const profileButton = page
      .locator('[data-testid="accounts-profile-button"]:visible')
      .first();
    await profileButton.click({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await captureSnapshot(page, `${jobId}-profile-menu`, "profile-menu");

    // Chưa có DOM thật xác nhận nhãn menu item "Settings" — thử vài biến thể.
    const settingsItem = page
      .getByRole("menuitem", { name: /settings/i })
      .or(page.getByText(/^Settings$/i));
    await settingsItem.first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    await captureSnapshot(page, `${jobId}-settings-opened`, "settings-opened");

    // Tab/mục "Personalization" trong modal Settings — thử vài biến thể
    // tương tự (tab, button, hoặc link trong sidebar của modal).
    const personalizationTab = page
      .getByRole("tab", { name: /personalization/i })
      .or(page.getByRole("button", { name: /personalization/i }))
      .or(page.getByText(/^Personalization$/i));
    await personalizationTab.first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    await captureSnapshot(
      page,
      `${jobId}-personalization-tab`,
      "personalization-tab",
    );

    // Scope vào đúng modal (role="dialog") nếu tìm thấy — tránh lẫn text của
    // cả sidebar/lịch sử chat phía sau modal.
    const dialog = page.locator('[role="dialog"]').first();
    const scope = (await dialog.count()) > 0 ? dialog : page.locator("body");

    // In text thô của TỪNG ô nhập (textarea/contenteditable) trong panel —
    // không cần biết chính xác nhãn field, miễn đọc được nội dung thật để so
    // sánh giữa 2 tài khoản.
    const fields = scope.locator('textarea, [contenteditable="true"]');
    const count = await fields.count();
    console.log(`\nTìm thấy ${count} ô nhập trong panel Personalization:\n`);
    for (let i = 0; i < count; i++) {
      const el = fields.nth(i);
      const value =
        (await el.inputValue().catch(() => null)) ??
        (await el.innerText().catch(() => ""));
      const label =
        (await el.getAttribute("aria-label").catch(() => null)) ??
        (await el.getAttribute("placeholder").catch(() => null)) ??
        `field #${i + 1}`;
      console.log(`--- ${label} ---`);
      console.log(value || "(rỗng)");
      console.log();
    }

    // Fallback: in toàn bộ text hiển thị của modal/trang — phòng trường hợp
    // vòng lặp trên đọc thiếu (field không phải textarea/contenteditable, vd
    // toggle "Enable memory" render bằng div/span khác).
    console.log("\n=== (fallback) toàn bộ text hiển thị trong panel lúc này ===\n");
    console.log((await scope.innerText().catch(() => "")).slice(0, 4000));

    // Tab "General" — kiểm tra riêng setting "Language": Custom Instructions/
    // Personalization đã xác nhận GIỐNG HỆT NHAU giữa 2 tài khoản (rỗng cả
    // 2 bên), nhưng người dùng nghi vấn 2 tài khoản khác nhau ở NGÔN NGỮ
    // GIAO DIỆN (setting riêng, nằm ở tab General chứ không phải
    // Personalization) — kiểm tra luôn để đối chiếu.
    const generalTab = page
      .getByRole("tab", { name: /^general$/i })
      .or(page.getByRole("button", { name: /^general$/i }))
      .or(page.getByText(/^General$/i));
    await generalTab.first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    await captureSnapshot(page, `${jobId}-general-tab`, "general-tab");

    const generalDialog = page.locator('[role="dialog"]').first();
    const generalScope =
      (await generalDialog.count()) > 0 ? generalDialog : page.locator("body");
    console.log("\n=== Tab General — toàn bộ text hiển thị ===\n");
    console.log((await generalScope.innerText().catch(() => "")).slice(0, 4000));
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error(
      "Script thất bại (xem debug snapshot để biết đang kẹt ở đâu):",
      err instanceof Error ? err.message : err,
    );
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
