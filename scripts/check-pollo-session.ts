import fs from "node:fs";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { gotoPolloWithRetry, dismissBlockingOverlays } from "../src/automation/pollo";
import { signInIndicatorCandidates } from "../src/automation/polloSelectors";
import { firstVisible } from "../src/automation/selectors";

interface StorageStateCookie {
  name: string;
  domain: string;
  expires: number; // unix seconds, -1 = session cookie (hết khi đóng trình duyệt)
}

/**
 * Đọc hạn cookie phiên đăng nhập chính của pollo.ai (NextAuth.js —
 * "__Secure-next-auth.session-token") trực tiếp từ file session, không cần
 * mở trình duyệt — cùng cơ chế/quy ước đã dùng cho AIVideo (xem
 * checkCookieExpiry trong check-session.ts). Chỉ là ước lượng: cookie còn
 * hạn không có nghĩa server chưa vô hiệu hoá phiên vì lý do khác (đổi mật
 * khẩu, đăng nhập máy khác...) — xem thêm checkLiveLogin().
 *
 * pollo.ai dùng CHUNG 1 session (config.polloStorageStatePath) cho cả hàng
 * đợi ảnh lẫn video (khác AIVideo, vốn dùng 2 tài khoản riêng) — xem
 * polloBrowser.ts.
 */
function checkCookieExpiry(): void {
  if (!fs.existsSync(config.polloStorageStatePath)) {
    console.log(
      `Không tìm thấy session tại ${config.polloStorageStatePath} — chưa từng chạy npm run login-pollo.`,
    );
    return;
  }

  const data = JSON.parse(fs.readFileSync(config.polloStorageStatePath, "utf-8"));
  const cookies: StorageStateCookie[] = data.cookies ?? [];
  const tokenCookie = cookies.find(
    (c) =>
      c.name === "__Secure-next-auth.session-token" && c.domain.includes("pollo.ai"),
  );

  if (!tokenCookie) {
    console.log(
      'Không tìm thấy cookie "__Secure-next-auth.session-token" trong session — có thể site đã đổi cơ chế xác thực, hoặc chưa đăng nhập.',
    );
    return;
  }

  if (tokenCookie.expires === -1) {
    console.log(
      'Cookie phiên là session cookie (hết hạn khi đóng trình duyệt) — không có ngày hết hạn cố định.',
    );
    return;
  }

  const now = Date.now() / 1000;
  const daysLeft = (tokenCookie.expires - now) / 86400;
  const expiryDate = new Date(tokenCookie.expires * 1000).toISOString();

  if (daysLeft <= 0) {
    console.log(
      `⚠️  Cookie phiên ĐÃ HẾT HẠN lúc ${expiryDate} (${Math.abs(daysLeft).toFixed(1)} ngày trước).`,
    );
  } else {
    console.log(`Cookie phiên còn hạn tới ${expiryDate} (~${daysLeft.toFixed(1)} ngày nữa).`);
  }
}

/**
 * Kiểm tra thực tế: mở pollo.ai bằng đúng session đang cấu hình, xem có bị
 * yêu cầu đăng nhập lại không (nút/link "Sign in", xem
 * signInIndicatorCandidates) — đáng tin cậy hơn chỉ đọc hạn cookie, vì
 * server có thể vô hiệu hoá phiên trước khi cookie hết hạn.
 */
async function checkLiveLogin(): Promise<void> {
  console.log("\nĐang kiểm tra thực tế bằng cách mở pollo.ai...");
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  try {
    await gotoPolloWithRetry(page, config.polloBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await dismissBlockingOverlays(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 5000)
      .then(() => true)
      .catch(() => false);

    if (signedOut) {
      console.log("❌ Session đã hết hạn hoặc không hợp lệ — trang yêu cầu đăng nhập lại.");
      console.log("Chạy lại: npm run login-pollo");
    } else {
      console.log("✅ Session còn hợp lệ — vẫn đăng nhập được vào pollo.ai.");
    }
  } catch (err) {
    console.log("❌ Không kiểm tra được (lỗi khi mở trang):", err instanceof Error ? err.message : err);
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
