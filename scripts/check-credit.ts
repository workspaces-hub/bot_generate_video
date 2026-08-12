import { config } from "../src/config";
import { getBrowserContext } from "../src/automation/browser";
import { ensureLoggedIn } from "../src/automation/aiVideo";
import { creditBalanceLocator, firstVisible } from "../src/automation/selectors";

/**
 * Đọc số credit còn lại của tài khoản đang cấu hình (dùng chung session với
 * bot) — xem chú thích creditBalanceLocator trong selectors.ts để biết DOM
 * thật đã xác nhận.
 */
async function main(): Promise<void> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(config.aiVideoCreateVideoPath, config.aiVideoBaseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ensureLoggedIn(page);

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const creditEl = await firstVisible([() => creditBalanceLocator(page)], 15_000);
    const text = (await creditEl.textContent())?.trim() ?? "";

    console.log(`Credit còn lại: ${text}`);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Không đọc được số credit:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
