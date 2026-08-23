import fs from "node:fs";
import path from "node:path";
import type { FileChooser, Locator, Page } from "playwright";
import { config } from "../config";
import { getImageBrowserContext } from "./browser";
import {
  GenerationError,
  captureErrorSnapshot,
  captureSnapshot,
  clickDismissingModals,
  clickWithForceFallback,
  dismissBlockingOverlays,
  dismissPaywallIfBlocking,
  ensureLoggedIn,
  extractDownloadUrlWithoutWatermark,
  fetchWithRetry,
  getAvailableCredit,
  getFlightDataText,
  getGenerationFee,
  gotoWithRetry,
  selectChipOption,
} from "./aiVideo";
import {
  addReferenceImageButtonCandidates,
  confirmCharacterButtonCandidates,
  creditPaywallModalCandidates,
  entryImagesLocator,
  errorIndicatorCandidates,
  firstVisible,
  generateButtonCandidates,
  getEntryFeedId,
  getReferenceImageCount,
  historyImageEntryLocator,
  imageCountChipCandidates,
  imageModeTabCandidates,
  modelChipCandidates,
  promptInputCandidates,
  uploadedReferenceImageThumbnailLocator,
} from "./selectors";

export const MAX_REFERENCE_IMAGES = 16;

export interface GenerateImageOptions {
  model?: string;
  referenceImagePaths?: string[];
  /** Số ảnh tạo ra mỗi lần generate — mặc định 4 (đúng số ảnh site tự tạo nếu không chỉnh, xem selectImageCount). */
  imageCount?: 1 | 2 | 3 | 4;
}

/**
 * Chọn số lượng ảnh tạo ra mỗi lần generate (chip riêng trong toolbar khung
 * nhập prompt, nghi cùng khu vực với modelChipCandidates — xem
 * imageCountChipCandidates trong selectors.ts, CHƯA có DOM thật xác nhận).
 *
 * Đọc nhãn chip HIỆN TẠI trước — nếu đã đúng số count cần chọn thì bỏ qua
 * luôn (theo yêu cầu người dùng), không mở dropdown/chọn lại: vừa đỡ 1 thao
 * tác thừa, vừa tránh trường hợp bấm vào đúng chip đang mở lại VÔ TÌNH đóng
 * dropdown nếu site coi đây là nút toggle thay vì luôn mở.
 */
async function selectImageCount(
  page: Page,
  imageCount: 1 | 2 | 3 | 4,
): Promise<void> {
  console.log("🚀 ~ selectImageCount ~ imageCount:", imageCount);
  const chip = await firstVisible(imageCountChipCandidates(page), 3000).catch(
    () => null,
  );
  if (chip) {
    const currentLabel = await chip.innerText().catch(() => "");
    if (new RegExp(`^\\s*${imageCount}\\b`).test(currentLabel)) {
      return;
    }
  }
  await selectChipOption(
    page,
    imageCountChipCandidates(page),
    String(imageCount),
    "số lượng ảnh",
  );
}

/**
 * Tạo ảnh từ prompt + tối đa 16 ảnh tham chiếu (tuỳ chọn). Mỗi lần generate
 * trả về CẢ CỤM nhiều ảnh (mặc định 4 ảnh/lần, tuỳ chỉnh qua imageCount) —
 * trả về mảng path, không phải 1 file duy nhất như video.
 */
export async function generateImage(
  prompt: string,
  { model, referenceImagePaths = [], imageCount = 4 }: GenerateImageOptions,
  jobId: string,
): Promise<string[]> {
  if (referenceImagePaths.length > MAX_REFERENCE_IMAGES) {
    throw new GenerationError(
      `Chỉ hỗ trợ tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu.`,
    );
  }

  const context = await getImageBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(
      config.aiVideoCreateImagePath,
      config.aiVideoBaseUrl,
    ).toString();
    await gotoWithRetry(page, url);

    await ensureLoggedIn(page);
    await dismissPaywallIfBlocking(page);

    // Điều hướng thẳng tới config.aiVideoCreateImagePath (URL riêng cho tạo
    // ảnh) đã tự vào sẵn chế độ Image — thực tế xác nhận không còn tab
    // "Image" nào để bấm nữa. Vẫn thử bấm (best-effort, không chặn job)
    // phòng trường hợp site đổi lại UI dùng chung 1 trang có toggle.
    await firstVisible(imageModeTabCandidates(page), 3000)
      .then((imageTab) => clickDismissingModals(page, imageTab))
      .catch(() => {});
    await dismissBlockingOverlays(page);

    // Cùng lý do đã sửa cho video (xem chú thích generateVideo trong
    // aiVideo.ts): gotoWithRetry chỉ chờ domcontentloaded, SPA còn cần thêm
    // thời gian hydrate. PHẢI chờ TRƯỚC vòng lặp upload ảnh tham chiếu bên
    // dưới, KHÔNG chỉ trước ô nhập prompt như trước đây — xác nhận qua debug
    // thật (job Bread_Mice_SCENE_01_START): có ảnh tham chiếu vẫn gặp
    // "Không tìm thấy phần tử nào khớp" ngay ở bước tìm nút "Upload Image
    // Refs" đầu tiên (page bailout to client-side rendering, main content
    // còn trắng tinh) vì trước đây chỉ chờ mạng rảnh khi referenceImagePaths
    // rỗng — đặc biệt dễ gặp ngay sau khi browser vừa restart do crash
    // (cold start chậm hơn bình thường).
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});
    // const [fee, credit] = await Promise.all([
    //   getGenerationFee(page),
    //   getAvailableCredit(page),
    // ]);
    // if (fee !== null && credit !== null) {
    //   if (fee > credit) {
    //     model = "Image-1.0";
    //   }
    // }
    model = "GPT Image 2";
    // Cùng chip model dùng chung với trang tạo video (toolbar khung nhập
    // prompt) — xem chú thích selectChipOption trong aiVideo.ts. Đọc nhãn
    // chip HIỆN TẠI trước — nếu đã đúng model cần chọn thì bỏ qua luôn,
    // KHÔNG gọi selectChipOption: đổi model (kể cả "đổi" sang model đang
    // chọn sẵn) có thể hiện popup "Switch model confirmation" làm MẤT ảnh
    // tham chiếu đã upload trước đó (xem confirmModelSwitchIfPresent trong
    // aiVideo.ts) — tránh gọi khi không cần thiết.
    if (model) {
      const modelChip = await firstVisible(modelChipCandidates(page), 3000).catch(
        () => null,
      );
      const currentModelLabel = modelChip
        ? (await modelChip.innerText().catch(() => "")).trim()
        : "";
      if (currentModelLabel.toLowerCase() !== model.toLowerCase()) {
        await selectChipOption(page, modelChipCandidates(page), model, "model");
      }
    }

    for (let i = 0; i < referenceImagePaths.length; i++) {
      await uploadReferenceImage(page, referenceImagePaths[i], i + 1);
    }
    if (referenceImagePaths.length > 0) {
      // Đếm trong aria-label tăng đúng chỉ xác nhận site đã THÊM ảnh vào
      // danh sách — chưa chắc đã upload xong bytes lên server. Chờ mạng
      // rảnh (không còn request nào đang chạy) trước khi bấm Generate, để
      // tránh generate khi ảnh cuối vẫn đang tải lên dở dang.
      await waitForUploadsToSettle(page);
    }

    await dismissBlockingOverlays(page);
    const promptInput = await firstVisible(promptInputCandidates(page), 10_000);
    await clickDismissingModals(page, promptInput);
    await promptInput.fill(prompt);

    await selectImageCount(page, imageCount);
    // await captureSnapshot(
    //   page,
    //   jobId + "-before-generate-cl ick",
    //   "before-generate-click",
    // );
    // Chụp baseline TRƯỚC khi bấm Generate để sau đó biết chính xác ảnh
    // nào là MỚI (không phải ảnh cũ nhất trong lịch sử) — cùng cách tiếp
    // cận đã dùng cho video (xem waitForNewVideo trong aiVideo.ts).
    const baseline = await captureImageBaseline(page);
    // await captureSnapshot(page, jobId + "-before-generate-click", "before-generate-click");

    await dismissBlockingOverlays(page);
    const generateButton = await firstVisible(generateButtonCandidates(page));
    await clickDismissingModals(page, generateButton);
    // await captureSnapshot(
    //   page,
    //   jobId + "-after-generate-click",
    //   "after-generate-click",
    // );

    const newEntry = await waitForNewImageEntry(
      page,
      baseline,
      config.generationTimeoutMs,
    );
    await waitForEntryImagesToSettle(page, newEntry);

    return await downloadImagesInEntry(page, newEntry, jobId);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError
      ? err
      : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/**
 * Chờ mạng rảnh trước (upload bytes xong), RỒI chờ từng thumbnail hết
 * "aria-busy=true" (spinner xử lý ảnh phía client sau khi upload — thực tế
 * đã xác nhận: đếm tăng đúng + mạng rảnh vẫn chưa đủ, ảnh có thể vẫn hiện
 * spinner lúc bấm Generate). Đây mới là tín hiệu chính xác ảnh đã sẵn sàng.
 */
async function waitForUploadsToSettle(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {});

  // Xác nhận qua log lỗi thật:
  // timeout cố định 600s vẫn khiến job fail hẳn khi site xử lý ảnh tham chiếu
  // lâu hơn mốc đó — cùng lý do đã sửa cho waitForFrameUploadToSettle/
  // waitForVideoRefImageUploadsToSettle (aiVideo.ts). Chờ VÔ THỜI HẠN
  // (timeout: 0) tới khi hết aria-busy thay vì fail sau N giây.
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[aria-label="Uploaded image, click to preview"][aria-busy="true"]',
      ).length === 0,
    { timeout: 0 },
  );
}

/**
 * Nút thêm ảnh tham chiếu mở file picker hệ điều hành khi bấm — giống cơ
 * chế Upload Start/End Frame trước đây, dùng waitForEvent("filechooser")
 * thay vì setInputFiles trực tiếp (không biết trước input ẩn nằm đâu).
 * Thử đóng popup quảng cáo trước, và thử lại 1 lần nếu lần đầu thất bại
 * (có thể do popup bật ra đúng lúc đó).
 */
async function uploadReferenceImage(
  page: Page,
  imagePath: string,
  expectedCountAfter: number,
): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    await attemptUploadReferenceImage(page, imagePath, expectedCountAfter);
  } catch (err) {
    // console.warn("[aiVideoImage] Upload ảnh tham chiếu lần đầu thất bại, thử đóng popup rồi thử lại:", err);
    await dismissBlockingOverlays(page);
    await attemptUploadReferenceImage(page, imagePath, expectedCountAfter);
  }
}

async function attemptUploadReferenceImage(
  page: Page,
  imagePath: string,
  expectedCountAfter: number,
): Promise<void> {
  try {
    const addButton = await firstVisible(
      addReferenceImageButtonCandidates(page),
      8000,
    );

    // Model "Image-1.0" dùng chung nút "Upload Character Refs" với mode
    // Character Reference bên trang video (xem addReferenceImageButtonCandidates)
    // — bấm nút này hiện popup Ant Design "Subject Reference Terms of Use"
    // TRƯỚC, CHƯA mở file picker ngay (DOM thật do người dùng cung cấp trực
    // tiếp). QUAN TRỌNG: xác nhận qua debug thật — chính cú click nút
    // "Confirm" trên popup ToS mới là thứ THỰC SỰ mở file picker, click LẠI
    // nút upload ban đầu sau khi confirm KHÔNG mở được gì (ToS hiện lại/
    // timeout). Đăng ký chờ filechooser TRƯỚC khi click nút upload lần đầu
    // (tránh race — event có thể bắn ra ngay lúc click nếu ToS đã đồng ý từ
    // trước, không hiện lại nữa).
    const fileChooserAfterFirstClick = page
      .waitForEvent("filechooser", { timeout: 10_000 })
      .catch(() => null);
    // Icon chip model (vd "Nano Banana 2 model icon") đôi khi đè lên đúng
    // nút này, khiến Playwright báo "subtree intercepts pointer events" và
    // click thường không bao giờ qua được (xác nhận qua log lỗi thật, job
    // Bread_Mice_1_SCENE_001_START) — dismissBlockingOverlays không dọn được
    // vì đây không phải modal/popup, chỉ là 1 icon layout đè lên. Fallback
    // force click bỏ qua kiểm tra bị che của Playwright sau khi click
    // thường (có dismiss modal) thất bại.
    try {
      await clickDismissingModals(page, addButton);
    } catch {
      await clickWithForceFallback(addButton, 15_000);
    }

    const termsConfirmButton = await firstVisible(
      confirmCharacterButtonCandidates(page),
      3000,
    ).catch(() => null);
    const canConfirmTerms =
      termsConfirmButton !== null &&
      (await termsConfirmButton.isEnabled().catch(() => false));

    const fileChooser: FileChooser | null = canConfirmTerms
      ? (
          await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10_000 }),
            termsConfirmButton!.click(),
          ])
        )[0]
      : await fileChooserAfterFirstClick;

    if (!fileChooser) {
      throw new Error("Không mở được file picker sau khi bấm nút upload");
    }

    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);

    // Xác nhận site THỰC SỰ ghi nhận ảnh vừa upload — tránh lặp lại lỗi từng
    // gặp: setFiles() không báo lỗi gì nhưng site vẫn hiện "(0/16)" vì click
    // trúng nhầm phần tử khác. getReferenceImageCount() chỉ đọc được số đếm
    // "(N/M)" ở mode "Image Refs" — mode "Character Refs" (model
    // "Image-1.0") KHÔNG có định dạng này nên luôn trả về null, khiến bước
    // xác nhận bị BỎ QUA hoàn toàn nếu chỉ dựa vào nó (xác nhận qua debug
    // thật: job Bread_Mice_SCENE_01_START — upload thất bại âm thầm, không
    // có thumbnail nào nhưng code vẫn tiếp tục bấm Generate). Fallback đếm
    // TRỰC TIẾP số thumbnail đã gắn (uploadedReferenceImageThumbnailLocator)
    // khi getReferenceImageCount() không đọc được.
    const currentCount =
      (await getReferenceImageCount(page)) ??
      (await uploadedReferenceImageThumbnailLocator(page).count());
    if (currentCount < expectedCountAfter) {
      throw new Error(
        `Site chưa ghi nhận ảnh vừa upload (đếm hiện tại: ${currentCount}/${expectedCountAfter} kỳ vọng)`,
      );
    }
  } catch (err) {
    throw new GenerationError(
      `Không tải được ảnh tham chiếu lên — site có thể đã đổi giao diện upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

interface ImageBaseline {
  entryCount: number;
  firstEntryFeedId: string | null;
  lastEntryFeedId: string | null;
}

async function captureImageBaseline(page: Page): Promise<ImageBaseline> {
  const entries = historyImageEntryLocator(page);
  const count = await entries.count();
  return {
    entryCount: count,
    firstEntryFeedId: count > 0 ? await getEntryFeedId(entries.first()) : null,
    lastEntryFeedId: count > 0 ? await getEntryFeedId(entries.last()) : null,
  };
}

/**
 * Mỗi lần generate là 1 ENTRY mới (không phải 1 <img> mới) — 1 entry ảnh có
 * thể chứa NHIỀU ảnh (thực tế xác nhận: 4 ảnh/lần, gộp trong 1 khối
 * "grid grid-cols-2"). Tìm đúng entry mới rồi trả về, để caller lấy HẾT ảnh
 * bên trong thay vì chỉ 1 ảnh đầu/cuối. Cùng cách tiếp cận với
 * waitForNewVideo — xem chú thích ở đó.
 */
async function waitForNewImageEntry(
  page: Page,
  baseline: ImageBaseline,
  timeoutMs: number,
): Promise<Locator> {
  const entries = historyImageEntryLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;

  while (Date.now() - start < timeoutMs) {
    const count = await entries.count();
    if (count > baseline.entryCount) {
      const currentFirstFeedId = await getEntryFeedId(entries.first());
      if (currentFirstFeedId !== baseline.firstEntryFeedId) {
        return entries.first();
      }
      return entries.last();
    }

    const paywall = await firstVisible(creditPaywallModalCandidates(page), 1000)
      .then(() => true)
      .catch(() => false);
    if (paywall) {
      throw new GenerationError(
        "Tài khoản hết credit hoặc bị popup nâng cấp gói chặn — cần nạp thêm credit/nâng cấp gói trên AIVideo",
      );
    }

    const failed = await firstVisible(errorIndicatorCandidates(page), 1000)
      .then(() => true)
      .catch(() => false);
    if (failed) {
      throw new GenerationError("Website báo lỗi khi tạo ảnh");
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(
    `Hết thời gian chờ tạo ảnh (timeout ${timeoutMs}ms)`,
  );
}

/**
 * Card LỖI trong entry — DOM thật do người dùng cung cấp trực tiếp (batch 4
 * ảnh, CẢ 4 card cùng rơi vào trạng thái này 1 lượt): mỗi card
 * `[data-card-id]` mang "data-batch-disabled" + aria-disabled="true", KHÔNG
 * có <img src> bên trong, chỉ icon ảnh vỡ + 1 nút tròn info
 * (`absolute bottom-3 right-3`) để xem lý do lỗi. Trước đây từng thử dùng
 * riêng "data-batch-disabled" để phát hiện sớm nhưng SAI (marker này còn
 * dùng cho ít nhất 3 trạng thái ĐANG XỬ LÝ khác — spinner/progress ring/%) —
 * nên ở đây bắt buộc thêm điều kiện KHÔNG có <img src> để loại các card đã
 * xong thật, và chỉ kết luận "lỗi" khi seri TẤT CẢ card trong entry đều rơi
 * vào trạng thái này CÙNG LÚC (không phải chỉ 1 vài card — 1 vài card lỗi
 * xen giữa các card khác vẫn đang xử lý bình thường không tính).
 */
function countErrorCards(entry: Locator): Locator {
  return entry.locator(
    "[data-card-id][data-batch-disabled]:not(:has(img[src]))",
  );
}

/**
 * Entry mới xuất hiện trong lịch sử KHÔNG có nghĩa cả 4 ảnh đã render xong —
 * site có thể thêm khối entry trước rồi lấp dần từng ảnh vào sau (giống
 * cách reference-image thumbnail vẫn "aria-busy" một lúc sau khi đã upload
 * xong). Vì vậy chờ số lượng ảnh THÀNH CÔNG (<img> thật) ỔN ĐỊNH (không tăng
 * thêm trong vài giây liên tiếp) trước khi coi là "đã đủ", thay vì đọc số
 * lượng ngay lúc entry vừa xuất hiện — tránh chỉ tải được 1-2/4 ảnh.
 *
 * Thoát SỚM (không cần đợi hết timeoutMs) nếu TOÀN BỘ card trong entry đều
 * là card lỗi (xem countErrorCards) — kiểm tra MỖI vòng poll, không cần chờ
 * ổn định thêm vì đây là tín hiệu DOM trực tiếp (không suy đoán qua thời
 * gian như trước).
 */
async function waitForEntryImagesToSettle(
  page: Page,
  entry: Locator,
  timeoutMs = 600_000,
): Promise<void> {
  const images = entryImagesLocator(entry);
  const totalCards = entry.locator("[data-card-id]");
  const errorCards = countErrorCards(entry);
  const start = Date.now();
  const pollIntervalMs = 15000;
  const requiredStableMs = 120000;

  let lastCount = await images.count();
  let stableSince = Date.now();

  while (Date.now() - start < timeoutMs) {
    const total = await totalCards.count();
    const errored = await errorCards.count();
    if (total > 0 && errored === total) {
      throw new GenerationError(
        `Không tạo được ảnh nào — cả ${total} ảnh trong lần generate này đều lỗi`,
      );
    }

    if (lastCount > 0 && Date.now() - stableSince >= requiredStableMs) {
      return;
    }

    await page.waitForTimeout(pollIntervalMs);
    const count = await images.count();
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    }
  }
}

/**
 * Lấy data-feed-id của từng ảnh THÀNH CÔNG trong entry (mỗi media-card-wrapper
 * mang 1 data-feed-id riêng) — cần lấy HẾT trước khi điều hướng trang đi chỗ
 * khác, vì entry locator gắn với DOM hiện tại của trang tạo ảnh.
 *
 * Thực tế xác nhận: 1 lần generate 4 ảnh không phải lúc nào cũng cả 4 đều
 * thành công — card bị lỗi có data-batch-disabled/aria-disabled="true" trên
 * media-card-wrapper và KHÔNG có thẻ <img src> bên trong (chỉ icon lỗi +
 * nút info), dù div[data-feed-id] vẫn tồn tại. Lọc theo ":has(img[src])" để
 * chỉ lấy card đã render ảnh thật, tránh cố tải ảnh không tồn tại.
 *
 * PHẢI loại trừ 2 ảnh placeholder site chèn lúc card còn "Generating..."
 * (src chứa "creating-default-bg"/"creating-pulse" — cùng bằng chứng DOM
 * thật đã dùng cho entryImagesLocator trong selectors.ts) — 2 ảnh này CŨNG
 * khớp "img[src]" dù card chưa xong, nếu không loại trừ sẽ lấy nhầm feedId
 * của card đang xử lý dở, cố tải ảnh chưa tồn tại.
 */
async function getEntryFeedIds(entry: Locator): Promise<string[]> {
  const cards = entry.locator(
    'div[data-feed-id]:has(img[src]:not([src*="creating-default-bg"]):not([src*="creating-pulse"]))',
  );
  const count = await cards.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await cards.nth(i).getAttribute("data-feed-id");
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Tải TẤT CẢ ảnh trong entry, mỗi ảnh KHÔNG watermark — cùng kỹ thuật với
 * downloadVideo() trong aiVideo.ts: điều hướng thẳng tới trang chi tiết
 * /my-work-detail/ai-image/<feedId>?source-page=create (mỗi ảnh trong cụm
 * có feedId riêng) rồi đọc downloadURLWithoutWatermark nhúng sẵn trong
 * Next.js flight data của trang — đáng tin cậy hơn nhiều so với fetch thẳng
 * <img src> (bản đó có watermark, giống video trước khi sửa).
 */
async function downloadImagesInEntry(
  page: Page,
  entry: Locator,
  jobId: string,
): Promise<string[]> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });

  const feedIds = await getEntryFeedIds(entry);
  if (feedIds.length === 0) {
    // Cả cụm (thường 4 ảnh) đều rơi vào trạng thái lỗi (data-batch-disabled,
    // không có <img src>) — không phải bug, chỉ là site tạo ảnh thất bại.
    throw new GenerationError(
      "Không tạo được ảnh nào — site báo lỗi tất cả ảnh trong lần generate này",
    );
  }

  const filePaths: string[] = [];
  for (let i = 0; i < feedIds.length; i++) {
    filePaths.push(
      await downloadImageByFeedId(page, feedIds[i], jobId, i, feedIds.length),
    );
  }
  return filePaths;
}

async function downloadImageByFeedId(
  page: Page,
  feedId: string,
  jobId: string,
  index: number,
  total: number,
): Promise<string> {
  const detailUrl = new URL(
    `/my-work-detail/ai-image/${feedId}`,
    config.aiVideoBaseUrl,
  );
  detailUrl.searchParams.set("source-page", "create");

  // Xác nhận qua log lỗi thật (job cay_khe_test_CHAR_MAGIC_BIRD): điều hướng
  // thẳng tới URL chi tiết đôi khi bị BOUNCE về TRANG CHỦ AIVideo
  // (nút "Create Video"/"Create Image", banner quảng cáo H3) thay vì trang
  // chi tiết — debug screenshot lúc lỗi xác nhận rõ, kèm 1 popup "Max
  // Membership Benefits Updated" che 1 phần trang. Trang chủ KHÔNG BAO GIỜ
  // có "downloadURLWithoutWatermark" trong flight data, nên waitForFunction
  // (cũ: chờ hết NGUYÊN 600s) rồi vẫn đọc hụt — cực kỳ lãng phí thời gian
  // trước khi báo lỗi. Thử lại NGUYÊN việc điều hướng vài lần (không chỉ chờ
  // dài hơn ở CÙNG 1 lần), mỗi lần chờ ngắn hơn nhiều — nghi nguyên nhân là
  // backend chưa kịp index asset vừa tạo xong đúng lúc điều hướng, tự hết
  // sau vài giây tới vài chục giây.
  const maxDetailPageAttempts = 3;
  let flightData = "";
  for (let attempt = 1; attempt <= maxDetailPageAttempts; attempt++) {
    await gotoWithRetry(page, detailUrl.toString());

    // gotoWithRetry chỉ chờ domcontentloaded — trang chi tiết là SPA, có lúc
    // vẫn còn đang ở màn hình loading trống (đã xác nhận qua debug screenshot
    // thực tế) khi đọc page.content() ngay, nên đọc hụt downloadURLWithoutWatermark
    // dù trang sau đó vẫn render đúng. Chờ tới khi flight data thật sự xuất
    // hiện trong DOM trước khi trích xuất.
    const found = await page
      .waitForFunction(
        () =>
          document.documentElement.innerHTML.includes(
            "downloadURLWithoutWatermark",
          ),
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);

    if (found) {
      flightData = await getFlightDataText(page);
      break;
    }

    console.warn(
      `[aiVideoImage] Trang chi tiết ảnh (feedId ${feedId}) chưa có downloadURLWithoutWatermark sau 60s (lần ${attempt}/${maxDetailPageAttempts}, URL hiện tại: ${page.url()}) — thử điều hướng lại.`,
    );
    if (attempt < maxDetailPageAttempts) {
      await page.waitForTimeout(3000);
    }
  }
  // Đọc self.__next_f đã nối lại (KHÔNG dùng page.content() thô) — tránh bị
  // cắt ngang URL do Next.js tách string qua nhiều thẻ <script>, xem chú
  // thích getFlightDataText trong aiVideo.ts. Nếu cả maxDetailPageAttempts
  // lần đều không thấy marker, vẫn đọc thử 1 lần cuối (best-effort) — lỗi
  // "Không tìm thấy downloadURLWithoutWatermark hợp lệ" ở dưới sẽ tự báo rõ.
  if (!flightData) {
    flightData = await getFlightDataText(page);
  }
  const noWatermarkUrl = extractDownloadUrlWithoutWatermark(flightData, feedId);

  const response = await fetchWithRetry(page, noWatermarkUrl);

  // Suy ra đuôi file thật từ URL thay vì hardcode .png — tránh lệch định
  // dạng thật (có thể là .jpg/.webp) khiến Telegram xử lý ảnh lỗi.
  const ext = path.extname(new URL(noWatermarkUrl).pathname) || ".png";
  const filePath = path.join(
    config.downloadDir,
    total > 1 ? `${jobId}-${index + 1}${ext}` : `${jobId}${ext}`,
  );
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}
