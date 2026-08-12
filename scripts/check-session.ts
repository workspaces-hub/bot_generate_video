import fs from "node:fs";
import { config } from "../src/config";
import { getBrowserContext } from "../src/automation/browser";
import { ensureLoggedIn } from "../src/automation/aiVideo";

interface StorageStateCookie {
  name: string;
  domain: string;
  expires: number; // unix seconds, -1 = session cookie (hết khi đóng trình duyệt)
}

/**
 * Đọc hạn cookie "_token" (cookie phiên đăng nhập chính của AIVideo)
 * trực tiếp từ file session — nhanh, không cần mở trình duyệt. Chỉ là ước
 * lượng: cookie còn hạn không có nghĩa server chưa vô hiệu hoá phiên vì lý
 * do khác (đổi mật khẩu, đăng nhập máy khác...) — xem thêm checkLiveLogin().
 */
function checkCookieExpiry(): void {
  if (!fs.existsSync(config.storageStatePath)) {
    console.log(`Không tìm thấy session tại ${config.storageStatePath} — chưa từng chạy npm run login.`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(config.storageStatePath, "utf-8"));
  const cookies: StorageStateCookie[] = data.cookies ?? [];
  const tokenCookie = cookies.find((c) => c.name === "_token" && c.domain.includes("hailuoai.video"));

  if (!tokenCookie) {
    console.log('Không tìm thấy cookie "_token" trong session — có thể site đã đổi cơ chế xác thực.');
    return;
  }

  if (tokenCookie.expires === -1) {
    console.log('Cookie "_token" là session cookie (hết hạn khi đóng trình duyệt) — không có ngày hết hạn cố định.');
    return;
  }

  const now = Date.now() / 1000;
  const daysLeft = (tokenCookie.expires - now) / 86400;
  const expiryDate = new Date(tokenCookie.expires * 1000).toISOString();

  if (daysLeft <= 0) {
    console.log(`⚠️  Cookie "_token" ĐÃ HẾT HẠN lúc ${expiryDate} (${Math.abs(daysLeft).toFixed(1)} ngày trước).`);
  } else {
    console.log(`Cookie "_token" còn hạn tới ${expiryDate} (~${daysLeft.toFixed(1)} ngày nữa).`);
  }
}

/**
 * Kiểm tra thực tế: mở trang tạo video bằng đúng session đang cấu hình, xem
 * AIVideo có yêu cầu đăng nhập lại không — đáng tin cậy hơn chỉ đọc
 * hạn cookie, vì server có thể vô hiệu hoá phiên trước khi cookie hết hạn.
 */
async function checkLiveLogin(): Promise<void> {
  console.log("\nĐang kiểm tra thực tế bằng cách mở AIVideo...");
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(config.aiVideoCreateVideoPath, config.aiVideoBaseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ensureLoggedIn(page);
    console.log("✅ Session còn hợp lệ — vẫn đăng nhập được vào AIVideo.");
  } catch (err) {
    console.log("❌ Session đã hết hạn hoặc không hợp lệ:", err instanceof Error ? err.message : err);
    console.log("Chạy lại: npm run login (hoặc npm run login -- --no-proxy nếu proxy chặn Google)");
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  checkCookieExpiry();
  await checkLiveLogin();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
