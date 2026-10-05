import fs from "node:fs";
import type { BrowserContext } from "playwright";
import { config } from "../config";
import { launchRealChrome } from "./launch";

/**
 * Tạo 1 "trình quản lý context" độc lập — mỗi lần gọi trả về hàm getContext()
 * riêng, cache 1 BrowserContext dùng chung cho mọi job của CÙNG site (tránh
 * đăng nhập lại liên tục, giảm tải khởi động Chrome), tự phục hồi khi Chrome
 * crash. Dùng để tạo NHIỀU trình quản lý độc lập cho các site khác nhau (vd
 * AIVideo và ChatAI) — mỗi site 1 session/storageState riêng,
 * không lẫn cookie vào nhau. Mỗi job tự mở/đóng page riêng trên context này.
 */
export interface BrowserContextGetter {
  (): Promise<BrowserContext>;
  /**
   * Đóng hẳn browser hiện tại (nếu có) và xoá cache — lần gọi getContext()
   * tiếp theo sẽ tự khởi động lại Chrome mới. Dùng khi 1 hàng đợi đã hết
   * job (queue rỗng) để giải phóng RAM ngay thay vì giữ Chrome sống chờ job
   * kế tiếp không biết bao giờ mới tới — xác nhận qua đo đạc thật (2026-09-09):
   * mỗi browser instance tốn đáng kể RAM (VPS 3.8GB, nhiều queue cùng lúc
   * dễ chạm ngưỡng crash "Target crashed"/OOM, xem launch.ts). Best-effort —
   * lỗi khi đóng (nếu có) chỉ log, không throw.
   */
  close: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Ghi session (cookies/localStorage) của context hiện tại ngược lại vào
   * storageStatePath — chỉ có tác dụng khi bật persistSession (xem
   * createBrowserContextManager). No-op nếu chưa có context/Chrome đã chết.
   */
  saveSession: () => Promise<void>;
}

export interface PersistSessionOptions {
  /** Chu kỳ tự lưu session trong lúc Chrome còn sống (ms). */
  intervalMs: number;
  /**
   * Session có còn đăng nhập không — false thì KHÔNG ghi đè file (tránh lưu
   * trạng thái đã bị đăng xuất lên trên session tốt).
   */
  isValid: (cookieNames: Set<string>) => boolean;
}

export function createBrowserContextManager(
  storageStatePath: string,
  logLabel: string,
  loginHint: string,
  useProxy = true,
  proxyBypass?: string,
  disableHttp2AndQuic = true,
  /**
   * Theo yêu cầu người dùng: cho phép TẮT "--disable-gpu"/"--disable-software-
   * rasterizer" riêng cho 1 site cụ thể — mặc định true (giữ nguyên hành vi
   * cũ, tiết kiệm CPU, xem docstring disableGpu trong launch.ts). Đặt false
   * cho ChatAI (chatAIBrowser.ts): nghi vấn (tương quan thời điểm, CHƯA xác
   * nhận hẳn) việc tắt GPU trên toàn bộ browser từ 2026-09-10 làm hỏng
   * fingerprint WebGL/canvas, khiến Cloudflare Turnstile (chỉ ChatAI mới có,
   * AIVideo/Pollo không dùng Turnstile) chuyển sang chế độ non-interactive
   * không hiện checkbox nào để bấm và không bao giờ tự pass — xác nhận qua
   * log thật: cơ chế bấm checkbox (dò qua page.frames(), xem
   * dismissCloudflareChallengeIfPresent) từng hoạt động đúng từ đầu tháng 8
   * (job afd3c6d8/30520119), giờ báo "KHÔNG tìm/bấm được checkbox nào trong
   * bất kỳ frame nào" dù đã dò đúng frame Turnstile.
   */
  disableGpu = true,
  /**
   * Theo phản ánh người dùng (Gemini: Ctrl+C rồi chạy lại bot thì mất đăng
   * nhập): Google XOAY VÒNG cookie phiên (__Secure-1PSIDTS...) ngay trong
   * Chrome của bot và vô hiệu hoá bản cũ, trong khi file session chỉ được ghi
   * 1 lần lúc login → lần chạy sau nạp lại cookie cũ = bị đăng xuất. Bật để
   * định kỳ + lúc đóng Chrome ghi session MỚI NHẤT ngược lại vào file.
   */
  persistSession?: PersistSessionOptions,
): BrowserContextGetter {
  let contextPromise: Promise<BrowserContext> | null = null;
  let persistTimer: ReturnType<typeof setInterval> | null = null;

  async function saveSession(): Promise<void> {
    if (!persistSession || !contextPromise) return;
    const context = await contextPromise.catch(() => null);
    if (!context || !context.browser()?.isConnected()) return;
    try {
      const state = await context.storageState();
      const cookieNames = new Set(state.cookies.map((c) => c.name));
      if (!persistSession.isValid(cookieNames)) {
        console.warn(
          `[${logLabel}] Session hiện tại có vẻ đã bị đăng xuất — KHÔNG ghi đè ${storageStatePath}.`,
        );
        return;
      }
      // Ghi file tạm rồi rename — bị kill giữa chừng không làm hỏng file cũ.
      const tmpPath = `${storageStatePath}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      await fs.promises.rename(tmpPath, storageStatePath);
    } catch (err) {
      console.warn(
        `[${logLabel}] Không lưu được session (bỏ qua):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Mốc lần gần nhất có nơi lấy context — xem close(): khoảng giữa lúc 1 nơi
  // gọi getContext() và lúc nó kịp newPage() thì context.pages() vẫn = 0.
  let lastAcquiredAt = 0;
  const RECENT_ACQUIRE_GRACE_MS = 60_000;

  async function launchNewContext(): Promise<BrowserContext> {
    const browser = await launchRealChrome(
      useProxy,
      proxyBypass,
      disableHttp2AndQuic,
      disableGpu,
    );
    const hasSession = fs.existsSync(storageStatePath);
    if (!hasSession) {
      console.warn(
        `[${logLabel}] Không tìm thấy session tại ${storageStatePath}. ${loginHint}`,
      );
    }
    const context = await browser.newContext({
      storageState: hasSession ? storageStatePath : undefined,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });

    // Nếu Chrome crash ("Target crashed") hoặc bị đóng vì bất kỳ lý do
    // gì, contextPromise đã cache PHẢI được xoá — nếu không, mọi job sau
    // đó sẽ luôn tái sử dụng browser đã chết và fail mãi mãi, cho tới khi
    // restart bot thủ công. Xoá cache để lần gọi tiếp theo tự khởi động
    // lại Chrome mới (tự phục hồi).
    browser.on("disconnected", () => {
      console.warn(`[${logLabel}] Chrome đã ngắt kết nối/crash — sẽ khởi động lại ở job tiếp theo.`);
      contextPromise = null;
      if (persistTimer) {
        clearInterval(persistTimer);
        persistTimer = null;
      }
    });

    if (persistSession) {
      if (persistTimer) clearInterval(persistTimer);
      persistTimer = setInterval(() => void saveSession(), persistSession.intervalMs);
    }

    return context;
  }

  async function getContext(): Promise<BrowserContext> {
    if (contextPromise) {
      // Xác nhận qua log thật (nhiều job liên tiếp cùng lỗi "Target page,
      // context or browser has been closed" NGAY SAU 1 lần crash, kể cả lần
      // retry trong generateVideo/generateImage — xem isPageCrashError):
      // event "disconnected" ở trên đôi khi CHƯA kịp bắn ra (race điều kiện
      // với chính promise reject của thao tác đang chạy dở lúc crash) nên
      // contextPromise cache lúc đó vẫn còn trỏ tới context ĐÃ CHẾT. Chủ
      // động kiểm tra isConnected() TRƯỚC khi tái sử dụng, không chỉ trông
      // chờ vào sự kiện "disconnected" — nếu context cache đã chết, xoá
      // ngay để launch lại Chrome MỚI thay vì trả về context chết khiến lần
      // retry (dù đã được viết đúng) vẫn fail lại ngay lập tức.
      const existing = await contextPromise.catch(() => null);
      if (!existing || !existing.browser()?.isConnected()) {
        contextPromise = null;
      }
    }
    if (!contextPromise) {
      contextPromise = launchNewContext();
    }
    lastAcquiredAt = Date.now();
    return contextPromise;
  }

  async function close(options?: { force?: boolean }): Promise<void> {
    if (!contextPromise) return;
    const current = contextPromise;
    const context = await current.catch(() => null);
    // Xác nhận qua log thật ("browserContext.newPage: Target page, context or
    // browser has been closed" ở compareOriginalWithFinalVideo ngay lúc bot
    // khởi động): nơi A vừa getContext() (Chrome đang launch/vừa xong) nhưng
    // CHƯA kịp newPage() → pages().length = 0 → hàng đợi B gọi close() lúc
    // đó qua được check bên dưới và đóng mất Chrome của A. Bỏ qua đóng nếu
    // vừa có nơi lấy context gần đây — lần close() sau sẽ đóng.
    // force: nơi gọi CHẮC CHẮN vừa dùng xong (vd tạo ảnh Gemini — đóng ngay
    // sau mỗi ảnh) — bỏ qua khoảng chờ này, vẫn giữ kiểm tra page đang mở.
    if (!options?.force && Date.now() - lastAcquiredAt < RECENT_ACQUIRE_GRACE_MS) {
      console.warn(
        `[${logLabel}] Bỏ qua đóng Chrome — vừa có nơi lấy context trong ${RECENT_ACQUIRE_GRACE_MS / 1000}s gần đây (có thể sắp mở page).`,
      );
      return;
    }
    // SỬA (xác nhận qua debug thật, bật DEBUG=pw:browser,pw:channel — xem
    // lịch sử xoá close() ở processChatAIQueue): context này có thể ĐANG
    // ĐƯỢC DÙNG bởi 1 hàng đợi KHÁC tại đúng lúc hàng đợi gọi close() vừa
    // rỗng (vd getChatAIBrowserContext dùng chung giữa processChatAIQueue
    // VÀ verifyVideo/processVideoQueue — 2 hàng đợi ĐỘC LẬP, chạy đồng
    // thời). Đóng mù browser lúc đó sẽ làm gãy NGAY job đang chạy dở ở hàng
    // đợi kia ("Target page, context or browser has been closed"). Kiểm tra
    // context.pages().length TRƯỚC khi đóng — còn page nào đang mở nghĩa là
    // có nơi khác đang dùng, bỏ qua lần đóng này (giữ nguyên cache cho tới
    // lần gọi close() sau, khi mọi page đã đóng hết).
    if (context && context.pages().length > 0) {
      console.warn(
        `[${logLabel}] Bỏ qua đóng Chrome — vẫn còn ${context.pages().length} page đang mở (nơi khác đang dùng chung context này).`,
      );
      return;
    }
    await saveSession();
    contextPromise = null;
    const browser = context?.browser();
    if (browser?.isConnected()) {
      await browser.close().catch((err) => {
        console.warn(`[${logLabel}] Lỗi khi đóng Chrome (bỏ qua):`, err instanceof Error ? err.message : err);
      });
    }
  }

  const getter = getContext as BrowserContextGetter;
  getter.close = close;
  getter.saveSession = saveSession;
  return getter;
}

/**
 * Một BrowserContext dùng chung cho mọi job video/ảnh (AIVideo), được
 * tái sử dụng để tránh đăng nhập lại liên tục và giảm tải khi khởi động
 * Chrome. Mỗi job tự mở/đóng page riêng (xem aiVideo.ts). Dùng cho các
 * script CLI một lần (check-credit, download-video-by-feed-id, ...) — KHÔNG
 * dùng cho bot lúc chạy thật, xem getImageBrowserContext/getVideoBrowserContext.
 */
export const getBrowserContext = createBrowserContextManager(
  config.storageStatePath,
  "browser",
  'Chạy "npm run login" trước khi tạo video.',
);

/**
 * 2 BrowserContext RIÊNG BIỆT cho hàng đợi ẢNH và hàng đợi VIDEO (xem
 * imageJobs/videoJobs trong queue.ts) — mỗi hàng đợi giờ chạy độc lập, có
 * thể xử lý CÙNG LÚC (không còn xếp chung 1 hàng đợi như trước). Theo yêu
 * cầu người dùng, dùng LUÔN 2 TÀI KHOẢN AIVideo KHÁC NHAU (2 session file
 * khác nhau — aiVideoImageStorageStatePath riêng cho ảnh, storageStatePath
 * như cũ cho video), KHÔNG chỉ 2 browser context của CÙNG 1 tài khoản — vừa
 * tránh 2 tab thao tác đồng thời trên CÙNG tài khoản dễ xung đột, vừa tránh
 * tranh credit/rate-limit giữa ảnh và video. Đăng nhập tài khoản ảnh bằng
 * `npm run login -- image` (xem scripts/login.ts).
 */
export const getImageBrowserContext = createBrowserContextManager(
  config.aiVideoImageStorageStatePath,
  "browser-image",
  'Chạy "npm run login -- image" trước khi tạo ảnh.',
);
export const getVideoBrowserContext = createBrowserContextManager(
  config.storageStatePath,
  "browser-video",
  'Chạy "npm run login" trước khi tạo video.',
);
