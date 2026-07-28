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
  dismissPaywallIfBlocking,
  ensureLoggedIn,
  gotoWithRetry,
} from "./hailuo";
import {
  addReferenceImageButtonCandidates,
  creditPaywallModalCandidates,
  errorIndicatorCandidates,
  firstVisible,
  generateButtonCandidates,
  getReferenceImageCount,
  historyImageLocator,
  imageModeTabCandidates,
  promptInputCandidates,
} from "./selectors";

export const MAX_REFERENCE_IMAGES = 16;

export interface GenerateImageOptions {
  referenceImagePaths?: string[];
}

/**
 * Tạo ảnh từ prompt + tối đa 16 ảnh tham chiếu (tuỳ chọn). CHƯA ĐƯỢC TEST
 * THẬT — selector cho tab "Image", nút thêm ảnh tham chiếu, và khu vực
 * lịch sử ảnh trong selectors.ts đều là phỏng đoán ban đầu (site chưa có
 * DOM thật để soi), nhiều khả năng cần chỉnh sau lần chạy thử đầu qua debug
 * snapshot — giống cách các tính năng khác trong project này đã được tinh
 * chỉnh dần.
 */
export async function generateImage(
  prompt: string,
  { referenceImagePaths = [] }: GenerateImageOptions,
  jobId: string,
): Promise<string> {
  if (referenceImagePaths.length > MAX_REFERENCE_IMAGES) {
    throw new GenerationError(`Chỉ hỗ trợ tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu.`);
  }

  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(config.hailuoCreateImagePath, config.hailuoBaseUrl).toString();
    await gotoWithRetry(page, url);

    await ensureLoggedIn(page);
    await dismissPaywallIfBlocking(page);

    const imageTab = await firstVisible(imageModeTabCandidates(page));
    await clickDismissingModals(page, imageTab);

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

    const promptInput = await firstVisible(promptInputCandidates(page));
    await clickDismissingModals(page, promptInput);
    await promptInput.fill(prompt);

    // Chụp baseline TRƯỚC khi bấm Generate để sau đó biết chính xác ảnh
    // nào là MỚI (không phải ảnh cũ nhất trong lịch sử) — cùng cách tiếp
    // cận đã dùng cho video (xem waitForNewVideo trong hailuo.ts).
    const baseline = await captureImageBaseline(page);
    await captureSnapshot(page, jobId + "-before-generate-click", "before-generate-click");

    const generateButton = await firstVisible(generateButtonCandidates(page));
    await clickDismissingModals(page, generateButton);
    await captureSnapshot(page, jobId + "-after-generate-click", "after-generate-click");

    const newImage = await waitForNewImage(page, baseline, config.generationTimeoutMs);

    return await downloadImage(page, newImage, jobId);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError ? err : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/**
 * Chờ mạng rảnh (không còn request nào đang chạy trong 500ms) sau khi
 * upload xong tất cả ảnh tham chiếu — đếm trong aria-label có thể tăng
 * ngay (optimistic UI) trước khi bytes thực sự upload lên xong.
 */
async function waitForUploadsToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * Nút thêm ảnh tham chiếu mở file picker hệ điều hành khi bấm — giống cơ
 * chế Upload Start/End Frame trước đây, dùng waitForEvent("filechooser")
 * thay vì setInputFiles trực tiếp (không biết trước input ẩn nằm đâu).
 */
async function uploadReferenceImage(page: Page, imagePath: string, expectedCountAfter: number): Promise<void> {
  try {
    const addButton = await firstVisible(addReferenceImageButtonCandidates(page), 8000);
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
  count: number;
  firstSrc: string | null;
  lastSrc: string | null;
}

async function captureImageBaseline(page: Page): Promise<ImageBaseline> {
  const images = historyImageLocator(page);
  const count = await images.count();
  return {
    count,
    firstSrc: count > 0 ? await images.first().getAttribute("src") : null,
    lastSrc: count > 0 ? await images.last().getAttribute("src") : null,
  };
}

/** Cùng cách tiếp cận với waitForNewVideo — xem chú thích ở đó. */
async function waitForNewImage(page: Page, baseline: ImageBaseline, timeoutMs: number): Promise<Locator> {
  const images = historyImageLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;

  while (Date.now() - start < timeoutMs) {
    const count = await images.count();
    if (count > baseline.count) {
      const currentFirstSrc = await images.first().getAttribute("src");
      if (currentFirstSrc !== baseline.firstSrc) {
        return images.first();
      }
      return images.last();
    }

    const paywall = await firstVisible(creditPaywallModalCandidates(page), 1000)
      .then(() => true)
      .catch(() => false);
    if (paywall) {
      throw new GenerationError(
        "Tài khoản hết credit hoặc bị popup nâng cấp gói chặn — cần nạp thêm credit/nâng cấp gói trên hailuoai.video",
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

  throw new GenerationError(`Hết thời gian chờ tạo ảnh (timeout ${timeoutMs}ms)`);
}

/**
 * Tải ảnh bằng cách fetch thẳng attribute src (khác video — chưa xác nhận
 * ảnh có bị watermark hay có URL "không watermark" riêng như video hay
 * không). Nếu phát hiện ảnh tải về có watermark, áp dụng lại kỹ thuật đọc
 * downloadURLWithoutWatermark từ trang chi tiết như downloadVideo().
 */
async function downloadImage(page: Page, image: Locator, jobId: string): Promise<string> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
  const filePath = path.join(config.downloadDir, `${jobId}.png`);

  const src = await image.getAttribute("src");
  if (!src) {
    throw new GenerationError("Ảnh mới không có thuộc tính src để tải xuống");
  }

  const absoluteUrl = new URL(src, page.url()).toString();
  const response = await page.context().request.get(absoluteUrl);
  if (!response.ok()) {
    throw new GenerationError(`Tải ảnh thất bại: HTTP ${response.status()}`);
  }
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}