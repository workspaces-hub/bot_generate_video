import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { getBrowserContext } from "./browser";
import {
  antModalCloseButtonLocator,
  antModalWrapperLocator,
  creditPaywallModalCandidates,
  dropdownOptionCandidates,
  errorIndicatorCandidates,
  firstVisible,
  generateButtonCandidates,
  historyVideoLocator,
  modelChipCandidates,
  promptInputCandidates,
  resolutionChipCandidates,
  signInIndicatorCandidates,
} from "./selectors";

export class GenerationError extends Error {}

export interface GenerateVideoOptions {
  resolution?: string;
  model?: string;
}

export async function generateVideo(
  prompt: string,
  { resolution, model }: GenerateVideoOptions,
  jobId: string,
): Promise<string> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL(config.hailuoCreatePath, config.hailuoBaseUrl).toString();
    await gotoWithRetry(page, url);

    await ensureLoggedIn(page);
    await dismissPaywallIfBlocking(page);

    const promptInput = await firstVisible(promptInputCandidates(page));
    await clickDismissingModals(page, promptInput);
    await promptInput.fill(prompt);

    if (model) {
      await selectChipOption(page, modelChipCandidates(page), model, "model");
    }
    // if (resolution) {
    //   await selectChipOption(page, resolutionChipCandidates(page), resolution, "resolution");
    // }

    // await captureSnapshot(page, jobId, "before-generate-click");

    // Chụp baseline TRƯỚC khi bấm Generate để sau đó biết chính xác video
    // nào là MỚI (không phải video cũ nhất trong lịch sử — xem waitForNewVideo).
    const baseline = await captureVideoBaseline(page);

    const generateButton = await firstVisible(generateButtonCandidates(page));
    await clickDismissingModals(page, generateButton);
    await captureSnapshot(page, jobId + "_" + "after-generate-click", "after-generate-click");

    const newVideo = await waitForNewVideo(page, baseline, config.generationTimeoutMs);

    return await downloadVideo(page, newVideo, jobId);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError ? err : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}

/**
 * Bấm 1 chip (model/resolution) để mở dropdown, rồi chọn option có text
 * khớp với giá trị mong muốn. Không throw nếu không tìm thấy — chỉ log
 * cảnh báo và giữ nguyên lựa chọn mặc định của site, để 1 chip lỗi không
 * làm hỏng cả job (video vẫn tạo được, chỉ sai model/resolution).
 */
async function selectChipOption(
  page: Page,
  chipCandidates: Array<() => Locator>,
  targetText: string,
  label: string,
): Promise<void> {
  try {
    const chip = await firstVisible(chipCandidates, 3000);
    await clickDismissingModals(page, chip);

    const option = await firstVisible(dropdownOptionCandidates(page, targetText), 3000);
    await clickWithForceFallback(option);
  } catch (err) {
    console.warn(`[hailuo] Không chọn được ${label} "${targetText}", dùng mặc định của site:`, err);
  }
}

/**
 * Rớt kết nối tạm thời qua proxy (net::ERR_TIMED_OUT, ERR_CONNECTION_*) khá
 * phổ biến khi chạy qua proxy — thử lại vài lần trước khi báo lỗi hẳn, thay
 * vì fail job ngay ở lần đầu.
 */
async function gotoWithRetry(page: Page, url: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[hailuo] page.goto lỗi (lần ${attempt}/${attempts}):`, err instanceof Error ? err.message : err);
      if (attempt < attempts) {
        await page.waitForTimeout(3000);
      }
    }
  }
  throw lastErr;
}

/**
 * Đóng modal Ant Design đang che trang (nếu có) — bấm nút X chuẩn của thư
 * viện (.ant-modal-close), fallback về phím Escape nếu không thấy nút X.
 * Trả về true nếu có modal và đã thử đóng, false nếu không có modal nào.
 */
async function dismissAntModalIfPresent(page: Page): Promise<boolean> {
  const visible = await antModalWrapperLocator(page)
    .first()
    .isVisible()
    .catch(() => false);
  if (!visible) return false;

  const hasCloseButton = await antModalCloseButtonLocator(page)
    .first()
    .isVisible()
    .catch(() => false);
  if (hasCloseButton) {
    await antModalCloseButtonLocator(page).first().click().catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(500);
  return true;
}

/**
 * Bấm 1 locator, nếu bị chặn bởi modal quảng cáo/sự kiện (site hay bật bất
 * chợt ở nhiều thời điểm) thì tự đóng modal rồi thử lại 1 lần trước khi báo
 * lỗi hẳn.
 */
async function clickDismissingModals(page: Page, locator: Locator, timeoutMs = 15_000): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (err) {
    const dismissed = await dismissAntModalIfPresent(page);
    if (!dismissed) throw err;
    await locator.click({ timeout: timeoutMs });
  }
}

/**
 * Một số banner/ảnh quảng cáo động (vd "activity banner") nằm đè lên danh
 * sách option trong popover và liên tục thay đổi vị trí — khiến Playwright
 * coi phần tử đích là "not stable"/bị che, click thường không bao giờ qua
 * được. Fallback: bấm thẳng vào toạ độ phần tử (force), bỏ qua các kiểm tra
 * ổn định/che khuất của Playwright.
 */
async function clickWithForceFallback(locator: Locator, timeoutMs = 10_000): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

async function ensureLoggedIn(page: Page): Promise<void> {
  const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
    .then(() => true)
    .catch(() => false);
  if (signedOut) {
    throw new GenerationError(
      "Chưa đăng nhập hailuoai.video hoặc session đã hết hạn. Chạy lại: npm run login",
    );
  }
}

/**
 * Popup quảng cáo/nâng cấp gói (vd "Seedance 2.0 Full Lineup... Choose Your
 * Plan, Subscribe, Redeem a Code") có thể tự hiện che kín trang tạo video
 * ngay khi vừa vào trang — không hẳn lúc nào cũng do hết credit. Thử đóng
 * bằng phím Escape (đa số modal/dialog đều lắng nghe phím này); nếu vẫn còn
 * mới coi là bị chặn thật và báo lỗi rõ ràng.
 */
async function dismissPaywallIfBlocking(page: Page): Promise<void> {
  const visible = await firstVisible(creditPaywallModalCandidates(page), 2000)
    .then(() => true)
    .catch(() => false);
  if (!visible) return;

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const stillVisible = await firstVisible(creditPaywallModalCandidates(page), 2000)
    .then(() => true)
    .catch(() => false);
  if (stillVisible) {
    throw new GenerationError(
      "Popup quảng cáo/nâng cấp gói đang che khung tạo video và không tự đóng được — " +
        "thử lại sau; nếu lặp lại nhiều lần, kiểm tra credit tài khoản trên hailuoai.video",
    );
  }
}

interface VideoBaseline {
  count: number;
  firstSrc: string | null;
  lastSrc: string | null;
}

async function captureVideoBaseline(page: Page): Promise<VideoBaseline> {
  const videos = historyVideoLocator(page);
  const count = await videos.count();
  return {
    count,
    firstSrc: count > 0 ? await videos.first().getAttribute("src") : null,
    lastSrc: count > 0 ? await videos.last().getAttribute("src") : null,
  };
}

/**
 * Chờ tới khi có video MỚI xuất hiện trong lịch sử (count tăng so với
 * baseline), rồi tự phát hiện video mới nằm ở đầu hay cuối danh sách bằng
 * cách so sánh src với baseline — không giả định cố định .first()/.last().
 */
async function waitForNewVideo(page: Page, baseline: VideoBaseline, timeoutMs: number): Promise<Locator> {
  const videos = historyVideoLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;

  while (Date.now() - start < timeoutMs) {
    const count = await videos.count();
    if (count > baseline.count) {
      const currentFirstSrc = await videos.first().getAttribute("src");
      if (currentFirstSrc !== baseline.firstSrc) {
        return videos.first();
      }
      return videos.last();
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
      throw new GenerationError("Website báo lỗi khi tạo video");
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(`Hết thời gian chờ tạo video (timeout ${timeoutMs}ms)`);
}

/**
 * Tải video KHÔNG watermark: click vào video trong lịch sử để chuyển sang
 * trang chi tiết → hover nút dropdown (icon download) để mở popup → chọn
 * "Remove watermark" → bắt sự kiện download của Playwright để lưu file.
 * (Trước đây fetch thẳng attribute src của thẻ <video> — bản đó có watermark.)
 */
/** Xuất ra để scripts/download-last-video.ts dùng lại đúng logic tải video không watermark. */
export async function downloadVideo(page: Page, video: Locator, jobId: string): Promise<string> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
  const filePath = path.join(config.downloadDir, `${jobId}.mp4`);

  // Click vào video/card để "chuyển trang" không đáng tin cậy (thẻ <video>
  // chặn click bằng play/pause, card wrapper không phải lúc nào cũng đúng
  // phần tử điều hướng). Trang chi tiết có URL cố định dạng
  // /my-work-detail/ai-video/<id>?source-page=create, với <id> chính là
  // data-feed-id của card — nên điều hướng thẳng bằng goto, bỏ qua click.
  const card = video.locator("xpath=ancestor::div[@data-feed-id][1]");
  const feedId = await card.first().getAttribute("data-feed-id").catch(() => null);
  if (!feedId) {
    throw new GenerationError("Không lấy được id video (data-feed-id) để mở trang chi tiết tải xuống");
  }

  const detailUrl = new URL(`/my-work-detail/ai-video/${feedId}`, config.hailuoBaseUrl);
  detailUrl.searchParams.set("source-page", "create");
  await gotoWithRetry(page, detailUrl.toString());

  // Trang chi tiết nhúng sẵn URL không watermark ngay trong dữ liệu Next.js
  // flight data (self.__next_f.push(...)) của chính trang, dạng
  // downloadURLWithoutWatermark — đáng tin cậy hơn nhiều so với hover/click
  // dropdown (site có thể đổi UI dropdown, nhưng field data này ổn định
  // hơn vì là dữ liệu thô, không phải giao diện).
  const html = await page.content();
  const match = html.match(/downloadURLWithoutWatermark[\\"]*:[\\"]*([^"\\]+)/);
  if (!match) {
    throw new GenerationError("Không tìm thấy downloadURLWithoutWatermark trên trang chi tiết video");
  }
  const noWatermarkUrl = match[1];

  const response = await page.context().request.get(noWatermarkUrl);
  if (!response.ok()) {
    throw new GenerationError(`Tải video (không watermark) thất bại: HTTP ${response.status()}`);
  }
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}

async function writeSnapshotFiles(page: Page, jobId: string): Promise<void> {
  await fs.promises.mkdir(config.debugDir, { recursive: true });
  await page.screenshot({ path: path.join(config.debugDir, `${jobId}.png`), fullPage: true });
  await fs.promises.writeFile(
    path.join(config.debugDir, `${jobId}.html`),
    await page.content(),
    "utf-8",
  );
}

/** Chụp trạng thái trang giữa luồng để debug — KHÔNG có nghĩa là job lỗi. */
export async function captureSnapshot(page: Page, jobId: string, label: string): Promise<void> {
  try {
    await writeSnapshotFiles(page, jobId);
    console.log(`[hailuo] Snapshot "${label}" đã lưu: storage/debug/${jobId}.png`);
  } catch (debugErr) {
    console.error("[hailuo] Không thể lưu debug snapshot:", debugErr);
  }
}

/** Chụp trạng thái trang khi job THỰC SỰ lỗi (gọi trong catch). */
async function captureErrorSnapshot(page: Page, jobId: string, err: unknown): Promise<void> {
  try {
    await writeSnapshotFiles(page, jobId);
  } catch (debugErr) {
    console.error("[hailuo] Không thể lưu debug snapshot:", debugErr);
  }
  console.error(`[hailuo] Job ${jobId} lỗi:`, err);
}
