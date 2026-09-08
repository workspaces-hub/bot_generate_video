import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { getPolloImageBrowserContext } from "./polloBrowser";
import {
  captureResultId,
  dismissBlockingOverlays,
  enableUnlimitedIfNotEnoughCredit,
  ensureComposerReadyOrThrow,
  ensureUploadDialogOpen,
  captureGenerationRecordId,
  clickGenerateButton,
  fetchGenerationRecordDetail,
  gotoPolloWithRetry,
  resolveDownloadExtension,
  submitAssetUpload,
  waitForGenerateButtonEnabled,
  waitForGenerationApiStatus,
  withPolloAssetUploadLock,
} from "./pollo";
import {
  GenerationError,
  captureErrorSnapshot,
  captureSnapshot,
  fetchWithRetry,
} from "./aiVideo";
import { firstVisible } from "./selectors";
import {
  creditPaywallLocator,
  generateButtonLocator,
  promptEditorLocator,
  resultCardLocator,
  resultImageLocator,
  signInIndicatorCandidates,
  uploadCardButtonLocator,
} from "./polloSelectors";

/**
 * Provider MỚI (pollo.ai) chạy SONG SONG với AIVideo (aiVideoImage.ts) —
 * KHÔNG thay thế, KHÔNG wired vào queue.ts (chưa quyết định cách chọn
 * provider cho từng job). Xác nhận qua debug DOM thật (storage/debug/
 * inspect-pollo-*, scripts/inspect-pollo*.ts) — trang /image mặc định đã
 * đúng mode "Text/Image to Image", nhận thẳng ảnh tham chiếu qua nút "+"
 * (KHÔNG cần cơ chế "@ mention" như mode "Reference to Video" bên pollo.ts).
 *
 * CHƯA xác nhận qua job THẬT bị lỗi — countErrorCards/waitForNewResult bên
 * dưới CHỈ xử lý happy-path + timeout, chưa có phát hiện lỗi cụ thể (vd nội
 * dung vi phạm chính sách) như đã làm cho AIVideo. Cần bổ sung khi gặp lỗi
 * thật (theo đúng quy ước của cả dự án: viết selector từ bằng chứng thật,
 * không đoán mù).
 */

export interface PolloGenerateImageOptions {
  referenceImagePaths?: string[];
}

/**
 * Chờ dialog "Uploads" mở ra rồi upload đúng 1 file — xác nhận qua lỗi thật
 * (job test-pollo-image-ref-e2e): upload xong file THẬT SỰ xuất hiện thành
 * thumbnail trong lưới (asset-picker-grid), nhưng KHÔNG tự động ở trạng thái
 * "đã chọn" — nút "Select" vẫn disabled tới khi click vào ĐÚNG thumbnail vừa
 * upload để chọn nó. Nhận diện thumbnail mới bằng cách so đếm SỐ LƯỢNG
 * asset-picker-card trước/sau khi setInputFiles (đáng tin cậy hơn đoán vị trí
 * .first()/.last() — dự án chưa xác nhận thumbnail mới chèn ở đầu hay cuối
 * lưới khi đã có sẵn nhiều file khác).
 */
async function uploadReferenceImage(page: Page, imagePath: string): Promise<void> {
  const openDialog = () => ensureUploadDialogOpen(page, uploadCardButtonLocator(page).first());
  await openDialog();
  // Bọc trong withPolloAssetUploadLock (khai báo cùng submitAssetUpload
  // trong pollo.ts) — processPolloImageQueue chạy SONG SONG với
  // processPolloVideoQueue trên CÙNG 1 tài khoản pollo.ai; nếu không khoá,
  // submitAssetUpload của job này (nhận diện "card vừa upload" bằng cách so
  // data-asset-url của card ĐẦU TIÊN trước/sau) có thể chọn NHẦM card của
  // job video đang chạy đồng thời nếu nó upload xen đúng lúc. Xem docstring
  // đầy đủ tại withPolloAssetUploadLock.
  await withPolloAssetUploadLock(() => submitAssetUpload(page, imagePath, openDialog));
}

interface ResultBaseline {
  count: number;
}

async function captureResultBaseline(page: Page): Promise<ResultBaseline> {
  return { count: await resultCardLocator(page).count() };
}

/**
 * Chờ card kết quả MỚI xuất hiện — card mới được THÊM VÀO CUỐI danh sách
 * (ngược AIVideo, xem docstring resultCardLocator trong polloSelectors.ts),
 * nên card mới luôn là .last() khi count tăng. Bên trong mỗi card, khi đang
 * generate có `[data-slot="task-card-generating"]` (xác nhận qua debug DOM
 * thật, kèm text % tiến trình) — chờ marker này biến mất VÀ có ít nhất 1 ảnh
 * thật (resultImageLocator) thì coi là xong.
 *
 * LƯU Ý: đã thử reload lại trang định kỳ để né trường hợp trang không tự
 * cập nhật (xem waitForNewResult bên pollo.ts, phát hiện qua lỗi thật ở
 * VIDEO) nhưng RELOAD làm MẤT HẲN kết quả đang chờ trên trang deep-link
 * compose (xác nhận qua phản hồi thật của user) — nên KHÔNG áp dụng reload ở
 * đây, dù cùng cơ chế trang. Nếu ảnh cũng gặp lỗi tương tự (trang không tự
 * cập nhật), xử lý theo hướng quét /create qua page riêng như bên video,
 * không reload page compose.
 */
/**
 * SỬA (đồng bộ với waitForNewResult bên pollo.ts, xác nhận qua lỗi thật job
 * DRAGON_Tranform_SHOT_06_CLIP_01_VIDEO — video vẫn "generating" hợp lệ lúc bị
 * báo hết timeout): timeoutMs CHỈ áp dụng cho giai đoạn TRƯỚC KHI thấy card
 * generate nào xuất hiện. Một khi đã thấy card đang generate ít nhất 1 lần,
 * không giới hạn thời gian nữa — chờ tới khi thực sự xong hoặc gặp lỗi rõ
 * ràng khác (outOfCredit).
 */
async function waitForNewResult(
  page: Page,
  baseline: ResultBaseline,
  timeoutMs: number,
): Promise<Locator> {
  const cards = resultCardLocator(page);
  const start = Date.now();
  const pollIntervalMs = 5000;
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
        const imageCount = await resultImageLocator(newCard).count();
        if (imageCount > 0) return newCard;
        // Card đã hết trạng thái "generating" nhưng KHÔNG có ảnh nào — xác
        // nhận qua lỗi thật (job test_master_live_CHARACTER_LAM_YEN_NHIEN):
        // card hiện nguyên văn "Input flagged by the third-party model.
        // Please modify your input and try again. Credits refunded." — pollo.ai
        // từ chối vì nội dung bị model bên thứ 3 gắn cờ, CÙNG bản chất với
        // lỗi vi phạm chính sách của AIVideo. Ném message chứa nguyên văn này
        // để khớp CONTENT_VIOLATION_PATTERN (storyboardPipeline.ts) — nhờ đó
        // generateWithContentViolationRetry tự kích hoạt nhờ ChatAI viết lại
        // prompt rồi thử lại, thay vì bỏ cuộc ngay.
        const cardText = await newCard.innerText().catch(() => "");
        if (/flagged by the third-party model/i.test(cardText)) {
          throw new GenerationError(
            `pollo.ai từ chối tạo ảnh: ${cardText.split("\n")[0].trim()}`,
          );
        }
        throw new GenerationError(
          "pollo.ai báo card kết quả đã xong nhưng không thấy ảnh nào (có thể đã lỗi — cần bổ sung phát hiện cụ thể khi có bằng chứng thật)",
        );
      }
    }

    // Xác nhận qua lỗi thật khi test generateVideo (xem docstring
    // creditPaywallLocator trong polloSelectors.ts) — bấm Generate khi không
    // đủ credit KHÔNG tạo card mới nào cả, khiến vòng lặp trên treo mãi nếu
    // không phát hiện riêng (nay không còn timeoutMs cứu). Áp dụng phòng ngừa
    // cho ảnh dù chưa trực tiếp gặp (cùng cơ chế popup, khả năng cao dùng
    // chung).
    const outOfCredit = await creditPaywallLocator(page)
      .first()
      .isVisible()
      .catch(() => false);
    if (outOfCredit) {
      throw new GenerationError(
        "Tài khoản pollo.ai không đủ credit để tạo ảnh với model/cấu hình hiện tại — cần nạp thêm credit hoặc đổi model rẻ hơn.",
      );
    }

    if (!sawGeneratingCard && Date.now() - start >= timeoutMs) {
      throw new GenerationError(
        `Hết thời gian chờ tạo ảnh (timeout ${timeoutMs}ms) — chưa từng thấy card generate nào xuất hiện.`,
      );
    }

    await page.waitForTimeout(pollIntervalMs);
  }
}

/**
 * Tải TẤT CẢ ảnh trong 1 card — src đọc thẳng là URL cuối cùng, không cần
 * dance qua trang chi tiết như AIVideo.
 *
 * SỬA LẠI (xác nhận qua file tải THẬT, job test-pollo-image-e2e): ảnh
 * pollo.ai VẪN có watermark "Pollo.ai" đóng ở góc — nhận định trước đó (dựa
 * vào URL path "/image/" không chứa "/wm/" như video) là SAI, đường dẫn ảnh
 * không phân biệt có/không watermark như video (chỉ video có 2 URL riêng
 * biệt qua dropdown Download). Ảnh KHÔNG có tuỳ chọn "Download without
 * watermark" nào cả (chỉ thấy dropdown này cho video) — nên watermark ảnh có
 * thể là mặc định KHÔNG THỂ tắt được qua UI thường, cần xác nhận thêm.
 */
async function downloadResultImages(
  page: Page,
  card: Locator,
  jobId: string,
): Promise<string[]> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });

  const images = resultImageLocator(card);
  const count = await images.count();
  const filePaths: string[] = [];
  for (let i = 0; i < count; i++) {
    const src = await images.nth(i).getAttribute("src");
    if (!src) continue;
    const response = await fetchWithRetry(page, src);
    const ext = resolveDownloadExtension(response, src);
    const filePath = path.join(
      config.downloadDir,
      count > 1 ? `${jobId}-${i + 1}${ext}` : `${jobId}${ext}`,
    );
    await fs.promises.writeFile(filePath, await response.body());
    filePaths.push(filePath);
  }

  if (filePaths.length === 0) {
    throw new GenerationError("Không tải được ảnh nào — không đọc được src hợp lệ");
  }
  return filePaths;
}

/** Kết quả generate ảnh pollo.ai — polloResultId (id nội bộ pollo.ai, dạng "/v/<id>") null nếu không lấy được (xem captureResultId), caller (storyboardPipeline.ts) tự quyết định lưu vào đâu. */
export interface PolloGenerateImageResult {
  filePaths: string[];
  polloResultId: string | null;
}

/**
 * Tạo ảnh từ prompt + tối đa vài ảnh tham chiếu (tuỳ chọn) qua pollo.ai
 * (mode "Text/Image to Image", mặc định của trang /image).
 */
export async function generateImage(
  prompt: string,
  { referenceImagePaths = [] }: PolloGenerateImageOptions,
  jobId: string,
): Promise<PolloGenerateImageResult> {
  const context = await getPolloImageBrowserContext();
  const page = await context.newPage();
  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    // timeout: 0 = tắt hẳn giới hạn thời gian — cùng lý do đã sửa cho
    // generateVideo bên pollo.ts (job microdrama_co_dau_phan_boi_twist_prompt):
    // mạng/site chậm thoáng qua không nên làm rớt cả job.
    await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);

    await ensureComposerReadyOrThrow(page, url, "tạo ảnh");

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 3000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      throw new GenerationError(
        "Chưa đăng nhập pollo.ai hoặc session đã hết hạn. Chạy: npm run login-pollo",
      );
    }

    for (const refPath of referenceImagePaths) {
      await uploadReferenceImage(page, refPath);
    }

    const editor = promptEditorLocator(page).first();
    await editor.focus();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(300);

    await enableUnlimitedIfNotEnoughCredit(page, jobId);

    const baseline = await captureResultBaseline(page);
    // await captureSnapshot(page, jobId, "before-click-generate");
    await dismissBlockingOverlays(page);
    const generateButton = generateButtonLocator(page).first();
    await waitForGenerateButtonEnabled(page, generateButton);
    const recordId = await captureGenerationRecordId(page, () =>
      clickGenerateButton(page, generateButton, baseline.count),
    );
    // await captureSnapshot(page, jobId, "after-click-generate");

    // Check trạng thái qua API song song với việc DOM tự cập nhật — xem
    // docstring waitForGenerationApiStatus (pollo.ts). recordId null (bắt
    // response thất bại) thì bỏ qua hẳn, dùng lại đúng cơ chế dò DOM cũ.
    const apiStatus =
      recordId !== null
        ? await waitForGenerationApiStatus(page, recordId, config.generationTimeoutMs, jobId)
        : null;
    if (recordId !== null) {
      console.log(`[pollo] API record ${recordId} status: ${apiStatus ?? "(hết thời gian chờ, không rõ)"}`);
    }

    let newCard: Locator;
    try {
      newCard = await waitForNewResult(page, baseline, config.generationTimeoutMs);
    } catch (err) {
      // DOM không thấy ảnh mới dù API đã xác nhận "succeed" — đúng dạng bug
      // đã gặp thật ở mode Reference to Video/chat_box (xem waitForNewResult
      // trong pollo.ts): tải trực tiếp qua mediaUrl của API thay vì bỏ cuộc.
      if (apiStatus === "succeed" && recordId !== null) {
        const detail = await fetchGenerationRecordDetail(page, recordId);
        if (detail?.mediaUrl) {
          console.warn(
            `[pollo] DOM không thấy ảnh mới dù API xác nhận record ${recordId} đã "succeed" — tải trực tiếp qua mediaUrl.`,
          );
          await fs.promises.mkdir(config.downloadDir, { recursive: true });
          const response = await fetchWithRetry(page, detail.mediaUrl);
          const ext = resolveDownloadExtension(response, detail.mediaUrl);
          const filePath = path.join(config.downloadDir, `${jobId}${ext}`);
          await fs.promises.writeFile(filePath, await response.body());
          return { filePaths: [filePath], polloResultId: detail.videoId };
        }
      }
      throw err;
    }
    const filePaths = await downloadResultImages(page, newCard, jobId);
    let polloResultId = await captureResultId(page, newCard);
    if (!polloResultId && recordId !== null) {
      const detail = await fetchGenerationRecordDetail(page, recordId);
      polloResultId = detail?.videoId ?? null;
    }
    return { filePaths, polloResultId };
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    throw err instanceof GenerationError
      ? err
      : new GenerationError(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close();
  }
}
