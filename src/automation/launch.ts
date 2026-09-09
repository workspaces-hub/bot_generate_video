import fs from "node:fs";
import { chromium, type Browser } from "playwright";
import { config } from "../config";

// Set TMPDIR TRƯỚC khi bất kỳ browser nào launch — Playwright tự tạo
// user-data-dir (profile Chrome) qua os.tmpdir() (đọc biến này) NGAY TRONG
// process Node của chính bot, không phải trong process Chrome con, nên phải
// set ở đây (module-level, chạy 1 lần lúc import) trước lần gọi
// chromium.launch() đầu tiên. Xem chú thích config.chromeTmpDir để biết lý
// do (tránh ghi profile/cache Chrome vào "/tmp" nếu đó là tmpfs — tốn RAM
// thay vì đĩa).
fs.mkdirSync(config.chromeTmpDir, { recursive: true });
process.env.TMPDIR = config.chromeTmpDir;

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
    // VPS chạy qua Xvfb (X server ẢO, không có GPU thật) — mặc định Chrome
    // vẫn tự bật 1 process "gpu-process" riêng dùng SwiftShader (giả lập
    // GPU BẰNG CHÍNH CPU, xem --enable-unsafe-swiftshader/--use-angle=
    // swiftshader-webgl trong command line thật) để render/composite, dù
    // không hề có tăng tốc phần cứng nào — chỉ tốn thêm CPU cho lớp giả lập
    // đó. Xác nhận qua htop THẬT (2026-09-09): riêng process này chiếm
    // 68.2% CPU một mình, đúng lúc CPU cả máy 100% (vấn đề gốc từ đầu phiên
    // làm việc). Tắt hẳn GPU — Chrome quay lại render bằng CPU trực tiếp
    // trong chính renderer process (không qua lớp gpu-process/SwiftShader
    // trung gian), tránh lãng phí thêm CPU cho giả lập vô ích trên máy vốn
    // không có GPU. Rủi ro: trang web dùng WebGL thật sẽ không chạy được
    // (hiện chưa có bằng chứng pollo.ai/ChatAI/AIVideo cần WebGL cho phần
    // composer/generate — cần theo dõi sau khi bật cờ này).
    "--disable-gpu",
    // Đi kèm "--disable-gpu" — chặn luôn đường lùi software-rasterizer
    // (Skia raster bằng CPU qua đường GPU-process) phòng khi "--disable-gpu"
    // một mình không chặn hết được mọi fallback.
    "--disable-software-rasterizer",
    // ĐÃ THỬ (theo yêu cầu người dùng lúc VPS 100% CPU khi gen ảnh+video
    // chạy song song) rồi REVERT: "--disable-features=IsolateOrigins,site-
    // per-process" + "--renderer-process-limit=1" từng được thêm để ép
    // dùng chung renderer process, giảm số process OS/CPU overhead. Xác
    // nhận qua bằng chứng thật trên VPS (2026-09-09, theo dõi `ps` liên tục
    // qua nhiều video job): renderer của page ĐÃ ĐÓNG không hề bị kill khi
    // ép dùng chung kiểu này — mỗi job mới CHỒNG THÊM renderer mới thay vì
    // thay thế renderer cũ (1 renderer "mồ côi" sống sót 25+ phút, không
    // được dọn), tích luỹ RAM dần tới khi crash ("Target crashed") sau vài
    // video liên tiếp — đúng mẫu hình "restart xong job đầu ổn, càng về sau
    // càng crash" người dùng báo cáo. Bỏ hẳn 2 cờ này để Chrome quay lại mô
    // hình mặc định (1 page = renderer riêng, đóng page = kill sạch process
    // đó, RAM được giải phóng ngay) — đổi CPU/số process cao hơn 1 chút để
    // lấy ổn định RAM, vì RAM mới là nút thắt thật (xem free -h/ps aux thu
    // thập lúc chẩn đoán: 1 browser đã dùng ~2GB RSS trên VPS chỉ có 3.8GB).
  ];
  if (disableHttp2AndQuic) {
    args.push("--disable-quic", "--disable-http2");
  }
  if (config.chromeNoSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  return chromium.launch({
    channel:
      config.browserChannel === "chromium" ? undefined : config.browserChannel,
    headless: config.headless,
    args,

    ignoreDefaultArgs: [
      "--enable-automation",
      "--enable-unsafe-swiftshader",
      "--enable-features=CDPScreenshotNewSurface",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",

      // Playwright mặc định thêm flag này.
      // VPS hiện có /dev/shm = 2GB, trong khi /tmp là tmpfs cũng dùng RAM.
      // Bỏ flag để Chrome quay lại sử dụng /dev/shm đúng mục đích.
      "--disable-dev-shm-usage",
    ],

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
