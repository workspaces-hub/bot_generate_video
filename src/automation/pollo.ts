import fs from "node:fs";
import path from "node:path";
import type { APIResponse, Locator, Page } from "playwright";
import { config } from "../config";
import { getPolloBrowserContext } from "./polloBrowser";
import {
  GenerationError,
  captureErrorSnapshot,
  captureSnapshot,
  fetchWithRetry,
} from "./aiVideo";
import { firstVisible } from "./selectors";
import {
  assetPickerCardByUrlLocator,
  assetPickerCardLocator,
  creditPaywallLocator,
  generateButtonLocator,
  mentionPickerItemByUrlLocator,
  modeChipLocator,
  modeMenuOptionLocator,
  modelChipLocator,
  modelDialogOptionLocator,
  paramsChipLocator,
  promptEditorLocator,
  resultCardLocator,
  resultItemLocator,
  resultVideoLocator,
  signInIndicatorCandidates,
  uploadCardButtonByLabel,
  uploadCardButtonForImage,
  uploadDialogFileInputLocator,
  uploadDialogSelectButtonLocator,
  uploadingSpinnerLocator,
  videoLengthOptionLocator,
  videoLengthSliderInputLocator,
} from "./polloSelectors";

/**
 * Map Content-Type → đuôi file — dùng cho resolveDownloadExtension bên dưới,
 * chỉ cần khớp các định dạng ảnh mà uploadDialogFileInputLocator chấp nhận
 * (accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,.tiff,.tif", xem polloSelectors.ts)
 * cộng video/mp4.
 */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
};

/**
 * Xác định đuôi file khi tải kết quả (ảnh/video) từ pollo.ai — xác nhận qua
 * lỗi thật (job microdrama_co_dau_phan_boi_twist_prompt, TẤT CẢ 8 entry VIDEO
 * đầu tiên đều treo ở bước upload ảnh tham chiếu): file LOC_LUXURY_HOTEL_
 * HALLWAY.png tải về trước đó THỰC RA là JPEG (xác nhận qua magic bytes
 * FF D8 FF, không phải PNG 89 50 4E 47) nhưng bị đặt tên ".png" — do URL ảnh
 * kết quả lúc đó KHÔNG có đuôi rõ trong path, code cũ (path.extname(...) ||
 * ".png") mặc định nhầm sang ".png". Ảnh sai đuôi này lại là 1 location xuất
 * hiện lặp lại ở MỌI shot của storyboard, nên upload nó lên lại pollo.ai
 * (MIME khai báo "image/png" nhưng bytes thật là JPEG) khiến site xử lý
 * không ra, treo mãi ở "Uploading" — pollo.ai không báo lỗi rõ ràng.
 *
 * SỬA: ưu tiên đọc Content-Type THẬT từ response (phản ánh đúng định dạng
 * server trả về, không phụ thuộc URL có đuôi hay không) — chỉ dùng lại cách
 * đoán qua URL khi header thiếu/không nhận diện được.
 */
export function resolveDownloadExtension(
  response: APIResponse,
  src: string,
  fallbackExt = ".png",
): string {
  const contentType = response.headers()["content-type"]
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType && CONTENT_TYPE_EXTENSIONS[contentType]) {
    return CONTENT_TYPE_EXTENSIONS[contentType];
  }
  return path.extname(new URL(src).pathname) || fallbackExt;
}

/**
 * Đóng popup che composer (chặn click, vd "... subtree intercepts pointer
 * events") — best-effort, không throw nếu không có gì để đóng.
 *
 * Xác nhận qua DOM thật từ 2 loại popup KHÁC HẲN NHAU về khung: popup promo
 * "Unlock Unlimited MiniMax H3" (bọc trong .coco-modal-wrap, hệ thống modal
 * riêng của pollo.ai) và popup xin đánh giá Trustpilot "Enjoying Pollo.ai?"
 * (bọc trong div.portal-wrapper, hệ thống popup khác hẳn — không phải
 * coco-modal, .coco-modal-close cũ không khớp được) — dù khung khác nhau,
 * CẢ HAI đều render nút đóng theo ĐÚNG 1 mẫu chung của design system:
 * <button aria-label="Close"><span class="i-cus--pol-close">...</span></button>.
 * Dùng thẳng button[aria-label="Close"] để tự đóng được MỌI popup theo mẫu
 * này — kể cả các popup MỚI phát sinh sau này chưa từng gặp — thay vì phải
 * vá thêm 1 selector riêng mỗi lần pollo.ai thêm popup mới.
 *
 * Giữ thêm nút "Maybe later" (button[data-button-name="next_time"]) làm dự
 * phòng riêng cho popup Trustpilot, phòng khi nút X đổi/không hiện.
 */
export async function dismissBlockingOverlays(page: Page): Promise<void> {
  // Banner xin cookie (thư viện vanilla-cookieconsent — nhận diện qua
  // #cc-main/.cm-wrapper/.cm__desc) — xác nhận qua lỗi thật (job
  // test_normal_2_CHAR_EMILY, user báo trực tiếp lúc đang xem live: "đang
  // hiển thị popup accept cookie. click accept all rồi tiếp tục"): banner
  // này che TOÀN BỘ khu vực composer, khiến cả click bật switch Unlimited
  // lẫn click nút generate đều báo "<div id=\"cc-main\">…</div> subtree
  // intercepts pointer events" và timeout dù element "visible, enabled and
  // stable" — không phải popup coco-modal/Trustpilot nên button[aria-
  // label="Close"] không khớp được. Bấm nút "Accept all" (data-cc="accept-
  // all" theo đúng thư viện, kèm fallback theo text phòng khi site tùy biến
  // lại attribute) TRƯỚC các bước dismiss khác.
  const cookieAcceptButton = page
    .locator('#cc-main button[data-cc="accept-all"], #cc-main button:has-text("Accept all")')
    .first();
  if (await cookieAcceptButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await cookieAcceptButton.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // .first() KHÔNG đủ — xác nhận qua lỗi thật (job microdrama_co_dau_phan_
  // boi_twist_prompt_SHOT_01_CLIP_01_VIDEO): trang thật có TỚI 3 nút khớp
  // button[aria-label="Close"] cùng lúc (drawer mobile ẩn/pointer-events-none
  // đứng TRƯỚC trong DOM, popup Trustpilot, popup "announcement_popup" mới —
  // xem docstring hàm này). .first() luôn trỏ đúng 1 phần tử cố định theo
  // thứ tự DOM; nếu ĐÚNG phần tử đó lại không visible (vd drawer ẩn), code cũ
  // dừng luôn, KHÔNG thử các nút Close khác — nên popup thật đang chặn click
  // (đứng sau trong DOM) không bao giờ được bấm. Duyệt HẾT các nút khớp, bấm
  // MỌI nút đang visible thay vì chỉ nút đầu tiên.
  const closeButtons = await page.locator('button[aria-label="Close"]').all();
  for (const closeButton of closeButtons) {
    if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeButton.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const maybeLaterButtons = await page.locator('button[data-button-name="next_time"]').all();
  for (const maybeLaterButton of maybeLaterButtons) {
    if (await maybeLaterButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await maybeLaterButton.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
}

/**
 * page.goto có retry — xác nhận qua lỗi thật (script test-pollo-live-network,
 * chạy thật qua đúng proxy trong .env): net::ERR_TUNNEL_CONNECTION_FAILED
 * xảy ra HÀNG LOẠT trên rất nhiều domain khác nhau CÙNG LÚC (Google
 * Analytics, API riêng của pollo.ai như banner.visibleList, CDN ảnh/video)
 * — sự cố TẠM THỜI của chính PROXY, không phải site/CDN pollo.ai cụ thể nào.
 * Trước đây page.goto() KHÔNG có retry gì cả — gặp đúng lỗi này giữa lúc mở
 * trang là throw ngay, y hệt kiểu lỗi ERR_TUNNEL_CONNECTION_FAILED đã từng
 * gặp và sửa cho ChatGPT (xem gotoChatAIWithRetry trong chatAI.ts) — áp dụng
 * cùng cơ chế cho pollo.ai.
 */
export async function gotoPolloWithRetry(
  page: Page,
  url: string,
  options: Parameters<Page["goto"]>[1],
  attempts = 3,
  delayMs = 5000,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, options);
      return;
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      console.warn(
        `[pollo] page.goto lỗi lần ${attempt}/${attempts}${isLastAttempt ? "" : ", thử lại"}:`,
        err instanceof Error ? err.message : err,
      );
      if (isLastAttempt) throw err;
      await page.waitForTimeout(delayMs);
    }
  }
}

/**
 * Bấm 1 locator, nếu bị popup che chặn (Playwright báo "... subtree
 * intercepts pointer events") thì gọi dismissBlockingOverlays rồi thử lại —
 * xác nhận qua lỗi thật LẶP LẠI NHIỀU LẦN (nhiều job
 * microdrama_co_dau_phan_boi_twist_prompt, cùng nút "Upload Media"): gọi
 * dismissBlockingOverlays 1 LẦN duy nhất TRƯỚC KHI bắt đầu click là KHÔNG
 * đủ, vì popup coco-modal-wrap có thể bật lên NGAY GIỮA LÚC Playwright đang
 * tự retry click (Playwright chỉ tự retry đúng thao tác click trong lúc
 * chờ actionability, KHÔNG tự chạy lại dismissBlockingOverlays của mình) —
 * nếu popup xuất hiện SAU thời điểm dismiss ban đầu, click cứ treo tới hết
 * timeout dù đã gọi dismiss trước đó. Chủ động lặp: thử click (timeout
 * ngắn) → lỗi thì dismissBlockingOverlays → thử lại, tối đa vài lần.
 */
export async function clickWithOverlayDismiss(
  page: Page,
  locator: Locator,
  timeoutPerAttemptMs = 4000,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await locator.click({ timeout: timeoutPerAttemptMs });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await dismissBlockingOverlays(page);
    }
  }
}

/**
 * Bấm nút Generate — xác nhận qua lỗi thật (3 job liền (CHAR_NATE_RYDER,
 * CHAR_BROOKE_CALLAHAN, CHAR_ASHFORD_STUDENT_CROWD) cùng lỗi
 * clickWithOverlayDismiss timeout, log tối giản 1 dòng giống hệt dấu hiệu
 * nút bị aria-disabled="true" — xem waitForGenerateButtonEnabled): debug
 * snapshot của CHAR_NATE_RYDER cho thấy 1 card ĐANG GENERATE ĐÚNG PROMPT của
 * chính entry này (badge "Create" hiện "1") — tức lần click ĐẦU đã THỰC SỰ
 * thành công (generation đã bắt đầu), nhưng Playwright vẫn coi lần click đó
 * là lỗi (có thể do nút chuyển sang aria-disabled NGAY sau khi bấm, trước
 * khi Playwright kịp xác nhận actionable) → clickWithOverlayDismiss cứ
 * retry tiếp vào 1 nút giờ ĐÃ disabled (vì generation vừa bắt đầu) → mọi
 * lần retry sau ĐỀU thất bại y hệt → cuối cùng throw dù job thật ra ĐÃ chạy.
 * Trước MỖI lần thử/retry, kiểm tra xem đã có card mới xuất hiện chưa (dùng
 * baselineCount đã chụp trước lúc bấm) — nếu có, coi như đã bấm thành công
 * thật, dừng ngay, không click/retry thêm nữa.
 */
export async function clickGenerateButton(
  page: Page,
  button: Locator,
  baselineCount: number,
  timeoutPerAttemptMs = 4000,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await button.click({ timeout: timeoutPerAttemptMs });
      return;
    } catch (err) {
      const alreadySucceeded = (await resultCardLocator(page).count()) > baselineCount;
      if (alreadySucceeded) {
        console.warn(
          "[pollo] click Generate báo lỗi nhưng đã thấy card mới xuất hiện — coi như đã bấm thành công, bỏ qua lỗi.",
        );
        return;
      }
      if (attempt === maxAttempts) throw err;
      await dismissBlockingOverlays(page);
    }
  }
}

/**
 * Nút Generate (prompt-generate-btn) có aria-disabled="true" (kèm class
 * aria-disabled:pointer-events-none) khi tài khoản ĐANG có generation khác
 * chạy đồng thời — xác nhận qua debug snapshot THẬT của đúng job lỗi
 * (test_normal_4_LOCATION_UNDERGROUND_PARKING_GARAGE): tại thời điểm
 * clickWithOverlayDismiss timeout hẳn sau 5 lần thử, DOM cho thấy 2 card
 * khác đang generate (36%, 29%) CÙNG prompt, và chính prompt-generate-btn có
 * aria-disabled="true" thật — tức đây KHÔNG phải overlay che (click không
 * bao giờ có thể thành công dù retry bao nhiêu lần vì nút bị vô hiệu hoá
 * thật, dismissBlockingOverlays không giải quyết được). Nhiều khả năng do
 * các lần chạy/restart trước để lại generation tồn đọng (click generate đã
 * thành công server-side nhưng bot không kịp phát hiện xong trước khi lỗi ở
 * bước khác, vd timeout mạng) — chờ nút hết disabled (tức các generation cũ
 * xong dần) thay vì cắm đầu click liên tục vào 1 nút không thể bấm được.
 *
 * timeoutMs mặc định = config.generationTimeoutMs (KHÔNG dùng con số cố định
 * ngắn hơn) — theo xác nhận của user: hàng đợi ảnh và video chạy SONG SONG,
 * dùng CHUNG 1 tài khoản pollo.ai, nên 2 slot đang bận là BÌNH THƯỜNG (1 ảnh
 * + 1 video), không phải rác tồn đọng. Slot bận có thể mất tới hẳn 1 chu kỳ
 * generationTimeoutMs để tự giải phóng (job kia cũng chờ tối đa từng đó) —
 * xác nhận qua lỗi thật (job LOC_IMPERIAL_CITY_OUTER_ROAD): dùng con số cứng
 * 20 phút TRÙNG với timeout 1 lượt generate khiến việc chờ luôn "suýt trượt"
 * ở đúng ranh giới, hết hạn ngay trước khi job kia kịp xong.
 */
export async function waitForGenerateButtonEnabled(
  page: Page,
  button: Locator,
  timeoutMs = config.generationTimeoutMs,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const disabled = await button.getAttribute("aria-disabled").catch(() => null);
    if (disabled !== "true") return;
    if (Date.now() - start >= timeoutMs) {
      console.warn(
        `[pollo] Nút Generate vẫn bị khoá (aria-disabled="true") sau ${timeoutMs}ms — có thể tài khoản đang tồn đọng nhiều generation cũ. Thử click luôn dù nhiều khả năng vẫn lỗi.`,
      );
      return;
    }
    await page.waitForTimeout(5000);
  }
}

/**
 * Bắt response request submit generate (POST /api/trpc/<xxx>.create — xxx
 * tuỳ loại: text2Image, ref2Video,... KHÔNG cần biết tên chính xác, chỉ cần
 * khớp ĐÚNG DẠNG response) NGAY LÚC bấm Generate, lấy "record id" (số) để
 * poll trạng thái qua API (xem waitForGenerationApiStatus) thay vì dò DOM —
 * xác nhận qua network trace THẬT (script test-pollo-network-trace, theo
 * yêu cầu user "có cách nào check job gen xong hay chưa dựa vào videoID"):
 * response trả về NGAY {"id":123894368,"status":"waiting","videoMeta":null},
 * generic cho mọi loại generate (ảnh/video) vì cùng dùng chung 1 hệ thống
 * generationPolling phía sau. Trả về null nếu không bắt được (lỗi mạng, hoặc
 * pollo.ai đổi API) — caller PHẢI tự fallback về dò DOM như cũ, không coi
 * null là lỗi.
 *
 * SỬA (xác nhận qua lỗi thật, 2 lần chạy test-pollo-generate-image liền
 * nhau): body LUÔN là 1 MẢNG bọc ngoài (dạng batch link của tRPC, do chính
 * pollo.ai gọi kèm "?batch=1" dù chỉ 1 procedure) — vd
 * `[{"result":{"data":{"json":{"id":123899141,...}}}}]`, KHÔNG phải object
 * trần. Bản đầu đọc thẳng `body.result...` (bỏ qua mảng bọc ngoài) nên `id`
 * luôn undefined, khiến hàm này LUÔN trả về null một cách ÂM THẦM (fallback
 * DOM vẫn chạy đúng nên job vẫn thành công, che mất bug này tới tận khi thêm
 * log debug mới lộ ra). timeout 60s (không phải 15s bản đầu) giữ nguyên vì
 * vẫn là 1 vấn đề thật riêng biệt (clickWithOverlayDismiss có thể retry tới
 * ~20s), dù không phải nguyên nhân chính của lần lỗi này.
 *
 * SỬA LẦN 2 (xác nhận qua lỗi thật, generateVideo mode Reference to Video —
 * xem docstring waitForNewResult trong file này): endpoint submit CỦA VIDEO
 * tên là "recipe.submit", KHÔNG PHẢI "<xxx>.create" như ảnh — regex cũ chỉ
 * khớp ".create" nên không bắt được gì ở nhánh video, luôn âm thầm trả về
 * null (test-pollo-generate-video vẫn thành công qua fallback DOM, không có
 * dòng log "API record" nào — phải trace lại qua network mới lộ ra). Response
 * CÙNG DẠNG {id,status} (`[{"result":{"data":{"json":{"id":...,"status":
 * "waiting","requestLimit":false}}}}]`) — chỉ cần khớp thêm ".submit" là đủ,
 * không cần đọc thêm field nào khác.
 */
export async function captureGenerationRecordId(
  page: Page,
  clickAction: () => Promise<void>,
): Promise<number | null> {
  const responsePromise = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        /\/api\/trpc\/[a-zA-Z0-9_]+\.(create|submit)(\?|$)/.test(res.url()),
      { timeout: 60_000 },
    )
    .catch(() => null);

  await clickAction();

  const res = await responsePromise;
  if (!res) return null;
  const body = await res.json().catch(() => null);
  const entry = Array.isArray(body) ? body[0] : body;
  const id = entry?.result?.data?.json?.id;
  return typeof id === "number" ? id : null;
}

/**
 * Poll GET /api/trpc/generationPolling.fetchRecordsStatus (recordId từ
 * captureGenerationRecordId) tới khi status rời khỏi các trạng thái CHƯA
 * XONG đã biết — xác nhận qua test thật (script test-pollo-poll-status):
 * status ban đầu "waiting" (kèm waiting.waitingIndex/waitingCount — hàng đợi
 * CHUNG của pollo.ai, có lúc lên tới ~288, giải thích vì sao generate có thể
 * mất khá lâu ngay cả khi không có gì bất thường), sau khi xong chuyển thành
 * ĐÚNG CHUỖI "succeed" (không phải "success"/"completed"/"done").
 *
 * SỬA (xác nhận qua lỗi thật, generateVideo mode Reference to Video): còn có
 * trạng thái TRUNG GIAN "processing" (queue đã xong, đang generate thật) —
 * bản đầu coi "khác waiting là xong" nên dừng poll NGAY khi thấy
 * "processing", trả về status sai (chưa xong thật) và caller hiểu nhầm là
 * terminal. Danh sách CHƯA XONG giờ là {waiting, processing} — status nào
 * khác 2 giá trị này mới coi là terminal. CHƯA có bằng chứng thật cho trạng
 * thái lỗi (status khi thất bại) — trả nguyên văn status terminal đó ra cho
 * caller tự log/xử lý, KHÔNG đoán bừa ý nghĩa; có thể còn trạng thái trung
 * gian khác chưa gặp, sửa tiếp khi có bằng chứng mới.
 *
 * PHẢI gọi fetch qua page.evaluate (chạy như JS thật của chính trang), KHÔNG
 * dùng page.context().request/page.request — xác nhận qua lỗi thật: gọi
 * trực tiếp qua context.request bị Cloudflare trả 403 "Just a moment..."
 * (cf-mitigated: challenge) dù cookie session hợp lệ, giống hệt lý do curl
 * luôn bị chặn ở domain pollo.ai chính đã xác nhận trước đó — chỉ request
 * phát ra THẬT SỰ từ trong page (đúng TLS/JS fingerprint trình duyệt) mới
 * qua được.
 */
const NON_TERMINAL_GENERATION_STATUSES = new Set(["waiting", "processing"]);

export async function waitForGenerationApiStatus(
  page: Page,
  recordId: number,
  timeoutMs: number,
  jobId: string,
  pollIntervalMs = 5000,
  progressSnapshotIntervalMs = 30_000,
): Promise<string | null> {
  const url = new URL("/api/trpc/generationPolling.fetchRecordsStatus", config.polloBaseUrl);
  url.searchParams.set("input", JSON.stringify({ json: { recordIds: [recordId] } }));
  const urlStr = url.toString();

  const start = Date.now();
  // Ảnh debug định kỳ để theo dõi tiến trình gen trong lúc đang chờ (theo
  // yêu cầu người dùng) — mỗi lần chụp là 1 file riêng
  // (storage/debug/<jobId>_progress-<n>.png), KHÔNG ghi đè lên nhau, để xem
  // lại được toàn bộ diễn biến của 1 job thay vì chỉ trạng thái cuối cùng.
  let snapshotSeq = 0;
  let nextSnapshotAt = start + progressSnapshotIntervalMs;
  while (Date.now() - start < timeoutMs) {
    const record = await page
      .evaluate(async (u) => {
        const res = await fetch(u, { credentials: "include" });
        if (!res.ok) return null;
        return res.json();
      }, urlStr)
      .then((body: any) => body?.result?.data?.json?.[0] ?? null)
      .catch(() => null);

    if (record && !NON_TERMINAL_GENERATION_STATUSES.has(record.status)) {
      return record.status as string;
    }
    if (Date.now() >= nextSnapshotAt) {
      snapshotSeq += 1;
      await captureSnapshot(page, `${jobId}_progress-${snapshotSeq}`, "progress");
      nextSnapshotAt += progressSnapshotIntervalMs;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  return null;
}

/**
 * Lấy chi tiết record đã xong (mediaUrl, videoId) qua GET
 * /api/trpc/generation.queryRecordDetail — CHỈ dùng làm phương án dự phòng
 * cuối (xem downloadResultImages/downloadResultVideo call site) khi DOM đã
 * xác nhận KHÔNG hiện được kết quả dù API báo "succeed" (đúng kiểu bug đã
 * gặp thật ở mode Reference to Video/chat_box — xem waitForNewResult trong
 * pollo.ts). mediaUrl xác nhận qua test thật là URL CDN gốc ("ori/..."),
 * dùng chung field name cho cả ảnh lẫn video (mediaType phân biệt loại) —
 * CHƯA kiểm chứng riêng cho video, nên bọc null-safe, không throw nếu thiếu
 * field.
 */
export async function fetchGenerationRecordDetail(
  page: Page,
  recordId: number,
): Promise<{ mediaUrl: string | null; videoId: string | null } | null> {
  const url = new URL("/api/trpc/generation.queryRecordDetail", config.polloBaseUrl);
  url.searchParams.set("input", JSON.stringify({ json: { id: recordId } }));
  const urlStr = url.toString();

  const data = await page
    .evaluate(async (u) => {
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    }, urlStr)
    .then((body: any) => body?.result?.data?.json ?? null)
    .catch(() => null);

  if (!data) return null;
  return {
    mediaUrl: typeof data.mediaUrl === "string" ? data.mediaUrl : null,
    videoId: typeof data.videoId === "string" ? data.videoId : null,
  };
}

/**
 * Mở dialog Uploads qua nút toggle (data-testid="upload-card-asset-picker"/
 * uploadCardButtonByLabel — aria-haspopup="dialog", aria-expanded) — xác
 * nhận qua lỗi thật LẶP LẠI RẤT NHIỀU LẦN (hàng loạt job khác nhau, luôn
 * cùng 1 kiểu: dialog Uploads đã ĐÓNG HẲN lúc chụp snapshot lỗi dù
 * setInputFiles trước đó chạy thành công — nghĩa là dialog CÓ mở lúc đầu):
 * nút này là DIV toggle (KHÔNG phải <button> thật, xem class group/upload-
 * card + before/after hover-animation group-hover/image-upload:!translate-x)
 * rất dễ bị Playwright báo "element is not stable" NGAY LÚC click vừa đăng
 * ký — tức click ĐÃ thực sự mở dialog thành công nhưng Playwright vẫn coi
 * là lỗi (do đang bận animate). clickWithOverlayDismiss (dùng cho click
 * thường) sẽ RETRY click khi gặp lỗi này — click thêm 1 lần NỮA vào ĐÚNG
 * nút toggle đó sẽ ĐÓNG LẠI dialog vừa mở (vì aria-expanded đảo trạng thái
 * mỗi lần bấm), giải thích chính xác triệu chứng "dialog tự đóng giữa
 * chừng" đã thấy lặp lại ở rất nhiều job.
 *
 * SỬA LẦN 1: trước MỖI lần thử click, kiểm tra aria-expanded — nếu đã
 * "true" (đã mở, kể cả khi lần thử click TRƯỚC đó báo lỗi) thì DỪNG NGAY,
 * không click thêm lần nào nữa.
 *
 * SỬA LẦN 2 (xác nhận qua lỗi thật vẫn LẶP LẠI y hệt sau bản sửa lần 1, job
 * microdrama_SHOT_01_CLIP_01_VIDEO và nhiều job khác — snapshot lỗi vẫn cho
 * thấy aria-expanded="false", dialog vẫn đóng): click() KHÔNG throw KHÔNG
 * có nghĩa là dialog ĐÃ THỰC SỰ mở — trả về ngay khi click() không lỗi là
 * SAI, vì click có thể "trượt" (đăng ký lên 1 phần tử khác do đang animate,
 * hoặc React chưa kịp xử lý) mà Playwright không phát hiện ra. XÁC MINH
 * TRỰC TIẾP bằng cách chờ uploadDialogFileInputLocator (input file ẩn CHỈ
 * tồn tại khi dialog đã render) xuất hiện — chỉ coi là mở thành công khi
 * thấy input này, không suy luận qua trạng thái click()/aria-expanded nữa.
 */
export async function ensureUploadDialogOpen(
  page: Page,
  trigger: Locator,
  maxAttempts = 5,
): Promise<void> {
  const fileInput = uploadDialogFileInputLocator(page);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const expanded = await trigger.getAttribute("aria-expanded").catch(() => null);
    if (expanded !== "true") {
      try {
        await trigger.click({ timeout: 4000 });
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await dismissBlockingOverlays(page);
        continue;
      }
    }

    const opened = await fileInput
      .waitFor({ state: "attached", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    if (attempt === maxAttempts) {
      throw new GenerationError(
        "Không mở được dialog Uploads sau nhiều lần thử (click không lỗi nhưng dialog không thực sự render).",
      );
    }
    await dismissBlockingOverlays(page);
  }
}

/**
 * Xác nhận qua test thật (job inspect-pollo-deeplink, theo phát hiện của
 * user): pollo.ai hỗ trợ deep-link set sẵn CẢ mode lẫn model ngay qua URL —
 * vd https://pollo.ai/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03
 * mở lên là mode chip đã hiện "Reference to Video" và model chip đã hiện
 * "MiniMax H3" luôn, KHÔNG cần bấm mode chip/model popup gì cả — né hẳn bug
 * click bị chặn khi chọn model qua popup (xem docstring selectModel bên
 * dưới). Chỉ áp dụng khi biết chắc slug URL của mode/model (map cứng bên
 * dưới, mới xác nhận đúng 1 cặp) — mode/model KHÔNG có trong map thì vẫn phải
 * dùng lại cách bấm popup cũ (switchModeIfNeeded/selectModel).
 */
const MODE_URL_SLUGS: Record<string, string> = {
  "reference to video": "reference-to-video",
};

const MODEL_URL_SLUGS: Record<string, string> = {
  "minimax h3": "minimax-hailuo-03",
};

interface DeepLink {
  url: string;
  includesModel: boolean;
}

function buildDeepLinkUrl(modeName: string, modelName?: string): DeepLink | null {
  const modeSlug = MODE_URL_SLUGS[modeName.toLowerCase()];
  if (!modeSlug) return null;

  const url = new URL(`/${modeSlug}`, config.polloBaseUrl);
  url.searchParams.set("target", modeSlug);

  let includesModel = false;
  if (modelName) {
    const modelSlug = MODEL_URL_SLUGS[modelName.toLowerCase()];
    if (modelSlug) {
      url.searchParams.set("modelName", modelSlug);
      includesModel = true;
    }
  }

  return { url: url.toString(), includesModel };
}

/**
 * Đọc nhãn chip MODEL hiện tại — bỏ qua nếu đã đúng model cần chọn (tránh mở
 * popup thừa). Gõ vào ô Search để lọc trước khi click — nhanh và tránh phải
 * cuộn qua danh sách dài (xem modelSearchInputLocator/modelDialogOptionLocator
 * trong polloSelectors.ts).
 *
 * CHỈ còn dùng làm fallback khi buildDeepLinkUrl() ở trên không áp dụng được
 * (mode/model chưa có slug xác nhận) — xem generateVideo().
 *
 * Xác nhận qua debug thật (8 lần thử, job debug-pollo-video-reference) + test
 * tay của user (bấm chuột người thật chọn được MiniMax H3 bình thường): đây
 * là race-condition riêng của tự động hoá, KHÔNG phải bug chung của site.
 * Nghi ngờ nguyên nhân: popup model dùng Base UI, có 1 lớp overlay
 * `data-base-ui-inert` chặn click trong lúc popup đang animate mở/đóng hoặc
 * đang re-render lại danh sách sau khi gõ Search — Playwright click nhanh hơn
 * nhịp animate/re-render này nên luôn dính đúng khoảnh khắc bị chặn, còn
 * người bấm tay thì chậm hơn animation nên không bao giờ gặp. Vì lỗi này chỉ
 * mang tính THỜI ĐIỂM (transient), fix bằng cách LẶP LẠI việc click (không
 * phải click 1 lần rồi bỏ qua lỗi bằng force) trong một khoảng thời gian, để
 * lần click nào rơi đúng lúc popup đã "yên" (không còn bị inert đè) thì sẽ
 * qua. Sau đó bắt buộc ĐỌC LẠI nhãn chip để xác nhận đã đổi đúng model — nếu
 * không đổi thì throw lỗi rõ ràng thay vì im lặng tiếp tục chạy sai model.
 */
async function selectModel(page: Page, modelName: string): Promise<void> {
  const chip = modelChipLocator(page).first();
  const currentLabel = await chip.innerText().catch(() => "");
  if (currentLabel.trim().toLowerCase() === modelName.toLowerCase()) return;

  await chip.click({ timeout: 10_000 });
  const searchInput = page.locator('input[placeholder="Search…"]');
  await searchInput.fill(modelName).catch(() => {});
  await page.waitForTimeout(800);

  const row = modelDialogOptionLocator(page, modelName).first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
  await page.waitForTimeout(300);

  const retryDeadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < retryDeadline) {
    try {
      await row.click({ timeout: 1_500, position: { x: 10, y: 5 } });
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(400);
    }
  }

  await page.waitForTimeout(500);
  const newLabel = await chip.innerText().catch(() => "");
  if (newLabel.trim().toLowerCase() !== modelName.toLowerCase()) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
    throw new GenerationError(
      `Không thể chọn model "${modelName}" trên pollo.ai (nhãn hiện tại: "${newLabel.trim()}"). ${detail}`,
    );
  }
}

/**
 * Set giá trị input[type=range] bằng JS (KHÔNG click/drag được — xem docstring
 * videoLengthSliderInputLocator: input thật bị clip-path ẩn đi, chỉ hiện
 * track/thumb custom vẽ riêng, Playwright coi input "không visible" nên click
 * thường fail actionability check). Dùng lại đúng "native setter trick" chuẩn
 * cho input do React kiểm soát (React ghi đè setter value gốc để track thay
 * đổi qua state riêng — set thẳng qua el.value=... sẽ bị React "phớt lờ" vì
 * không đi qua setter gốc mà React theo dõi) — gọi setter GỐC của
 * HTMLInputElement.prototype rồi tự bắn "input"+"change" để component nghe
 * được, giống cách vẫn dùng cho input do React kiểm soát nói chung.
 */
async function setSliderValue(input: Locator, value: number): Promise<void> {
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/**
 * Chọn độ dài video (vd "6s") — pollo.ai dùng 2 kiểu UI khác nhau tuỳ
 * mode/model, PHẢI thử cả 2 (chưa có cách nào biết trước chắc chắn ngoài
 * việc kiểm tra DOM thực tế):
 *
 * 1. SLIDER kéo thả (min/max tuỳ model, vd MiniMax H3 ở mode "Reference to
 *    Video" là 4-15s) — xác nhận qua DOM thật user cung cấp trực tiếp (job
 *    inspect-pollo-duration-slider): input[type=range] có SẴN ngay khi trang
 *    vừa load, KHÔNG cần bấm chip nào cả. Kiểm tra input này TRƯỚC (rẻ hơn,
 *    không cần click) — có thì set thẳng qua setSliderValue, xong.
 *
 * 2. Chip settings gộp dạng NÚT BẤM cố định (paramsChipLocator, hiện text
 *    "5s / 480p / 16:9 / 1") — xác nhận qua DOM thật (job inspect-pollo-
 *    duration3), dùng cho mode "Text/Image to Video" (model Pollo 2.0 chỉ có
 *    2 option 5s/10s, KHÔNG có slider) — chỉ thử kiểu này nếu KHÔNG tìm thấy
 *    slider ở bước 1.
 *
 * Model/mode không hỗ trợ độ dài yêu cầu (option không tồn tại trong danh
 * sách nút, hoặc ngoài khoảng min-max của slider) thì BEST-EFFORT bỏ qua (log
 * cảnh báo, KHÔNG throw — giống selectDurationIfNeeded của aiVideo.ts, độ dài
 * sai không đáng để chặn cả pipeline generate).
 */
async function selectDurationIfNeeded(page: Page, duration: string): Promise<void> {
  const seconds = Number.parseInt(duration, 10);

  const sliderInput = videoLengthSliderInputLocator(page).first();
  const sliderExists = (await sliderInput.count().catch(() => 0)) > 0;
  if (sliderExists) {
    if (!Number.isFinite(seconds)) {
      console.warn(
        `[pollo] selectDurationIfNeeded: không đọc được số giây từ "${duration}" — bỏ qua slider.`,
      );
      return;
    }
    const min = Number(await sliderInput.getAttribute("min").catch(() => null)) || 0;
    const max = Number(await sliderInput.getAttribute("max").catch(() => null)) || 999;
    const clamped = Math.min(max, Math.max(min, seconds));
    if (clamped !== seconds) {
      console.warn(
        `[pollo] selectDurationIfNeeded: "${duration}" ngoài khoảng slider [${min}-${max}], dùng "${clamped}s" thay thế.`,
      );
    }
    await setSliderValue(sliderInput, clamped);
    await page.waitForTimeout(300);
    const newValue = await sliderInput.getAttribute("value").catch(() => null);
    if (Number(newValue) !== clamped) {
      console.warn(
        `[pollo] selectDurationIfNeeded: đã set slider ${clamped}s nhưng value đọc lại là "${newValue}" — có thể không áp dụng được, tiếp tục generate.`,
      );
    }
    return;
  }

  const chip = paramsChipLocator(page).first();
  const chipExists = await chip.isVisible({ timeout: 2000 }).catch(() => false);
  if (!chipExists) {
    console.warn(
      `[pollo] selectDurationIfNeeded: không thấy slider lẫn chip settings (mode hiện tại có thể không hỗ trợ chọn độ dài) — bỏ qua, dùng độ dài mặc định.`,
    );
    return;
  }

  const currentLabel = await chip.innerText().catch(() => "");
  if (currentLabel.trim().toLowerCase().startsWith(duration.toLowerCase())) return;

  await chip.click({ timeout: 10_000 });
  await page.waitForTimeout(500);

  const option = videoLengthOptionLocator(page, duration).first();
  const optionExists = await option.isVisible({ timeout: 3000 }).catch(() => false);
  if (!optionExists) {
    console.warn(
      `[pollo] selectDurationIfNeeded: model hiện tại không có option độ dài "${duration}" — bỏ qua, dùng độ dài mặc định.`,
    );
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  await option.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);

  const newLabel = await chip.innerText().catch(() => "");
  if (!newLabel.trim().toLowerCase().startsWith(duration.toLowerCase())) {
    console.warn(
      `[pollo] selectDurationIfNeeded: đã bấm option "${duration}" nhưng chip vẫn hiện "${newLabel.trim()}" — có thể không áp dụng được, tiếp tục generate.`,
    );
  }
}

/**
 * Provider MỚI (pollo.ai) chạy SONG SONG với AIVideo (aiVideo.ts) — KHÔNG
 * thay thế, KHÔNG wired vào queue.ts. Xem chú thích đầu polloImage.ts (cùng
 * quy ước, cùng mức độ bằng chứng DOM thật/chưa xác nhận).
 *
 * QUAN TRỌNG (xác nhận qua thực tế, xem storage/debug/inspect-pollo-video-
 * download-menu.png): video tải về LUÔN có watermark "Pollo.ai" trừ khi tài
 * khoản có gói hỗ trợ "Download without watermark" (tài khoản test hiện tại
 * KHÔNG có — bấm vào hiện popup yêu cầu nâng cấp gói Pro/Ultra). downloadVideo
 * bên dưới mặc định lấy src watermark (video.vjs-tech), CHƯA thử tải bản
 * sạch — cần bật lại nếu tài khoản nâng cấp gói.
 *
 * Mode "Frames to Video" (2 slot "Start"/"End" cố định) là tương đương gần
 * nhất với "Start/End Frame" của AIVideo — dùng khi có startFramePath.
 *
 * Mode "Reference to Video" — dùng khi có referenceImagePaths (nhiều ảnh,
 * vd CHARACTER/LOCATION/SCENE_SETTING_START/END cho storyboard) — KHÔNG có
 * slot cố định như Frames to Video: upload từng ảnh qua nút "+" riêng
 * (uploadCardButtonForImage), rồi PHẢI "@ mention" từng ảnh vào prompt thì
 * model mới thực sự dùng ảnh đó làm tham chiếu (xác nhận qua DOM thật —
 * placeholder ghi rõ "Upload images or videos and @ them as references to
 * guide your video."). Cơ chế mention: bấm nút "@" (chỉ có khi editor CÒN
 * RỖNG, xem mentionButtonLocator) HOẶC gõ trực tiếp ký tự "@" bằng bàn phím
 * (xác nhận qua debug thật: mở được ĐÚNG picker tương tự dù editor đã có chữ)
 * — mở popup chọn asset, mỗi item mang data-testid="asset-item-upload" và
 * tên hiển thị = tên file KHÔNG đuôi mở rộng (trùng quy ước sanitizeId của
 * storyboardPipeline.ts) — click item đó để chèn "@tên" vào đúng vị trí con
 * trỏ. Ở đây chèn TẤT CẢ mention vào CUỐI prompt (sau khi gõ xong nội dung
 * chính), cách nhau bằng dấu cách — CHƯA xác nhận model có yêu cầu vị trí cụ
 * thể trong câu hay không (vd phải mention ngay chỗ mô tả nhân vật đó), tạm
 * dùng cách đơn giản/an toàn nhất.
 */

export interface PolloGenerateVideoOptions {
  /** Ảnh start frame (tuỳ chọn) — có giá trị thì chuyển sang mode "Frames to Video". */
  startFramePath?: string;
  /** Ảnh end frame (tuỳ chọn, chỉ dùng cùng startFramePath). */
  endFramePath?: string;
  /** Ảnh tham chiếu (tuỳ chọn, nhiều ảnh) — có giá trị (và KHÔNG có startFramePath) thì chuyển sang mode "Reference to Video", @ mention từng ảnh vào cuối prompt. */
  referenceImagePaths?: string[];
  /** Tên model hiển thị đúng như trên UI (vd "MiniMax H3") — không truyền thì giữ nguyên model đang chọn sẵn. */
  model?: string;
  /** Độ dài video, dạng "Ns" (vd "6s") — khớp field "duration" (giây) trong JSON storyboard, chuẩn hoá giống AIVideo (xem storyboardPipeline.ts). Model/mode không có option này thì bỏ qua, dùng độ dài mặc định (xem selectDurationIfNeeded). */
  duration?: string;
}

/** Đọc nhãn chip mode HIỆN TẠI — bỏ qua việc mở menu nếu đã đúng mode cần dùng (tránh thao tác thừa, giống selectChipOption của AIVideo). */
async function switchModeIfNeeded(page: Page, modeName: string): Promise<void> {
  const chip = modeChipLocator(page).first();
  const currentLabel = await chip.innerText().catch(() => "");
  if (currentLabel.trim().toLowerCase() === modeName.toLowerCase()) return;

  await chip.click({ timeout: 10_000 });
  await modeMenuOptionLocator(page, modeName).first().click({ timeout: 10_000 });
}

/**
 * Nộp file vào input ẩn của dialog Uploads rồi chờ card MỚI xuất hiện, click
 * chọn nó rồi bấm Select — trả về data-asset-url của card đó (dùng cho
 * insertMentionForFile khớp theo URL, xem chú thích ở đó).
 *
 * LỊCH SỬ 2 CÁCH LÀM CŨ, cả 2 đều KHÔNG scale khi thư viện Uploads của tài
 * khoản lớn dần (xác nhận qua debug thật, job debug-pollo-upload-stuck: sau
 * nhiều lần test trong session này, tài khoản đã có 65+ item, và dialog
 * Uploads render TOÀN BỘ lịch sử, không phải chỉ vài item gần nhất):
 * 1. Đếm document.querySelectorAll(...).length trước/sau — mỗi lần gọi phải
 *    duyệt HẾT mọi card khớp selector trên toàn trang, càng nhiều item càng
 *    chậm, khiến cả việc chờ "ổn định" lẫn việc chờ "tăng thêm 1" đều có thể
 *    vượt timeout dù ảnh vẫn xử lý bình thường (không phải bug thật).
 * 2. Thêm bước "chờ ổn định" trước khi lấy baseline — chỉ giảm nhẹ rủi ro,
 *    không giải quyết gốc rễ (thư viện càng lớn, chờ ổn định càng lâu).
 *
 * CÁCH MỚI: dùng document.querySelector(...) (không phải querySelectorAll)
 * — chỉ cần tìm ĐÚNG 1 phần tử ĐẦU TIÊN khớp selector, KHÔNG phải duyệt hết
 * toàn bộ danh sách, nên tốc độ không phụ thuộc thư viện lớn hay nhỏ. Dựa
 * vào bằng chứng thật đã xác nhận nhiều lần: card MỚI upload luôn chèn NGAY
 * ĐẦU lưới (ngay sau nút "Upload Media", "Upload Media" bản thân KHÔNG mang
 * data-testid="asset-picker-card" nên không tính) — so sánh data-asset-url
 * của ĐÚNG card đầu tiên trước/sau, không cần biết tổng số lượng.
 *
 * Có data-asset-url MỚI KHÔNG có nghĩa là ảnh đã xử lý xong hẳn (theo yêu
 * cầu người dùng: phải xác nhận HẾT "Uploading" mới được chuyển sang ảnh
 * tiếp theo) — chờ thêm cho tới khi uploadingSpinnerLocator không còn phần
 * tử nào trong dialog nữa mới coi là hoàn tất, tránh nộp/chọn ảnh kế tiếp
 * trong khi ảnh này (hoặc 1 placeholder khác đang chờ) vẫn còn xử lý dở.
 */
/** Ngưỡng coi 1 ảnh trong picker Uploads là "của lần gen khác" (đủ cũ để xoá) — xem deleteStaleUploadedAssets. */
const STALE_ASSET_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Xoá các ảnh CŨ (uploads của lần gen khác) trong picker Uploads trước khi
 * upload ảnh mới — theo yêu cầu người dùng, tránh picker "@ mention" ngày
 * càng đầy ảnh không liên quan (xem chú thích submitAssetUpload: thư viện đã
 * ghi nhận 65+ item).
 *
 * CHỈ xoá card có timestamp (nhúng trong data-asset-url, xem
 * extractAssetTimestampMs) CŨ HƠN STALE_ASSET_THRESHOLD_MS so với thời điểm
 * gọi — KHÔNG xoá "tất cả ảnh khác" ngay lập tức. Lý do: processPolloVideoQueue
 * và processPolloImageQueue chạy SONG SONG ĐỘC LẬP trên CÙNG 1 tài khoản (2
 * context riêng, xem polloBrowser.ts) — xoá ngay ảnh vừa upload xong của 1
 * job KHÁC đang chạy cùng lúc (video hoặc ảnh) sẽ làm hỏng job đó giữa chừng,
 * mà xoá trên pollo.ai KHÔNG THỂ hoàn tác (xác nhận qua popup thật:
 * "Are you sure you want to delete? This can't be undone." — xem
 * scripts/inspect-pollo-asset-delete-confirm.ts). Ngưỡng 60 phút (đã tăng từ
 * 10 phút ban đầu) đủ dư an toàn cho mọi bước upload+mention của 1 entry
 * (thường xong trong dưới 1 phút).
 *
 * Card MỚI luôn chèn ĐẦU lưới (đã xác nhận nhiều lần, xem docstring
 * submitAssetUpload) nên danh sách luôn sắp theo thời gian giảm dần — xoá
 * lần lượt từ CUỐI (.last(), cũ nhất) lên, DỪNG NGAY khi gặp card đủ mới
 * hoặc không đọc được timestamp (an toàn hơn đoán tiếp, tránh xoá nhầm nếu
 * thứ tự thực tế không đúng như giả định).
 *
 * Xác nhận DOM thật: hover card hiện nút button[aria-label="Delete"]; bấm
 * xong hiện popup xác nhận dùng chung convention modal-popup của site
 * (data-slot="modal-ok" = nút xác nhận xoá, "modal-cancel" = huỷ).
 */
export async function deleteStaleUploadedAssets(page: Page): Promise<void> {
  const cards = assetPickerCardLocator(page);
  const cutoff = Date.now() - STALE_ASSET_THRESHOLD_MS;

  for (let i = 0; i < 200; i++) {
    const count = await cards.count().catch(() => 0);
    if (count === 0) return;

    const last = cards.last();
    const url = await last.getAttribute("data-asset-url").catch(() => null);
    if (!url) return;

    const ts = extractAssetTimestampMs(url);
    if (ts === null || ts >= cutoff) return;

    await last.hover().catch(() => {});
    const deleted = await last
      .locator('button[aria-label="Delete"]')
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!deleted) return;

    const confirmed = await page
      .locator('button[data-slot="modal-ok"]')
      .first()
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!confirmed) {
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Cache LOCAL (persist ra file, sống qua cả restart bot) ánh xạ đường dẫn
 * file ẢNH tuyệt đối → assetUrl đã upload lên pollo.ai lần gần nhất — theo
 * yêu cầu người dùng: nhiều video/shot trong CÙNG 1 storyboard (hoặc khác
 * storyboard chạy gần nhau) dùng CHUNG 1 file tham chiếu (CHARACTER/LOCATION
 * không đổi giữa các shot) — upload lại y hệt file đó mỗi lần là dư thừa,
 * vừa tốn thời gian vừa làm thư viện Uploads phình to nhanh hơn.
 *
 * TTL độc lập với STALE_ASSET_THRESHOLD_MS (deleteStaleUploadedAssets hiện
 * đang bị comment tắt ở dưới — KHÔNG dựa vào việc nó có chạy hay không) —
 * chỉ để tránh dùng lại URL quá cũ nếu sau này ảnh bị xoá thủ công hoặc do
 * cơ chế dọn rác nào đó. submitAssetUpload bên dưới LUÔN xác minh card còn
 * thật trong picker trước khi dùng (waitFor visible) — cache hết hạn hoặc
 * card đã biến mất vì bất kỳ lý do gì đều tự rơi xuống nhánh upload lại bình
 * thường, KHÔNG throw.
 */
const ASSET_CACHE_PATH = path.resolve("./storage/pollo-asset-cache.json");
const ASSET_CACHE_TTL_MS = 55 * 60 * 1000;
/** Xoá hẳn entry khỏi file cache sau ngần này — theo yêu cầu người dùng, tránh file phình to vô hạn (mỗi file ảnh tham chiếu MỚI của MỌI storyboard đều thêm 1 entry, KHÔNG entry nào tự mất nếu không có bước dọn này). */
const ASSET_CACHE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

interface AssetCacheEntry {
  assetUrl: string;
  uploadedAtMs: number;
}

let assetCache: Record<string, AssetCacheEntry> | null = null;

function readAssetCacheFile(): Record<string, AssetCacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(ASSET_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/** Xoá khỏi cache (mutate tại chỗ) mọi entry đã quá ASSET_CACHE_MAX_AGE_MS — gọi lúc load (dọn phần đã cũ từ trước khi bot khởi động lại) VÀ mỗi lần ghi thêm entry mới (dọn phần vừa "quá hạn" trong lúc bot chạy liên tục nhiều ngày không restart). */
function pruneAssetCache(cache: Record<string, AssetCacheEntry>): void {
  const cutoff = Date.now() - ASSET_CACHE_MAX_AGE_MS;
  for (const key of Object.keys(cache)) {
    if (cache[key].uploadedAtMs < cutoff) delete cache[key];
  }
}

function loadAssetCache(): Record<string, AssetCacheEntry> {
  if (!assetCache) {
    assetCache = readAssetCacheFile();
    pruneAssetCache(assetCache);
  }
  return assetCache;
}

function getCachedAssetUrl(imagePath: string): string | null {
  const entry = loadAssetCache()[path.resolve(imagePath)];
  if (!entry) return null;
  if (Date.now() - entry.uploadedAtMs >= ASSET_CACHE_TTL_MS) return null;
  return entry.assetUrl;
}

function rememberUploadedAsset(imagePath: string, assetUrl: string): void {
  const cache = loadAssetCache();
  cache[path.resolve(imagePath)] = { assetUrl, uploadedAtMs: Date.now() };
  pruneAssetCache(cache);
  try {
    fs.mkdirSync(path.dirname(ASSET_CACHE_PATH), { recursive: true });
    fs.writeFileSync(ASSET_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.error("[pollo] Không ghi được cache asset:", err);
  }
}

/**
 * Mutex TOÀN CỤC (KHÔNG reentrant — TUYỆT ĐỐI không gọi lồng nhau) khoá pha
 * "upload ảnh tham chiếu + chọn nó" (submitAssetUpload) VÀ, riêng với video
 * mode "Reference to Video", CẢ bước "@ mention" tiếp theo
 * (insertMentionForFile) — dùng chung giữa pollo.ts (video) VÀ polloImage.ts
 * (ảnh CHARACTER/LOCATION), vì processPolloVideoQueue/processPolloImageQueue
 * chạy SONG SONG trên CÙNG 1 tài khoản pollo.ai (2 context riêng, xem
 * polloBrowser.ts).
 *
 * XÁC NHẬN QUA LỖI THẬT (job test_normal_7_rep_SHOT_01_CLIP_01_VIDEO,
 * 2026-09-07): insertMentionForFile hết 4 lần retry vẫn không tìm thấy ảnh
 * vừa upload trong picker "@ mention". Đúng như chú thích tại nơi gọi
 * insertMentionForFile đã ghi từ trước: picker "@ mention" CHỈ hiện ĐÚNG VÀI
 * upload GẦN NHẤT CỦA CẢ TÀI KHOẢN (không riêng job này) — job Pollo khác
 * (vd hàng đợi ảnh) upload dồn dập trong lúc job này đang giữ khoảng hở giữa
 * "upload xong" và "click mention" đủ để đẩy hẳn ảnh của job này ra khỏi
 * danh sách đang hiển thị. submitAssetUpload cũng tự nó không an toàn khi
 * chạy đồng thời: hàm này nhận diện "card vừa upload" bằng cách so
 * data-asset-url của card ĐẦU TIÊN trước/sau — nếu 1 job khác upload xen vào
 * đúng lúc đó, card đầu tiên đổi vì URL CỦA JOB KHÁC, khiến job này chọn NHẦM
 * ảnh của người khác làm ảnh tham chiếu (còn nguy hiểm hơn cả việc mention
 * thất bại, vì âm thầm sai kết quả thay vì báo lỗi).
 *
 * Tăng số lần retry không giải quyết được gốc rễ — ảnh có thể ĐÃ THỰC SỰ
 * biến mất khỏi cửa sổ hiển thị đó, chờ/thử lại bao lâu cũng vô ích. Khoá hẳn
 * pha upload+chọn (và mention, với video) giữa 2 hàng đợi đảm bảo tại một
 * thời điểm chỉ 1 job đang thao tác lên thư viện asset dùng chung, loại bỏ
 * hoàn toàn nguồn gây race thay vì giảm xác suất. Phần còn lại của generate
 * (gõ prompt, chờ render, tải video/ảnh — chiếm phần lớn thời gian) vẫn chạy
 * song song bình thường giữa 2 hàng đợi, chỉ pha upload+chọn (thường vài
 * giây/ảnh) bị nối tiếp.
 */
let polloAssetUploadLockTail: Promise<void> = Promise.resolve();

export function withPolloAssetUploadLock<T>(fn: () => Promise<T>): Promise<T> {
  const settled = polloAssetUploadLockTail.then(fn, fn);
  polloAssetUploadLockTail = settled.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}

export async function submitAssetUpload(
  page: Page,
  imagePath: string,
  reopenDialog: () => Promise<void>,
): Promise<string> {
  const cards = assetPickerCardLocator(page);
  const fileInput = uploadDialogFileInputLocator(page);

  // Bỏ chọn HẾT card còn đánh dấu data-selected="true" từ lần gọi TRƯỚC —
  // xác nhận qua lỗi thật (job test_normal_7_rep_SHOT_04_CLIP_02_VIDEO) +
  // script inspect-pollo-picker-selection: nút "Select" hiện "(1/9)" NGAY
  // khi mở lại dialog cho ảnh reference THỨ 2 (trước khi bấm gì cả) — card
  // của ảnh THỨ 1 vẫn còn data-selected="true" dù đã bấm Select+đóng dialog
  // trước đó. Picker KHÔNG tự xoá selection cũ khi đóng/mở lại — mỗi lần
  // upload+chọn ảnh mới trong loop referenceImagePaths (generateVideo) cứ
  // thế TÍCH LŨY thêm 1 card được chọn. Tới lần thứ 3 ("Select (3/9)"),
  // click Select kích hoạt 1 navigation thật của pollo.ai (canonical URL rơi
  // về "/reference-to-video" không còn query deep-link, composer bị RESET
  // sạch, mất hết ảnh/prompt đã nhập) — Playwright báo "waiting for
  // scheduled navigations to finish" rồi timeout đúng vì navigation đó có
  // thật, không phải lỗi giả. Dọn sạch TRƯỚC mỗi lần upload đảm bảo luôn
  // chỉ có ĐÚNG 1 card được chọn khi bấm Select, khớp đúng thiết kế ban đầu
  // (docstring uploadDialogSelectButtonLocator: "chỉ enable sau khi đã click
  // thumbnail" — ngầm giả định single-select, không tính accumulation).
  const selectedCards = page.locator('[data-testid="asset-picker-card"][data-selected="true"]');
  const staleCount = await selectedCards.count().catch(() => 0);
  for (let i = 0; i < staleCount; i++) {
    // Luôn bấm .first() — mỗi lần bỏ chọn thành công, card đó rời khỏi tập
    // hợp khớp selector này, .first() tự trỏ sang card kế tiếp còn sót.
    await selectedCards.first().click({ timeout: 5000 }).catch(() => {});
  }

  // await deleteStaleUploadedAssets(page).catch((err) => {
  //   console.warn("[pollo] deleteStaleUploadedAssets lỗi (bỏ qua, không chặn upload):", err);
  // });

  // Đã upload file NÀY trước đó (còn hạn cache) — thử CHỌN LẠI đúng card cũ
  // thay vì setInputFiles lại từ đầu. Vẫn xác minh card còn thật trong picker
  // (waitFor visible, timeout ngắn) — không suy đoán mù theo cache.
  const cachedUrl = getCachedAssetUrl(imagePath);
  if (cachedUrl) {
    const existingCard = assetPickerCardByUrlLocator(page, cachedUrl).first();
    const stillThere = await existingCard
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (stillThere) {
      await existingCard.click({ timeout: 10_000 });
      await uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
      return cachedUrl;
    }
    // Không còn thấy nữa — rơi xuống upload lại bình thường bên dưới.
  }

  const firstCardUrlBefore = await cards.first().getAttribute("data-asset-url").catch(() => null);

  await fileInput.setInputFiles(imagePath, { timeout: 10_000 });

  // Poll thay vì 1 lần waitForFunction dài — xác nhận qua lỗi thật (job
  // EP01_drama_SHOT_15_CLIP_01_VIDEO): dialog Uploads có thể TỰ ĐÓNG giữa
  // lúc đang chờ (đúng lúc setInputFiles vừa xong, dialog vẫn mở — snapshot
  // lỗi lúc hết 45s cho thấy dialog đã đóng hẳn, không còn card nào cả),
  // khiến document.querySelector(...) mãi mãi trả về null dù file có thể
  // vẫn đang xử lý bình thường phía server. Phát hiện dialog đóng giữa
  // chừng thì MỞ LẠI (không nộp lại file) để đọc trạng thái mới nhất, thay
  // vì cứ chờ 1 selector không bao giờ khớp lại được nữa.
  const deadlineMs = Date.now() + 45_000;
  let reopenedOnce = false;
  let resubmittedOnce = false;
  while (Date.now() < deadlineMs) {
    const currentUrl = await cards.first().getAttribute("data-asset-url").catch(() => null);
    if (currentUrl && currentUrl !== firstCardUrlBefore) {
      // Có data-asset-url MỚI không có nghĩa là đã xử lý xong HẲN — chờ
      // thêm cho tới khi KHÔNG CÒN spinner "Uploading" nào trong dialog mới
      // coi là xong, tránh chuyển sang upload ảnh kế tiếp trong khi ảnh này
      // (hoặc 1 placeholder khác) vẫn đang xử lý dở.
      const stillUploading = (await uploadingSpinnerLocator(page).count().catch(() => 0)) > 0;
      if (!stillUploading) {
        await cards.first().click({ timeout: 10_000 });
        await uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
        rememberUploadedAsset(imagePath, currentUrl);
        return currentUrl;
      }
    }

    const dialogClosed = (await cards.count().catch(() => 0)) === 0;
    if (dialogClosed) {
      if (!reopenedOnce) {
        reopenedOnce = true;
        await reopenDialog().catch(() => {});
      } else if (!resubmittedOnce) {
        // Mở lại 1 lần mà dialog vẫn đóng/không thấy ảnh mới — thử nộp lại
        // file đúng 1 lần (dialog đã mở lại từ bước trên) trước khi chịu thua.
        resubmittedOnce = true;
        await fileInput.setInputFiles(imagePath, { timeout: 10_000 }).catch(() => {});
      }
    }

    await page.waitForTimeout(2000);
  }

  throw new GenerationError(
    "Upload timeout: không thấy ảnh mới xuất hiện trong picker Uploads sau 45s (đã thử mở lại dialog).",
  );
}

/**
 * Cùng cơ chế "phải click thumbnail để chọn trước khi Select enable" đã xác
 * nhận qua lỗi thật — xem docstring uploadReferenceImage trong polloImage.ts.
 * Bọc trong withPolloAssetUploadLock (xem docstring hàm đó) — submitAssetUpload
 * tự nó không an toàn khi 1 job Pollo khác (hàng đợi ảnh) upload xen vào cùng
 * lúc.
 */
async function uploadFrameImage(
  page: Page,
  label: "Start" | "End",
  imagePath: string,
): Promise<void> {
  const openDialog = () => ensureUploadDialogOpen(page, uploadCardButtonByLabel(page, label).first());
  await openDialog();
  await withPolloAssetUploadLock(() => submitAssetUpload(page, imagePath, openDialog));
}

/**
 * Cùng cơ chế upload với uploadFrameImage ở trên, dùng nút upload ẢNH riêng
 * của mode "Reference to Video" (xem uploadCardButtonForImage). Trả về URL
 * ảnh vừa upload (data-asset-url) để insertMentionForFile tìm ĐÚNG item
 * trong picker "@ mention" bằng URL — KHÔNG dùng tên hiển thị (xem chú thích
 * insertMentionForFile: tên hiển thị có thể bị pollo.ai tự gắn nhãn SAI theo
 * "Character Library" của họ, không phải luôn theo tên file đã upload).
 */
async function uploadReferenceVideoImage(page: Page, imagePath: string): Promise<string> {
  const openDialog = () => ensureUploadDialogOpen(page, uploadCardButtonForImage(page).first());
  await openDialog();
  return submitAssetUpload(page, imagePath, openDialog);
}

/**
 * Chèn "@<ảnh>" vào cuối prompt (con trỏ đang ở cuối, sau khi đã gõ xong nội
 * dung chính — xem chú thích đầu file) — gõ ký tự "@" trực tiếp bằng bàn
 * phím để mở picker (xác nhận qua debug thật: mở được y hệt picker dù editor
 * đã có chữ sẵn, KHÔNG cần dùng nút "@" chuyên dụng trong placeholder — nút
 * đó chỉ hiện khi editor RỖNG, không áp dụng được ở đây vì luôn gõ mention
 * SAU khi đã có prompt text).
 *
 * Xác nhận qua debug thật (job inspect-pollo-mention-typed): picker có thể
 * MẶC ĐỊNH mở ở tab KHÁC "All" (vd "Characters", rỗng — "No assets yet") tuỳ
 * trạng thái nhớ lần trước, khiến item vừa upload (chỉ render khi tab "All"
 * đang mở, các tab lọc theo loại không có nó) không tìm thấy được. Chủ động
 * bấm tab "All" (data-testid="asset-tab-all") trước, best-effort.
 *
 * Nhận assetUrl (data-asset-url trả về từ submitAssetUpload) thay vì tên
 * file — khớp item qua mentionPickerItemByUrlLocator, KHÔNG qua tên hiển
 * thị. Xác nhận qua lỗi thật (job cay_khe_rm_end_SHOT_01_CLIP_02_VIDEO):
 * ảnh CHAR_OLDER_BROTHER.png upload xong nhưng picker hiện tên
 * "CHAR_YOUNGER_BROTHER (2)" — pollo.ai tự gắn nhãn theo hệ thống "Character
 * Library" riêng của họ, KHÔNG đáng tin theo tên file đã upload. Vẫn giữ
 * retry (đóng/mở lại "@") phòng trường hợp ảnh cần thêm chút thời gian index
 * xong mới xuất hiện trong picker.
 *
 * SỬA (xác nhận qua lỗi thật, job test_master_donghua_SHOT_01_CLIP_01_VIDEO):
 * item.click() báo "element is not stable" rồi "element was detached from
 * the DOM, retrying" — danh sách picker bị re-render giữa lúc click (có thể
 * do 1 upload MỚI khác vừa chèn vào đầu danh sách, kể cả từ 1 job Pollo khác
 * đang chạy song song trên CÙNG tài khoản — xem chú thích đầu file). click()
 * lúc đó THROW, nhưng trước đây lời gọi này KHÔNG nằm trong try/catch nên lỗi
 * thoát thẳng ra ngoài NGAY LẦN ĐẦU, bỏ qua toàn bộ cơ chế retry (đóng/mở lại
 * "@") bên dưới vốn chỉ áp dụng cho trường hợp "không tìm thấy item" — dù
 * item ĐÃ tìm thấy (found=true), chỉ là click bị trượt do DOM đang động. Bọc
 * try/catch quanh click() để lỗi click cũng rơi vào đúng cơ chế retry đó thay
 * vì bỏ cuộc ngay từ lần thử đầu tiên.
 */
async function insertMentionForFile(page: Page, assetUrl: string): Promise<void> {
  const item = mentionPickerItemByUrlLocator(page, assetUrl).first();
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.keyboard.type(" @", { delay: 50 });
    await page.waitForTimeout(500);

    await page
      .locator('[data-testid="asset-tab-all"]')
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});

    const found = await item
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (found) {
      try {
        await item.click({ timeout: 5_000 });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    if (attempt === maxAttempts) break;

    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(3000);
  }

  const detail = lastError instanceof Error ? ` (lần cuối lỗi click: ${lastError.message})` : "";
  throw new GenerationError(
    `Không chọn được ảnh vừa upload (${assetUrl}) trong picker "@ mention" sau ${maxAttempts} lần thử${detail} (ảnh có thể chưa kịp index xong, hoặc danh sách liên tục bị re-render do job khác đang upload cùng lúc).`,
  );
}

/**
 * Xác nhận trang ĐÃ render composer thật (không chỉ trang marketing/SEO) —
 * xác nhận qua lỗi thật LẶP LẠI NHIỀU LẦN (test_donghua_SHOT_01/02,
 * test_tutien_SHOT_01/19): goto xong trang chỉ hiện full-page nội dung
 * marketing ("Maintain Perfect Subject Consistency Across Frames", FAQ,
 * pricing...) dù đã đăng nhập THẬT (data-user-status="valid" trên <html>,
 * KHÔNG phải lỗi session — signInIndicatorCandidates không bắt được trường
 * hợp này). Mọi thao tác sau đó (upload, mention, focus editor...) đều thất
 * bại với thông báo khó hiểu (vd "Upload timeout" dù không liên quan gì tới
 * upload thật). Nguyên nhân gốc (xác nhận qua script test-pollo-live-network,
 * chạy thật qua proxy trong .env): PHẦN LỚN file JS (_next/static/chunks/*.js
 * — mã nguồn thật của app) lỗi net::ERR_TUNNEL_CONNECTION_FAILED do proxy
 * chập chờn, khiến trang chỉ render được HTML tĩnh phía server (SSR shell),
 * KHÔNG hydrate được thành composer thật.
 *
 * SỬA (xác nhận qua lỗi thật, job test-gen-fc50dac0 — locator.focus() timeout
 * 30s ngay cả SAU KHI waitForComposerReady báo true): bản đầu chỉ kiểm tra
 * `[data-testid="prompt-editor"]` (khung bọc ngoài) hoặc
 * `[data-testid="prompt-generate-btn"]` ĐÃ ATTACHED — nhưng khung bọc ngoài
 * này lại ĐƯỢC SERVER RENDER SẴN (SSR, xác nhận qua HTML debug thật:
 * data-testid="prompt-editor" tồn tại NGAY CẢ KHI trang chưa hydrate xong),
 * nên "attached" KHÔNG chứng minh được đã hydrate — false positive, báo sẵn
 * sàng trong khi thực ra composer vẫn chỉ là shell tĩnh. Phần tử
 * `contenteditable="true"` bên trong CHỈ được ProseMirror (JS) thêm vào SAU
 * khi hydrate xong — đây mới là tín hiệu đáng tin, và cũng chính là phần tử
 * mà mọi nơi gọi promptEditorLocator() thực sự cần dùng ngay sau đó.
 */
export async function waitForComposerReady(page: Page, timeoutMs: number): Promise<boolean> {
  return await page
    .locator('[data-testid="prompt-editor"] [contenteditable="true"]')
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/**
 * Gọi SAU KHI đã goto() xong — chờ composer sẵn sàng (xem
 * waitForComposerReady), RELOAD TỐI ĐA maxReloads lần nếu chưa thấy, rồi
 * throw GenerationError rõ ràng nếu vẫn không được. An toàn để reload ở ĐÂY
 * (khác hẳn lúc đang chờ kết quả generate — xem findRecentVideoViaCreatePage):
 * thời điểm này CHƯA bấm Generate, chưa có gì đang chạy dở để mất.
 *
 * maxReloads=2 (không phải 1) — xác nhận qua lỗi thật (job test-gen-d5cf5eb1):
 * gốc rễ là PROXY chập chờn (xem docstring waitForComposerReady), mức lỗi có
 * thể dao động rất mạnh theo từng thời điểm (có lúc 60+ request tĩnh cùng lỗi
 * tunnel, có lúc load sạch hoàn toàn ngay lần đầu) — 1 lần reload không phải
 * lúc nào cũng đủ để "trúng" đúng lúc proxy ổn định trở lại, thêm 1 lần nữa
 * tăng cơ hội mà chi phí thời gian không đáng kể so với việc bỏ cuộc cả job.
 */
export async function ensureComposerReadyOrThrow(
  page: Page,
  url: string,
  featureLabel: string,
  maxReloads = 2,
): Promise<void> {
  let composerReady = await waitForComposerReady(page, 15_000);
  for (let reloadAttempt = 1; !composerReady && reloadAttempt <= maxReloads; reloadAttempt++) {
    console.warn(
      `[pollo] Composer chưa render sau khi vào ${url} (proxy có thể đang chập chờn) — thử reload lại (lần ${reloadAttempt}/${maxReloads}).`,
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 0 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);
    composerReady = await waitForComposerReady(page, 20_000);
  }
  if (!composerReady) {
    throw new GenerationError(
      `pollo.ai không hiển thị giao diện ${featureLabel} (${url}) — trang chưa hydrate xong dù đã reload lại ${maxReloads} lần. Có thể proxy đang chập chờn nặng hoặc site đổi cấu trúc trang.`,
    );
  }
}

/**
 * Tự bật switch "Unlimited" khi credit hiện tại KHÔNG đủ trả phí lượt tạo
 * này — theo yêu cầu người dùng. Xác nhận qua DOM thật (script khảo sát
 * 1 lần, không lưu lại trong repo):
 * - Switch nằm trong `div[data-button-name="is_unlimited"]` (kèm
 *   `data-unlimited-model="<tên model>"` — CHỈ render khi model đang chọn có
 *   hỗ trợ Unlimited, best-effort bỏ qua nếu không thấy chứ không throw).
 *   Tooltip khi hover xác nhận đúng nghĩa: "Turn it on for unlimited free
 *   generations (363/365 days). Turn it off for faster speeds." — bật lên
 *   thì generate dùng quota Unlimited riêng (KHÔNG trừ credit).
 * - Credit hiện tại đọc qua `span.i-cus--pol-credits-2` (icon coin cạnh số
 *   dư, header).
 * - Phí lượt tạo hiện tại đọc qua `[data-slot="credit-cost-value"]` (hiện
 *   cạnh nút Generate, đổi theo model/setting đang chọn — PHẢI đọc SAU khi
 *   đã chọn xong model/duration/mention, ngay trước lúc bấm Generate).
 */
export async function enableUnlimitedIfNotEnoughCredit(page: Page, jobId: string): Promise<void> {
  const switchLocator = page
    .locator('div[data-button-name="is_unlimited"] [role="switch"]')
    .first();
  const switchExists = (await switchLocator.count().catch(() => 0)) > 0;
  if (!switchExists) return;

  const alreadyOn =
    (await switchLocator.getAttribute("aria-checked").catch(() => null)) === "true";
  if (alreadyOn) return;

  const creditText = await page
    .locator("span.i-cus--pol-credits-2")
    .locator("xpath=..")
    .first()
    .innerText()
    .catch(() => "");
  const feeText = await page
    .locator('[data-slot="credit-cost-value"] .font-semibold')
    .first()
    .innerText()
    .catch(() => "");
  const credit = Number.parseInt(creditText, 10);
  const fee = Number.parseInt(feeText, 10);

  if (!Number.isFinite(credit) || !Number.isFinite(fee)) {
    console.warn(
      `[pollo] Không đọc được credit/phí lượt tạo (credit="${creditText}", phí="${feeText}") — bỏ qua bật Unlimited.`,
    );
    return;
  }
  if (credit >= fee) return;

  console.warn(
    `[pollo] Credit hiện tại (${credit}) không đủ trả phí lượt tạo (${fee}) — tự bật "Unlimited".`,
  );
  // Banner cookie-consent (#cc-main) có thể vẫn còn che switch tại thời điểm
  // này (nó chỉ bị dismiss 1 lần lúc mới vào trang) và chặn click thật —
  // xác nhận qua log thật ("<div class=\"cm-wrapper cc--anim\">… intercepts
  // pointer events"), khiến switch KHÔNG bật được, generate dùng hết credit
  // thật và job sau đó fail hẳn vì "không đủ credit" thay vì chỉ bỏ qua như
  // comment best-effort ở dưới kỳ vọng. Dismiss trước khi click, và thử lại
  // 1 lần sau khi dismiss nếu lần đầu vẫn bị chặn.
  await dismissBlockingOverlays(page);
  await switchLocator.click({ timeout: 5000 }).catch(async () => {
    await dismissBlockingOverlays(page);
    await switchLocator.click({ timeout: 5000 }).catch(async (err) => {
      console.warn("[pollo] Bật switch Unlimited lỗi (bỏ qua, generate vẫn tiếp tục dùng credit như bình thường):", err);
      await captureSnapshot(page, jobId + "_unlimited-switch-failed", "unlimited-switch-failed");
    });
  });
}

/**
 * Bấm vào 1 thumbnail kết quả (xem resultItemLocator) để lấy id nội bộ
 * pollo.ai của đúng output đó — xác nhận qua DOM thật (script inspect-pollo-
 * video-id*, không lưu lại trong repo): id KHÔNG có sẵn trong DOM dưới dạng
 * href/data-* nào, CHỈ lộ ra qua URL SAU KHI click thật (điều hướng phía
 * client sang dạng "https://pollo.ai/v/<id>" — khớp định dạng
 * "videoId=<id>" trong URL mà người dùng cung cấp, vd
 * https://pollo.ai/create?target=text-to-image&videoId=cmtprxlrq40fjla09jl34o9pv).
 *
 * Theo yêu cầu người dùng: ID này được LƯU VÀO ĐÚNG ENTRY trong file JSON
 * storyboard gốc (storage/generated/<FILE_JSON>/<FILE_JSON>.json), KHÔNG
 * phải 1 file riêng — caller (storyboardPipeline.ts, nơi đã đọc/ghi entries
 * qua saveEntries) tự gán vào field entry.polloResultId rồi lưu, nên hàm này
 * CHỈ trả về id (hoặc null), không tự ghi file gì cả.
 *
 * Best-effort: KHÔNG throw nếu không lấy được (đây là dữ liệu bổ sung, không
 * nên làm rớt cả job generate nếu chỉ bước lấy id thất bại). Tự quay lại
 * (goBack) trang trước đó sau khi lấy xong, phòng khi code gọi sau còn cần
 * dùng lại đúng trang composer (dù hiện tại luôn gọi hàm này SAU CÙNG, ngay
 * trước khi đóng page).
 */
export async function captureResultId(page: Page, card: Locator): Promise<string | null> {
  const item = resultItemLocator(card).first();
  const urlBefore = page.url();
  const clicked = await item
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) {
    console.warn("[pollo] Không bấm được vào thumbnail kết quả để lấy id (bỏ qua).");
    return null;
  }

  await page.waitForTimeout(1000);
  const match = page.url().match(/\/v\/([a-z0-9]+)/i);

  if (page.url() !== urlBefore) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
  }
  if (!match) {
    console.warn(`[pollo] Không đọc được id kết quả từ URL sau khi click (URL: ${page.url()}).`);
    return null;
  }
  return match[1];
}

interface ResultBaseline {
  count: number;
}

async function captureResultBaseline(page: Page): Promise<ResultBaseline> {
  return { count: await resultCardLocator(page).count() };
}

/** URL asset pollo.ai luôn có dạng ".../<13 số epoch ms>-<uuid>.<ext>" — dùng để xếp thời gian tạo, xem findRecentVideoViaCreatePage. */
function extractAssetTimestampMs(url: string): number | null {
  const m = url.match(/\/(\d{13})-/);
  return m ? Number(m[1]) : null;
}

/**
 * Quét /create (mở TRANG RIÊNG, không đụng tới page đang chờ) tìm video có
 * timestamp (trong URL) MỚI NHẤT nhưng vẫn >= sinceMs — tức video được tạo
 * SAU lúc bấm Generate của job này. Xác nhận qua lỗi thật (2 job recover
 * thủ công: cay_khe_rm_end_SHOT_01_CLIP_01_VIDEO/CLIP_02): cả 2 lần trang
 * composer đang mở KHÔNG BAO GIỜ tự thấy video mới dù server đã render xong
 * từ lâu, nhưng /create luôn thấy đúng và tải được ngay. RELOAD LẠI trang
 * composer (đã thử) làm MẤT HẲN card đang generate (xác nhận qua phản hồi
 * thật của user) — vì trang deep-link reference-to-video?... là trang KHỞI
 * TẠO generation mới, không phải trang lịch sử, reload nó = như mở lại từ
 * đầu. Vì vậy phải dùng /create (đúng trang lịch sử) qua 1 page RIÊNG, để
 * nguyên page composer không đụng vào.
 */
async function findRecentVideoViaCreatePage(
  page: Page,
  sinceMs: number,
): Promise<string | null> {
  const checkPage = await page.context().newPage();
  try {
    await checkPage.goto(new URL("/create", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await checkPage.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await checkPage.waitForTimeout(1500);
    await dismissBlockingOverlays(checkPage);

    const videos = resultVideoLocator(checkPage);
    const count = await videos.count();
    let best: { src: string; ts: number } | null = null;
    for (let i = 0; i < count; i++) {
      const src = await videos.nth(i).getAttribute("src").catch(() => null);
      if (!src) continue;
      const ts = extractAssetTimestampMs(src);
      if (ts === null || ts < sinceMs - 60_000) continue;
      if (!best || ts < best.ts) best = { src, ts };
    }
    return best?.src ?? null;
  } finally {
    await checkPage.close();
  }
}

/**
 * Cùng cơ chế với waitForNewResult trong polloImage.ts — xem docstring ở đó.
 *
 * generateClickedAtMs = thời điểm bấm Generate — dùng để lọc video "của job
 * này" khi quét /create (xem findRecentVideoViaCreatePage). Trả về src video
 * trực tiếp (string) thay vì Locator — có thể đến từ card trên chính page
 * đang mở HOẶC từ /create, downloadResultVideo chỉ cần src để tải.
 *
 * SỬA (xác nhận qua lỗi thật, job DRAGON_Tranform_SHOT_06_CLIP_01_VIDEO): job
 * bị báo lỗi "Hết thời gian chờ" đúng lúc card kết quả VẪN đang hiện
 * "generating" (còn `[data-slot="task-card-generating"]`) — tức pollo.ai vẫn
 * đang xử lý bình thường, không hề treo/lỗi, chỉ là generationTimeoutMs (cấu
 * hình .env, 20 phút) ngắn hơn thời gian model thực tế cần để xong. timeoutMs
 * giờ CHỈ áp dụng cho giai đoạn TRƯỚC KHI thấy card generate nào xuất hiện
 * (bắt lỗi "bấm Generate không có phản hồi gì" — vd hết credit không tạo card
 * mới, đã có outOfCredit check riêng bên dưới, hoặc 1 lỗi khác chưa biết). Một
 * khi ĐÃ thấy card đang generate ít nhất 1 lần, coi như job đang chạy thật —
 * không còn giới hạn thời gian nữa, cứ poll tới khi thực sự xong (hoặc lỗi rõ
 * ràng khác như outOfCredit) — giống tinh thần "timeout: 0" đã áp dụng cho
 * page.goto.
 */
interface VideoResult {
  src: string;
  /** Card trên chính page đang mở — null nếu kết quả chỉ tìm thấy qua /create (xem findRecentVideoViaCreatePage), lúc đó không có card nào trên page hiện tại để lấy id (xem captureResultId). */
  card: Locator | null;
}

async function waitForNewResult(
  page: Page,
  baseline: ResultBaseline,
  timeoutMs: number,
  generateClickedAtMs: number,
): Promise<VideoResult> {
  const cards = resultCardLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;
  const createCheckEveryMs = 45_000;
  let lastCreateCheckAt = 0;
  let sawGeneratingCard = false;

  while (true) {
    const count = await cards.count();
    if (count > baseline.count) {
      const newCard = cards.last();
      const stillGenerating =
        (await newCard.locator('[data-slot="task-card-generating"]').count()) > 0;
      if (stillGenerating) {
        sawGeneratingCard = true;
      } else {
        const videoCount = await resultVideoLocator(newCard).count();
        if (videoCount > 0) {
          const src = await resultVideoLocator(newCard).first().getAttribute("src");
          if (src) return { src, card: newCard };
        }
        // Cùng cơ chế card kết quả với polloImage.ts (xem docstring
        // waitForNewResult ở đó) — pollo.ai có thể từ chối vì nội dung bị
        // model bên thứ 3 gắn cờ ("Input flagged by the third-party model...")
        // ngay cả ở mode video, dù chưa trực tiếp gặp job video nào bị vậy
        // (chỉ mới xác nhận ở ảnh). Ném message chứa nguyên văn để khớp
        // CONTENT_VIOLATION_PATTERN, kích hoạt retry qua ChatAI thay vì bỏ
        // cuộc ngay.
        const cardText = await newCard.innerText().catch(() => "");
        if (/flagged by the third-party model/i.test(cardText)) {
          throw new GenerationError(
            `pollo.ai từ chối tạo video: ${cardText.split("\n")[0].trim()}`,
          );
        }
        throw new GenerationError(
          "pollo.ai báo card kết quả đã xong nhưng không thấy video nào (có thể đã lỗi — cần bổ sung phát hiện cụ thể khi có bằng chứng thật)",
        );
      }
    }

    // Fallback cho mode "Reference to Video" (deep-link, xem buildDeepLinkUrl)
    // — xác nhận qua debug snapshot THẬT của đúng job bị timeout này
    // (test_normal_3_SHOT_01_CLIP_01_VIDEO): video đã tạo XONG HẲN, hiện
    // ngay trên page composer (poster + controls + src CDN thật với
    // timestamp mới), NHƯNG [data-widget-name="project_content_card"]
    // KHÔNG HỀ tồn tại trong DOM ở mode này (0 match) — giao diện "chat_box"
    // của Reference to Video hiển thị kết quả trực tiếp qua thẻ
    // video.vjs-tech (resultVideoLocator), không bọc trong project_content_
    // card như /image hay /video thường — nên nhánh card phía trên KHÔNG
    // BAO GIỜ kích hoạt được ở mode này, và job vẫn treo tới hết timeoutMs dù
    // đã xong từ lâu. /create fallback (bên dưới) cũng không cứu được lần
    // này (có thể do "Reference to Video" thuộc project riêng, không lên
    // feed /create chung). Kiểm tra thẳng resultVideoLocator(page) mỗi vòng
    // lặp — chỉ nhận nếu timestamp nhúng trong URL (extractAssetTimestampMs)
    // MỚI HƠN lúc bấm Generate, tránh nhận nhầm video CŨ còn sót lại từ job
    // trước trong cùng phiên chat.
    const pageVideoSrc = await resultVideoLocator(page)
      .first()
      .getAttribute("src")
      .catch(() => null);
    if (pageVideoSrc) {
      const ts = extractAssetTimestampMs(pageVideoSrc);
      if (ts !== null && ts >= generateClickedAtMs - 60_000) {
        return { src: pageVideoSrc, card: null };
      }
    }

    // Xác nhận qua lỗi thật (xem docstring creditPaywallLocator trong
    // polloSelectors.ts): bấm Generate khi không đủ credit KHÔNG tạo card mới
    // nào cả — nếu không phát hiện riêng, vòng lặp trên sẽ treo mãi mà không
    // báo lỗi gì (nay không còn timeoutMs cứu, nên check này càng quan trọng).
    const outOfCredit = await creditPaywallLocator(page)
      .first()
      .isVisible()
      .catch(() => false);
    if (outOfCredit) {
      throw new GenerationError(
        "Tài khoản pollo.ai không đủ credit để tạo video với model/cấu hình hiện tại — cần nạp thêm credit hoặc đổi model rẻ hơn.",
      );
    }

    if (Date.now() - lastCreateCheckAt >= createCheckEveryMs) {
      lastCreateCheckAt = Date.now();
      const foundSrc = await findRecentVideoViaCreatePage(page, generateClickedAtMs).catch(
        () => null,
      );
      if (foundSrc) return { src: foundSrc, card: null };
    }

    if (!sawGeneratingCard && Date.now() - start >= timeoutMs) {
      throw new GenerationError(
        `Hết thời gian chờ tạo video (timeout ${timeoutMs}ms) — chưa từng thấy card generate nào xuất hiện.`,
      );
    }

    await page.waitForTimeout(pollIntervalMs);
  }
}

/**
 * Tải video từ src đã biết (từ card trên page composer, hoặc từ /create) —
 * CHỈ lấy bản CÓ watermark (xem chú thích đầu file) vì tài khoản test hiện
 * tại không có quyền tải bản sạch. Trả về path file tạm — caller
 * (storyboardPipeline.ts sau này) tự đổi tên theo id giống generateVideosForFile
 * của AIVideo.
 */
async function downloadResultVideo(page: Page, src: string, jobId: string): Promise<string> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });

  const response = await fetchWithRetry(page, src);
  const ext = resolveDownloadExtension(response, src, ".mp4");
  const filePath = path.join(config.downloadDir, `${jobId}${ext}`);
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}

/** Kết quả generate video pollo.ai — polloResultId (id nội bộ pollo.ai, dạng "/v/<id>") null nếu không lấy được (xem captureResultId), caller (storyboardPipeline.ts) tự quyết định lưu vào đâu. */
export interface PolloGenerateVideoResult {
  filePath: string;
  polloResultId: string | null;
}

export async function generateVideo(
  prompt: string,
  { startFramePath, endFramePath, referenceImagePaths = [], model, duration }: PolloGenerateVideoOptions,
  jobId: string,
): Promise<PolloGenerateVideoResult> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  try {
    // Ưu tiên deep-link (né bug click popup model — xem docstring
    // buildDeepLinkUrl) khi mode/model nằm trong map đã xác nhận; không thì
    // vào /video mặc định rồi bấm popup như cũ.
    let deepLink: DeepLink | null = null;
    if (!startFramePath && referenceImagePaths.length > 0) {
      deepLink = buildDeepLinkUrl("Reference to Video", model);
    }
    const url = deepLink?.url ?? new URL("/video", config.polloBaseUrl).toString();
    // timeout: 0 = tắt hẳn giới hạn thời gian — xác nhận qua lỗi thật (job
    // microdrama_co_dau_phan_boi_twist_prompt_SHOT_05_CLIP_01_VIDEO): mạng
    // VPS/site pollo.ai chậm thoáng qua khiến goto vượt quá 60s dù không có
    // gì sai, làm rớt cả job dù chỉ là chậm tạm thời. Cùng lý do đã áp dụng
    // cho fetchWithRetry (tải file lớn qua mạng chậm không nên bị huỷ giữa
    // chừng chỉ vì quá 1 mốc thời gian cố định).
    await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    await ensureComposerReadyOrThrow(page, url, "tạo video");

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new GenerationError(
        "Chưa đăng nhập pollo.ai hoặc session đã hết hạn. Chạy: npm run login-pollo",
      );
    }

    if (startFramePath) {
      await switchModeIfNeeded(page, "Frames to Video");
      await uploadFrameImage(page, "Start", startFramePath);
      if (endFramePath) {
        await uploadFrameImage(page, "End", endFramePath);
      }
    } else if (referenceImagePaths.length > 0 && !deepLink) {
      await switchModeIfNeeded(page, "Reference to Video");
    }

    if (model && !deepLink?.includesModel) {
      await dismissBlockingOverlays(page);
      await selectModel(page, model);
    }

    if (duration) {
      await dismissBlockingOverlays(page);
      await selectDurationIfNeeded(page, duration);
    }

    const editor = promptEditorLocator(page).first();
    await editor.focus();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(300);

    // Reference to Video BẮT BUỘC "@ mention" từng ảnh vào prompt thì model
    // mới thực sự dùng ảnh đó — xem chú thích đầu file/insertMentionForFile.
    // Upload rồi mention NGAY từng ảnh 1 (KHÔNG upload hết cả loạt rồi mới
    // mention hết cả loạt như trước) — xác nhận qua lỗi thật (job
    // cay_khe_rm_end_SHOT_01_CLIP_02_VIDEO): ảnh CHAR_OLDER_BROTHER upload
    // thành công nhưng biến mất khỏi picker "@ mention" trước khi kịp tới
    // lượt mention nó. Picker chỉ hiện ĐÚNG vài upload GẦN NHẤT của CẢ tài
    // khoản (không phải riêng job này — job Pollo khác, vd hàng đợi ảnh, chạy
    // song song trên CÙNG tài khoản cũng tính), nên khoảng hở giữa lúc upload
    // xong và lúc mention càng dài càng dễ bị đẩy khỏi danh sách. Mention
    // ngay sau khi upload xong để giảm tối đa khoảng hở đó.
    //
    // SỬA (xác nhận qua lỗi thật, job
    // test_normal_7_rep_SHOT_01_CLIP_01_VIDEO, 2026-09-07): "mention ngay sau
    // upload" chỉ GIẢM khoảng hở chứ không loại bỏ được — vẫn đủ thời gian để
    // 1 job Pollo khác (hàng đợi ảnh) chen 1-2 upload của riêng nó vào giữa,
    // đẩy ảnh job này khỏi picker trước khi insertMentionForFile kịp tìm thấy
    // (hết cả 4 lần retry). Bọc CẢ upload lẫn mention trong 1 lần giữ
    // withPolloAssetUploadLock (xem docstring hàm đó, khai báo cùng
    // submitAssetUpload) — đảm bảo không job nào khác chen upload vào khoảng
    // hở này nữa, loại bỏ hẳn race thay vì chỉ rút ngắn nó.
    if (!startFramePath && referenceImagePaths.length > 0) {
      for (const refPath of referenceImagePaths) {
        await withPolloAssetUploadLock(async () => {
          // dismissBlockingOverlays ở đầu hàm (dòng ~687) chỉ chạy 1 LẦN lúc
          // mới vào trang — xác nhận qua lỗi thật (job
          // microdrama_co_dau_phan_boi_twist_prompt_SHOT_01_CLIP_01_VIDEO): 1
          // popup coco-modal-wrap MỚI xuất hiện SAU đó (lúc đã chọn model/gõ
          // prompt xong), chặn click nút "Upload Media" mà không có gì dismiss
          // lại. Gọi lại NGAY TRƯỚC mỗi lần upload — rẻ, best-effort, không
          // lỗi nếu không có gì để đóng.
          await dismissBlockingOverlays(page);
          const assetUrl = await uploadReferenceVideoImage(page, refPath);
          await editor.focus();
          await insertMentionForFile(page, assetUrl);
        });
      }
    }

    await enableUnlimitedIfNotEnoughCredit(page, jobId);

    const baseline = await captureResultBaseline(page);

    const generateButton = generateButtonLocator(page).first();
    await waitForGenerateButtonEnabled(page, generateButton);
    const recordId = await captureGenerationRecordId(page, () =>
      clickGenerateButton(page, generateButton, baseline.count),
    );
    const generateClickedAtMs = Date.now();

    // Check trạng thái qua API song song với dò DOM — xem docstring
    // waitForGenerationApiStatus. recordId null (bắt response thất bại) thì
    // bỏ qua hẳn, dùng lại đúng cơ chế dò DOM cũ.
    const apiStatus =
      recordId !== null
        ? await waitForGenerationApiStatus(page, recordId, config.generationTimeoutMs, jobId)
        : null;
    if (recordId !== null) {
      console.log(`[pollo] API record ${recordId} status: ${apiStatus ?? "(hết thời gian chờ, không rõ)"}`);
    }

    let videoSrc: string;
    let resultCard: Locator | null;
    try {
      ({ src: videoSrc, card: resultCard } = await waitForNewResult(
        page,
        baseline,
        config.generationTimeoutMs,
        generateClickedAtMs,
      ));
    } catch (err) {
      // DOM không thấy video mới dù API đã xác nhận "succeed" — đúng dạng
      // bug đã gặp thật ở mode Reference to Video/chat_box (xem docstring
      // waitForNewResult phía trên): tải trực tiếp qua mediaUrl của API.
      if (apiStatus === "succeed" && recordId !== null) {
        const detail = await fetchGenerationRecordDetail(page, recordId);
        if (detail?.mediaUrl) {
          console.warn(
            `[pollo] DOM không thấy video mới dù API xác nhận record ${recordId} đã "succeed" — tải trực tiếp qua mediaUrl.`,
          );
          const filePath = await downloadResultVideo(page, detail.mediaUrl, jobId);
          return { filePath, polloResultId: detail.videoId };
        }
      }
      throw err;
    }
    const filePath = await downloadResultVideo(page, videoSrc, jobId);
    // resultCard null = kết quả chỉ tìm thấy qua /create (xem
    // findRecentVideoViaCreatePage) HOẶC qua nhánh video-src trực tiếp trên
    // page (mode "Reference to Video"/chat_box — xem waitForNewResult phía
    // trên), không có card nào để lấy id qua click thumbnail. Xác nhận qua
    // NHIỀU lần test thật liền nhau (mọi lần generateVideo mode Reference to
    // Video đều trả polloResultId=null dù job thành công): mode này KHÔNG
    // BAO GIỜ có card, nên nhánh captureResultId gần như vô dụng cho video —
    // dùng recordId (đã có sẵn từ captureGenerationRecordId) qua
    // fetchGenerationRecordDetail làm nguồn videoId đáng tin cậy hơn hẳn,
    // best-effort, không throw nếu thất bại.
    let polloResultId = resultCard ? await captureResultId(page, resultCard) : null;
    if (!polloResultId && recordId !== null) {
      const detail = await fetchGenerationRecordDetail(page, recordId);
      polloResultId = detail?.videoId ?? null;
    }
    return { filePath, polloResultId };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError
      ? err
      : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
