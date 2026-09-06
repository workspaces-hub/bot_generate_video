import { chromium, type Browser } from "playwright";
import { config } from "../config";

/**
 * Google OAuth ("Đăng nhập bằng Google") chặn với lỗi "This browser or app
 * may not be secure" khi phát hiện trình duyệt đang bị điều khiển tự động
 * (CDP automation indicator, navigator.webdriver=true, cờ --enable-automation).
 * Dùng Chrome thật (channel: "chrome") thay vì Chromium bundled, đồng thời
 * gỡ các cờ/flag tố cáo automation để đăng nhập Google hoạt động bình thường.
 *
 * useProxy=false: dành cho các trường hợp xác nhận KHÔNG cần proxy. Mặc định
 * true để không đổi hành vi các nơi gọi cũ (login.ts, check-proxy.ts). LƯU Ý:
 * ChatAI THỰC RA vẫn cần proxy (xem chatAIBrowser.ts — đã thử tắt, bị
 * Cloudflare chặn ngay bằng IP thẳng của VPS), khác với nhận định ban đầu ghi
 * ở đây.
 *
 * proxyBypass: danh sách domain (phân tách bằng dấu phẩy) cho đi THẲNG,
 * KHÔNG qua proxy — xác nhận qua lỗi thật (ChatAI, banner "Failed upload to
 * files.oaiusercontent.com..."): domain CDN riêng để ChatGPT nhận file đính
 * kèm liên tục upload lỗi qua proxy hiện tại dù domain chính chatgpt.com vẫn
 * hoạt động bình thường. Log network thật (bắt trực tiếp request/response,
 * xem uploadAttachment trong chatAI.ts) mới lộ ra URL upload THẬT SỰ dùng 1
 * SUBDOMAIN KHÁC, đổi theo vùng Azure xử lý request (vd
 * "sdmntprwestus2.oaiusercontent.com" — Azure Blob Storage đứng sau,
 * "files.oaiusercontent.com" chỉ là 1 trong nhiều subdomain có thể gặp),
 * nhận đúng lỗi "net::ERR_TUNNEL_CONNECTION_FAILED" (proxy không dựng được
 * tunnel tới subdomain đó). PHẢI dùng dạng wildcard cả subdomain (dấu chấm
 * đứng đầu, vd ".oaiusercontent.com") thay vì liệt kê từng subdomain cụ thể —
 * không đoán trước được Azure sẽ dùng subdomain nào ở lần upload tiếp theo.
 * Domain CDN lưu file tĩnh này không có Cloudflare anti-bot như chatgpt.com
 * nên bypass thẳng IP VPS an toàn (khác domain chính chatgpt.com, bắt buộc
 * phải qua proxy để né Cloudflare).
 *
 * Xác nhận thật: ChatAI (Cloudflare Turnstile) challenge "Verify you are
 * human" liên tục xuất hiện khi bot chạy headless:true trên VPS, trong khi
 * chạy npm run login-chatai CÓ giao diện thật (headed) trên chính máy đó
 * KHÔNG hề bị challenge — Chrome headless bị Cloudflare nghi ngờ nhiều hơn
 * hẳn headed dù mọi cờ ẩn automation khác đều giống nhau. Vì vậy trên VPS,
 * NÊN chạy headed thật qua Xvfb (npm run start:xvfb + HEADLESS=false trong
 * .env) thay vì headless:true, dù không có màn hình vật lý.
 *
 * npm run start:xvfb đã cấu hình Xvfb giống màn hình thật hơn mặc định —
 * xvfb-run KHÔNG chỉnh gì thì Xvfb mặc định 1280x1024 ở độ sâu màu 8-bit
 * (screen.colorDepth = 8), gần như KHÔNG máy thật nào chạy 8-bit color
 * ngày nay — 1 tín hiệu giả mạo (fingerprint) rất dễ bị soi ra. Script
 * "start:xvfb" đặt lại độ phân giải/độ sâu màu qua --server-args: "-screen 0
 * 1920x1080x24" (độ phân giải desktop phổ biến nhất, 24-bit color giống máy
 * thật), "-dpi 96" (DPI chuẩn phổ biến), cùng "+extension RANDR +extension
 * GLX +render" (RANDR: hỗ trợ đổi độ phân giải runtime, browser thật hay
 * query; GLX/render: cần cho WebGL/canvas rendering không bị thiếu extension
 * bất thường so với X server thật).
 *
 * disableHttp2AndQuic (mặc định true, giữ hành vi cũ cho AIVideo/Pollo):
 * --disable-quic/--disable-http2 được thêm từ trước KHÔNG có bằng chứng/lý do
 * ghi lại cụ thể (nghi để tương thích proxy — nhiều proxy HTTP/SOCKS tunnel
 * HTTP/1.1 ổn định hơn hẳn HTTP/2 multiplexing/QUIC qua UDP). Đang thử TẮT
 * (đặt false) riêng cho ChatAI: banner lỗi thật "Failed upload to
 * files.oaiusercontent.com..." (xem proxyBypass ở trên) VẪN xảy ra y hệt kể
 * cả khi domain này đã bypass hẳn proxy (đi thẳng) — nghi ngờ chuyển hướng
 * sang chính 2 flag này, vì domain CDN lưu file (thường Azure Blob Storage)
 * thường đòi hỏi HTTP/2, bị ép xuống HTTP/1.1 cưỡng bức có thể gây đúng lỗi
 * upload kiểu này. CHƯA CÓ BẰNG CHỨNG XÁC NHẬN HẲN — đang trong giai đoạn thử
 * nghiệm, cần log thật từ lần chạy tiếp theo để biết có giải quyết được
 * không.
 */
export async function launchRealChrome(
  useProxy = true,
  proxyBypass?: string,
  disableHttp2AndQuic = true,
): Promise<Browser> {
  if (
    !config.headless &&
    process.platform === "linux" &&
    !process.env.DISPLAY
  ) {
    console.warn(
      "[launch] Đang chạy headless:false trên Linux nhưng không có $DISPLAY (không có X server) — " +
        "Chrome sẽ không khởi động được. Chạy qua Xvfb (npm run start:xvfb) để có headed thật trên VPS " +
        "không màn hình — khuyến nghị cho ChatAI vì Cloudflare Turnstile nghi ngờ headless nhiều hơn hẳn.",
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
  if (disableHttp2AndQuic) {
    args.push("--disable-quic", "--disable-http2");
  }
  if (config.chromeNoSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  return chromium.launch({
    // "chromium" = dùng bản Chromium bundled sẵn của Playwright thay vì đòi
    // hỏi Google Chrome đã cài trên máy (tiện cho VPS chỉ tái sử dụng session).
    channel:
      config.browserChannel === "chromium" ? undefined : config.browserChannel,
    headless: config.headless,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    proxy:
      useProxy && config.proxyServer
        ? {
            server: config.proxyServer,
            username: config.proxyUsername,
            password: config.proxyPassword,
            bypass: proxyBypass,
          }
        : undefined,
  });
}
