import fs from "node:fs";
import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatGptBrowserContext,
} from "../src/automation/chatgptBrowser";
import { signInIndicatorCandidates } from "../src/automation/chatgptSelectors";
import { firstVisible } from "../src/automation/selectors";

interface StorageStateCookie {
  name: string;
  domain: string;
  expires: number; // unix seconds, -1 = session cookie (hết khi đóng trình duyệt)
}

/**
 * Đọc hạn cookie "__Secure-next-auth.session-token" (cookie phiên đăng nhập
 * chính của chatgpt.com) trực tiếp từ file session — nhanh, không cần mở
 * trình duyệt. Chỉ là ước lượng: cookie còn hạn không có nghĩa server chưa vô
 * hiệu hoá phiên vì lý do khác (đổi mật khẩu, đăng nhập máy khác...) — xem
 * thêm checkLiveLogin().
 */
function checkCookieExpiry(): void {
  if (!fs.existsSync(config.chatGptStorageStatePath)) {
    console.log(
      `Không tìm thấy session tại ${config.chatGptStorageStatePath} — chưa từng chạy npm run login-chatgpt.`,
    );
    return;
  }

  const data = JSON.parse(fs.readFileSync(config.chatGptStorageStatePath, "utf-8"));
  const cookies: StorageStateCookie[] = data.cookies ?? [];
  const tokenCookie = cookies.find(
    (c) =>
      c.name === "__Secure-next-auth.session-token" &&
      c.domain.includes("chatgpt.com"),
  );

  if (!tokenCookie) {
    console.log(
      'Không tìm thấy cookie "__Secure-next-auth.session-token" trong session — có thể site đã đổi cơ chế xác thực.',
    );
    return;
  }

  if (tokenCookie.expires === -1) {
    console.log(
      'Cookie phiên đăng nhập là session cookie (hết hạn khi đóng trình duyệt) — không có ngày hết hạn cố định.',
    );
    return;
  }

  const now = Date.now() / 1000;
  const daysLeft = (tokenCookie.expires - now) / 86400;
  const expiryDate = new Date(tokenCookie.expires * 1000).toISOString();

  if (daysLeft <= 0) {
    console.log(
      `⚠️  Cookie phiên đăng nhập ĐÃ HẾT HẠN lúc ${expiryDate} (${Math.abs(daysLeft).toFixed(1)} ngày trước).`,
    );
  } else {
    console.log(
      `Cookie phiên đăng nhập còn hạn tới ${expiryDate} (~${daysLeft.toFixed(1)} ngày nữa).`,
    );
  }
}

/**
 * Kiểm tra thực tế: mở chatgpt.com bằng đúng session đang cấu hình, xem có bị
 * yêu cầu đăng nhập lại không — đáng tin cậy hơn chỉ đọc hạn cookie, vì server
 * có thể vô hiệu hoá phiên trước khi cookie hết hạn. Dùng cùng logic phát
 * hiện "chưa đăng nhập" (signInIndicatorCandidates) như askChatGpt thật, kèm
 * xử lý Cloudflare challenge (xem chatgptBrowser.ts) để không báo nhầm lỗi
 * đăng nhập khi thực ra đang bị chặn ở challenge.
 */
async function checkLiveLogin(): Promise<void> {
  console.log("\nĐang kiểm tra thực tế bằng cách mở chatgpt.com...");
  const context = await getChatGptBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(config.chatGptBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 5000)
      .then(() => true)
      .catch(() => false);

    if (signedOut) {
      console.log("❌ Session đã hết hạn hoặc không hợp lệ — trang yêu cầu đăng nhập lại.");
      console.log("Chạy lại: npm run login-chatgpt");
    } else {
      console.log("✅ Session còn hợp lệ — vẫn đăng nhập được vào chatgpt.com.");
    }
  } catch (err) {
    console.log("❌ Không kiểm tra được:", err instanceof Error ? err.message : err);
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
