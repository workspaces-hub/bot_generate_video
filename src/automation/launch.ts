import { chromium, type Browser } from "playwright";
import { config } from "../config";

/**
 * Google OAuth ("Đăng nhập bằng Google") chặn với lỗi "This browser or app
 * may not be secure" khi phát hiện trình duyệt đang bị điều khiển tự động
 * (CDP automation indicator, navigator.webdriver=true, cờ --enable-automation).
 * Dùng Chrome thật (channel: "chrome") thay vì Chromium bundled, đồng thời
 * gỡ các cờ/flag tố cáo automation để đăng nhập Google hoạt động bình thường.
 */
export async function launchRealChrome(): Promise<Browser> {
  if (!config.headless && process.platform === "linux" && !process.env.DISPLAY) {
    console.warn(
      "[launch] Đang chạy headless:false trên Linux nhưng không có $DISPLAY (không có X server) — " +
        "Chrome sẽ không khởi động được. Đặt HEADLESS=true trong .env (VPS thường không có màn hình), " +
        "hoặc chạy qua xvfb-run nếu cần headed thật sự.",
    );
  }

  const args = [
    "--disable-blink-features=AutomationControlled",
    // /dev/shm mặc định rất nhỏ trên nhiều VPS/container (thường 64MB) —
    // Chrome dùng /dev/shm cho shared memory khi decode/render video, dễ
    // gây "Target crashed" (crash cả tiến trình renderer) khi xử lý file
    // video nặng (tính năng Omni Reference). Chuyển sang dùng /tmp thay vì
    // /dev/shm để tránh giới hạn này.
    "--disable-dev-shm-usage",
  ];
  if (config.chromeNoSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  return chromium.launch({
    // "chromium" = dùng bản Chromium bundled sẵn của Playwright thay vì đòi
    // hỏi Google Chrome đã cài trên máy (tiện cho VPS chỉ tái sử dụng session).
    channel: config.browserChannel === "chromium" ? undefined : config.browserChannel,
    headless: config.headless,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    proxy: config.proxyServer
      ? {
          server: config.proxyServer,
          username: config.proxyUsername,
          password: config.proxyPassword,
        }
      : undefined,
  });
}
