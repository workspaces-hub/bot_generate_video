import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { getBrowserContext } from "./browser";
import {
  GenerationError,
  captureErrorSnapshot,
  captureSnapshot,
  clickDismissingModals,
  dismissBlockingOverlays,
  dismissPaywallIfBlocking,
  ensureLoggedIn,
  extractDownloadUrlWithoutWatermark,
  fetchWithRetry,
  // getAvailableCredit,
  getFlightDataText,
  // getGenerationFee,
  gotoWithRetry,
  selectChipOption,
} from "./aiVideo";
import {
  addReferenceImageButtonCandidates,
  busyReferenceImageThumbnailLocator,
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

  const context = await getBrowserContext();
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

    // Cùng lý do đã sửa cho video (xem chú thích generateVideo trong
    // aiVideo.ts): gotoWithRetry chỉ chờ domcontentloaded, SPA còn cần thêm
    // thời gian hydrate. Nếu không có ảnh tham chiếu thì không bước nào ở
    // trên chờ mạng cả, nên vẫn cần chờ ở đây trước khi tìm ô nhập prompt.
    if (referenceImagePaths.length === 0) {
      await page
        .waitForLoadState("networkidle", { timeout: 20_000 })
        .catch(() => {});
    }

    await dismissBlockingOverlays(page);
    const promptInput = await firstVisible(promptInputCandidates(page), 10_000);
    await clickDismissingModals(page, promptInput);
    await promptInput.fill(prompt);
    // const [fee, credit] = await Promise.all([
    //   getGenerationFee(page),
    //   getAvailableCredit(page),
    // ]);
    // if (fee !== null && credit !== null) {
    //   if (fee < credit) {
    //     model = "Image-1.0";
    //   }
    // }

    // Cùng chip model dùng chung với trang tạo video (toolbar khung nhập
    // prompt) — xem chú thích selectChipOption trong aiVideo.ts.
    if (model) {
      await selectChipOption(page, modelChipCandidates(page), model, "model");
    }
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

  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[aria-label="Uploaded image, click to preview"][aria-busy="true"]',
        ).length === 0,
      { timeout: 600_000 },
    );
  } catch {
    const stillBusy = await busyReferenceImageThumbnailLocator(page).count();
    if (stillBusy > 0) {
      throw new GenerationError(
        `Còn ${stillBusy} ảnh tham chiếu vẫn đang xử lý (aria-busy) sau 600s chờ — không bấm Generate để tránh dùng ảnh chưa load xong.`,
      );
    }
  }
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
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      clickDismissingModals(page, addButton),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);

    // Xác nhận site THỰC SỰ ghi nhận ảnh vừa upload (đếm trong aria-label
    // tăng đúng) — tránh lặp lại lỗi từng gặp: setFiles() không báo lỗi gì
    // nhưng site vẫn hiện "(0/16)" vì click trúng nhầm phần tử khác.
    const currentCount = await getReferenceImageCount(page);
    if (currentCount !== null && currentCount < expectedCountAfter) {
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
 * Entry mới xuất hiện trong lịch sử KHÔNG có nghĩa cả 4 ảnh đã render xong —
 * site có thể thêm khối entry trước rồi lấp dần từng ảnh vào sau (giống
 * cách reference-image thumbnail vẫn "aria-busy" một lúc sau khi đã upload
 * xong). Vì vậy chờ số lượng ảnh THÀNH CÔNG (<img> thật) ỔN ĐỊNH (không tăng
 * thêm trong vài giây liên tiếp) trước khi coi là "đã đủ", thay vì đọc số
 * lượng ngay lúc entry vừa xuất hiện — tránh chỉ tải được 1-2/4 ảnh.
 *
 * BỎ HẲN cách dùng "data-batch-disabled" để phát hiện sớm case "cả 4 ảnh
 * đều lỗi" (từng thử 2 lần, cả 2 đều sai): marker này được site dùng cho
 * NHIỀU trạng thái "chưa phải asset hoàn chỉnh" khác nhau — không chỉ lỗi
 * thật mà cả đang xử lý (đã gặp ít nhất 3 kiểu UI khác nhau: spinner tròn,
 * progress ring %, và cả trạng thái % không có nút Cancel/Recreate nào) —
 * không có tín hiệu phủ định nào đủ tin cậy để loại trừ hết. Chấp nhận đánh
 * đổi: case "cả 4 đều lỗi" sẽ chờ hết timeoutMs (10 phút) mới báo lỗi, đổi
 * lấy việc không bao giờ cắt ngang 1 job đang generate bình thường.
 */
async function waitForEntryImagesToSettle(
  page: Page,
  entry: Locator,
  timeoutMs = 600_000,
): Promise<void> {
  const images = entryImagesLocator(entry);
  const start = Date.now();
  const pollIntervalMs = 15000;
  const requiredStableMs = 120000;

  let lastCount = await images.count();
  let stableSince = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (Date.now() - stableSince >= requiredStableMs && lastCount > 0) {
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
 */
async function getEntryFeedIds(entry: Locator): Promise<string[]> {
  const cards = entry.locator("div[data-feed-id]:has(img[src])");
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
