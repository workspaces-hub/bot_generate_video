import fs from "node:fs";
import path from "node:path";
import type { APIResponse, Locator, Page } from "playwright";
import { config } from "../config";
import { getPolloBrowserContext } from "./polloBrowser";
import {
  GenerationError,
  captureErrorSnapshot,
  fetchWithRetry,
} from "./aiVideo";
import { firstVisible } from "./selectors";
import {
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
  resultVideoLocator,
  signInIndicatorCandidates,
  uploadCardButtonByLabel,
  uploadCardButtonForImage,
  uploadDialogFileInputLocator,
  uploadDialogSelectButtonLocator,
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
  const closeButton = page.locator('button[aria-label="Close"]').first();
  if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeButton.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  const maybeLaterButton = page.locator('button[data-button-name="next_time"]').first();
  if (await maybeLaterButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await maybeLaterButton.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await page.keyboard.press("Escape").catch(() => {});
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
 * Nộp file vào input ẩn của dialog Uploads rồi chờ card MỚI (thumbnail thật,
 * mang data-testid="asset-picker-card") xuất hiện — xác nhận qua lỗi thật
 * (job cay_khe_rm_end_SHOT_01_CLIP_01_VIDEO, xem storage/debug): card
 * placeholder "Uploading" (spinner, chưa có data-asset-url) KHÔNG mang
 * testid này nên không tính vào count, đảm bảo chỉ coi là xong khi thumbnail
 * thật đã render. Ảnh chụp lỗi cho thấy upload có thể bị KẸT hẳn ở trạng thái
 * "Uploading" quá 30s (nghẽn tạm phía site, không rõ nguyên nhân cụ thể) — nộp
 * lại ĐÚNG 1 LẦN (setInputFiles lại chính input đó, dialog vẫn đang mở nên
 * không cần bấm lại nút mở) trước khi ném lỗi hẳn.
 */
/** Đọc data-asset-url của mọi card hiện có — dùng để tìm card MỚI bằng cách so sánh trước/sau, không đoán vị trí (xem chú thích submitAssetUpload bên dưới). */
async function assetPickerUrls(cards: Locator): Promise<string[]> {
  return cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-asset-url") ?? ""));
}

/**
 * Chờ số card trong lưới Uploads ỔN ĐỊNH (không đổi giữa 2 lần đọc liên
 * tiếp) trước khi lấy làm baseline — xác nhận qua debug thật (job
 * debug-pollo-upload-stuck): dialog Uploads render TOÀN BỘ lịch sử upload
 * của tài khoản (không phải chỉ vài item), tài khoản dùng nhiều lần trong
 * session này đã có 65+ item, số card tăng dần 0 → 45 → 65 trong ~15-25s
 * trước khi ổn định. Bấm "Upload Media" xong gọi ngay countBefore lúc lưới
 * CHƯA load xong sẽ ra baseline SAI (thấp hơn thực tế) — sau đó so sánh
 * data-asset-url trước/sau (xem submitAssetUpload) có thể nhầm 1 ảnh CŨ vừa
 * kịp render là ảnh MỚI vừa upload. Cần ổn định trước khi chụp baseline.
 */
async function waitForStableCardCount(
  cards: Locator,
  maxWaitMs = 15_000,
  intervalMs = 1000,
): Promise<void> {
  const page = cards.page();
  const start = Date.now();
  let previous = await cards.count();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(intervalMs);
    const current = await cards.count();
    if (current === previous) return;
    previous = current;
  }
}

export async function submitAssetUpload(page: Page, imagePath: string): Promise<string> {
  const cards = assetPickerCardLocator(page);
  await waitForStableCardCount(cards);
  const urlsBefore = await assetPickerUrls(cards);
  const countBefore = urlsBefore.length;
  const fileInput = uploadDialogFileInputLocator(page);
  // Thư viện upload của tài khoản CÀNG NGÀY CÀNG LỚN (xem docstring
  // waitForStableCardCount) khiến lưới cần thêm thời gian render/ổn định
  // mỗi lần mở — tăng timeout từ 30s lên 45s để có thêm dư địa, tránh báo
  // lỗi timeout giả trong khi ảnh vẫn đang xử lý bình thường.
  const waitForNewCard = () =>
    page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-testid="asset-picker-card"]').length >= expected,
      countBefore + 1,
      { timeout: 45_000 },
    );

  await fileInput.setInputFiles(imagePath, { timeout: 10_000 });
  try {
    await waitForNewCard();
  } catch (err) {
    await fileInput.setInputFiles(imagePath, { timeout: 10_000 });
    await waitForNewCard();
  }

  // Card mới upload KHÔNG chắc chèn ở CUỐI lưới (bằng chứng thật — job
  // cay_khe_rm_end_SHOT_01_CLIP_01_VIDEO: placeholder "Uploading" render ngay
  // SAU nút "Upload Media", tức ĐẦU lưới — trước đây code đoán nhầm .nth(count-1)
  // là card mới, thực ra chọn nhầm 1 ảnh cũ có sẵn trong thư viện, khiến bước
  // "@ mention" sau đó tìm không ra file vừa upload). So sánh data-asset-url
  // trước/sau để tìm ĐÚNG card mới xuất hiện, không đoán vị trí.
  const urlsBeforeSet = new Set(urlsBefore);
  const urlsAfter = await assetPickerUrls(cards);
  const newIndex = urlsAfter.findIndex((url) => url && !urlsBeforeSet.has(url));
  const targetIndex = newIndex >= 0 ? newIndex : urlsAfter.length - 1;

  await cards.nth(targetIndex).click({ timeout: 10_000 });
  await uploadDialogSelectButtonLocator(page).click({ timeout: 10_000 });
  return urlsAfter[targetIndex];
}

/** Cùng cơ chế "phải click thumbnail để chọn trước khi Select enable" đã xác nhận qua lỗi thật — xem docstring uploadReferenceImage trong polloImage.ts. */
async function uploadFrameImage(
  page: Page,
  label: "Start" | "End",
  imagePath: string,
): Promise<void> {
  await uploadCardButtonByLabel(page, label).first().click({ timeout: 10_000 });
  await submitAssetUpload(page, imagePath);
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
  await uploadCardButtonForImage(page).first().click({ timeout: 10_000 });
  return submitAssetUpload(page, imagePath);
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
 */
async function insertMentionForFile(page: Page, assetUrl: string): Promise<void> {
  const item = mentionPickerItemByUrlLocator(page, assetUrl).first();
  const maxAttempts = 4;

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
      await item.click({ timeout: 5_000 });
      return;
    }

    if (attempt === maxAttempts) break;

    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(3000);
  }

  throw new GenerationError(
    `Không tìm thấy ảnh vừa upload (${assetUrl}) trong picker "@ mention" sau ${maxAttempts} lần thử (ảnh có thể chưa kịp index xong phía pollo.ai).`,
  );
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
 */
async function waitForNewResult(
  page: Page,
  baseline: ResultBaseline,
  timeoutMs: number,
  generateClickedAtMs: number,
): Promise<string> {
  const cards = resultCardLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;
  const createCheckEveryMs = 45_000;
  let lastCreateCheckAt = 0;

  while (Date.now() - start < timeoutMs) {
    const count = await cards.count();
    if (count > baseline.count) {
      const newCard = cards.last();
      const stillGenerating =
        (await newCard.locator('[data-slot="task-card-generating"]').count()) > 0;
      if (!stillGenerating) {
        const videoCount = await resultVideoLocator(newCard).count();
        if (videoCount > 0) {
          const src = await resultVideoLocator(newCard).first().getAttribute("src");
          if (src) return src;
        }
        throw new GenerationError(
          "pollo.ai báo card kết quả đã xong nhưng không thấy video nào (có thể đã lỗi — cần bổ sung phát hiện cụ thể khi có bằng chứng thật)",
        );
      }
    }

    // Xác nhận qua lỗi thật (xem docstring creditPaywallLocator trong
    // polloSelectors.ts): bấm Generate khi không đủ credit KHÔNG tạo card mới
    // nào cả — nếu không phát hiện riêng, vòng lặp trên sẽ treo tới hết
    // timeoutMs (mặc định 3 tiếng) mà không báo lỗi gì.
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
      if (foundSrc) return foundSrc;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(`Hết thời gian chờ tạo video (timeout ${timeoutMs}ms)`);
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

export async function generateVideo(
  prompt: string,
  { startFramePath, endFramePath, referenceImagePaths = [], model, duration }: PolloGenerateVideoOptions,
  jobId: string,
): Promise<string> {
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

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
    if (!startFramePath && referenceImagePaths.length > 0) {
      for (const refPath of referenceImagePaths) {
        const assetUrl = await uploadReferenceVideoImage(page, refPath);
        await editor.focus();
        await insertMentionForFile(page, assetUrl);
      }
    }

    const baseline = await captureResultBaseline(page);

    const generateButton = generateButtonLocator(page).first();
    await generateButton.click({ timeout: 10_000 });
    const generateClickedAtMs = Date.now();

    const videoSrc = await waitForNewResult(
      page,
      baseline,
      config.generationTimeoutMs,
      generateClickedAtMs,
    );
    return await downloadResultVideo(page, videoSrc, jobId);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError
      ? err
      : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
