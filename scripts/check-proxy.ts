import { config } from "../src/config";
import { launchRealChrome } from "../src/automation/launch";

/**
 * Mở browser với đúng cấu hình proxy đang dùng (PROXY_SERVER trong .env,
 * cùng helper launchRealChrome() mà login.ts và bot dùng), truy cập trang
 * trả IP công cộng để xác nhận traffic có thực sự đi qua proxy hay không.
 */
async function main(): Promise<void> {
  console.log("PROXY_SERVER:", config.proxyServer ?? "(không cấu hình — đang chạy IP thật, không qua proxy)");

  const browser = await launchRealChrome();
  const page = await browser.newPage();

  await page.goto("https://api.ipify.org?format=json");
  const body = await page.textContent("body");
  console.log("IP nhìn thấy từ bên ngoài:", body);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
