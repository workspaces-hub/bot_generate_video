import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config } from "../config";
import { getBrowserContext } from "./browser";
import {
  addCharacterRefButtonCandidates,
  addOmniReferenceButtonCandidates,
  addReferenceImageButtonCandidates,
  antModalCloseButtonLocator,
  antModalWrapperLocator,
  anyVideoInputModeChipCandidates,
  busyOmniReferenceThumbnailLocator,
  busyReferenceImageThumbnailLocator,
  characterDetectionFailedCandidates,
  confirmCharacterButtonCandidates,
  creditPaywallModalCandidates,
  deleteAllFailedButtonLocator,
  dropdownOptionCandidates,
  endFrameButtonCandidates,
  errorIndicatorCandidates,
  exactVideoInputModeChipCandidates,
  firstVisible,
  generateButtonCandidates,
  getOmniReferenceCount,
  getReferenceImageCount,
  historyVideoLocator,
  modelChipCandidates,
  openPopoverLocator,
  promptInputCandidates,
  resolutionChipCandidates,
  returnToLatestButtonCandidates,
  signInIndicatorCandidates,
  startFrameButtonCandidates,
} from "./selectors";

export class GenerationError extends Error {}

export const MAX_VIDEO_REF_IMAGES = 3;
// DOM thật xác nhận aria-label="Upload Refs (0/12)" — giới hạn thật là 12.
export const MAX_OMNI_REFERENCE_ITEMS = 12;

export interface GenerateVideoOptions {
  resolution?: string;
  model?: string;
  /** Ảnh start frame (tuỳ chọn) — nếu không có, tạo video thuần từ text như bình thường. */
  startFramePath?: string;
  /** Ảnh end frame (tuỳ chọn, chỉ có tác dụng khi dùng cùng startFramePath — mode "Start/End Frame"). */
  endFramePath?: string;
  /** Ảnh tham chiếu (tuỳ chọn, tối đa 3) — dùng trang riêng config.hailuoCreateVideoRefPath. */
  referenceImagePaths?: string[];
  /** Ảnh nhân vật (bắt buộc đúng 1 ảnh) — dùng mode "Character Reference". */
  characterImagePath?: string;
  /** File tham chiếu ảnh/video/audio (tuỳ chọn, tối đa 3) — dùng mode "Omni Reference". */
  omniReferencePaths?: string[];
}

export async function generateVideo(
  prompt: string,
  {
    resolution,
    model,
    startFramePath,
    endFramePath,
    referenceImagePaths = [],
    characterImagePath,
    omniReferencePaths = [],
  }: GenerateVideoOptions,
  jobId: string,
): Promise<string> {
  console.log({
    model,
    startFramePath,
    endFramePath,
    referenceImagePaths,
    characterImagePath,
    omniReferencePaths,
  });
  if (referenceImagePaths.length > MAX_VIDEO_REF_IMAGES) {
    throw new GenerationError(
      `Chỉ hỗ trợ tối đa ${MAX_VIDEO_REF_IMAGES} ảnh tham chiếu.`,
    );
  }
  if (omniReferencePaths.length > MAX_OMNI_REFERENCE_ITEMS) {
    throw new GenerationError(
      `Chỉ hỗ trợ tối đa ${MAX_OMNI_REFERENCE_ITEMS} file tham chiếu.`,
    );
  }

  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const usingReferenceImages = referenceImagePaths.length > 0;
    const usingCharacterReference = Boolean(characterImagePath);
    const usingOmniReference = omniReferencePaths.length > 0;
    // LUÔN dùng hailuoCreateVideoRefPath, kể cả cho job "Start/End Frame"
    // thường (không có ảnh/video/audio tham chiếu nào) — 2 lần xác nhận qua
    // debug HTML thật: (1) trang hailuoCreateVideoPath (trang tạo video
    // thường) — bấm chip mode KHÔNG mở popover chọn mode nào cả (chỉ có
    // .ant-popover-content rỗng từ CSS, không có option nào để chọn); (2) mode
    // là trạng thái STICKY theo tài khoản, không reset khi đổi URL — 1 job
    // Start/End Frame thường vẫn load ra trang hailuoCreateVideoPath đang kẹt
    // ở mode "Image Reference" còn sót từ job trước, và trên trang đó KHÔNG
    // có cách nào bấm quay lại "Start/End Frame" được. Trang
    // hailuoCreateVideoRefPath hỗ trợ đủ cả 4 mode (kể cả "Start/End Frame"
    // — mode mặc định của chính trang này), nên dùng trang này cho MỌI job
    // video, không phân biệt có dùng mode tham chiếu hay không.
    const url = new URL(
      usingOmniReference
        ? config.hailuoCreateVideoRefPath
        : config.hailuoCreateVideoPath,
      config.hailuoBaseUrl,
    ).toString();
    await gotoWithRetry(page, url);

    await ensureLoggedIn(page);
    await dismissPaywallIfBlocking(page);

    // gotoWithRetry chỉ chờ "domcontentloaded" — trang là SPA (React) nên
    // sau đó còn cần thời gian hydrate/render UI thật. Thực tế đã gặp: 20s
    // (4 candidate x 5s) không đủ với tài khoản có nhiều lịch sử/đang bật
    // Start-End Frame (thêm nút upload), khiến "#video-create-textarea"
    // chưa kịp render dù chỉ trễ thêm 1-2s. Chờ mạng rảnh trước, rồi mới
    // tìm ô nhập prompt với timeout dài hơn để có biên độ an toàn.
    await page
      .waitForLoadState("networkidle", { timeout: 120_000 })
      .catch(() => {});

    if (usingReferenceImages) {
      // Trang tạo video mặc định ở mode "Start/End Frame" — phải chuyển
      // sang mode "Image Reference" mới lộ ra khu vực upload ảnh tham chiếu
      // thật, xác nhận qua thao tác thủ công trên site (không phải phỏng
      // đoán selector).
      await switchVideoInputMode(page, "Image Reference", jobId);
      for (let i = 0; i < referenceImagePaths.length; i++) {
        await uploadVideoRefImage(page, referenceImagePaths[i], i + 1);
      }
      await waitForVideoRefImageUploadsToSettle(page);
    } else if (usingCharacterReference) {
      // Cùng cơ chế chuyển mode như Image Reference, nhưng chọn "Character
      // Reference" — do người dùng xác nhận trực tiếp qua thao tác thủ công
      // trên site. Popup "Subject Reference Terms of Use" (nếu có) đã được
      // xử lý BÊN TRONG switchVideoInputMode (xem confirmTermsPopupIfPresent).
      await switchVideoInputMode(page, "Character Reference", jobId);
      await uploadCharacterImage(page, characterImagePath!);
      await waitForCharacterDetection(page);
    } else if (usingOmniReference) {
      // Cùng cơ chế chuyển mode như Image Reference, nhưng chọn "Omni
      // Reference" — do người dùng yêu cầu, chấp nhận ảnh/video/audio làm
      // file tham chiếu (khác Image Reference chỉ nhận ảnh).
      await switchVideoInputMode(page, "Omni Reference", jobId);
      for (let i = 0; i < omniReferencePaths.length; i++) {
        await uploadOmniReferenceFile(page, omniReferencePaths[i], i + 1);
      }
      await waitForOmniReferenceUploadsToSettle(page);
    } else {
      // Mode là trạng thái STICKY theo tài khoản (không reset khi vào lại
      // trang) — 1 job không dùng mode tham chiếu nào vẫn có thể load ra
      // trang đang kẹt ở mode "Image/Character/Omni Reference" còn sót từ
      // job trước, khiến không tìm thấy nút upload start frame (nút đó chỉ
      // có ở mode "Start/End Frame"). Chủ động ép về đúng mode mặc định
      // trước khi làm gì khác — switchVideoInputMode tự bỏ qua (no-op) nếu
      // đã đúng mode. Chỉ hoạt động đúng vì giờ MỌI job video đều dùng
      // hailuoCreateVideoRefPath (trang duy nhất mode-switch thật sự hoạt
      // động, xem chú thích chọn url phía trên).
      await switchVideoInputMode(page, "Start/End Frame", jobId);
    }

    await dismissBlockingOverlays(page);
    const promptInput = await firstVisible(promptInputCandidates(page), 30_000);
    await clickDismissingModals(page, promptInput);
    await promptInput.fill(prompt);

    if (startFramePath) {
      await uploadStartFrame(page, startFramePath);
    }
    if (endFramePath) {
      await uploadEndFrame(page, endFramePath);
    }

    if (model) {
      await selectChipOption(page, modelChipCandidates(page), model, "model");
    }
    // if (resolution) {
    //   await selectChipOption(page, resolutionChipCandidates(page), resolution, "resolution");
    // }

    // await captureSnapshot(
    //   page,
    //   jobId + "-before-generate-click",
    //   "before-generate-click",
    // );

    // Chụp baseline TRƯỚC khi bấm Generate để sau đó biết chính xác video
    // nào là MỚI (không phải video cũ nhất trong lịch sử — xem waitForNewVideo).
    const baseline = await captureVideoBaseline(page);

    await dismissBlockingOverlays(page);

    // await captureSnapshot(
    //   page,
    //   jobId + "-before-generate-click",
    //   "before-generate-click",
    // );
    const generateButton = await firstVisible(generateButtonCandidates(page));
    await clickDismissingModals(page, generateButton);
    // Một số mode (đã xác nhận với "Character Reference") hiện popup Terms
    // of Use CẦN xác nhận (Confirm) mới thực sự bắt đầu generate — nghi vấn
    // "Omni Reference" cũng vậy: bấm Generate không lỗi gì nhưng không có
    // gì xảy ra (không "Creating...", không video mới) sau khi chờ hết
    // timeout. Thử xác nhận popup này (best-effort, không lỗi nếu không có).
    await confirmTermsPopupIfPresent(page);
    await captureSnapshot(
      page,
      jobId + "-after-generate-click",
      "after-generate-click",
    );

    const newVideo = await waitForNewVideo(
      page,
      baseline,
      config.generationTimeoutMs,
    );

    return await downloadVideo(page, newVideo, jobId);
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
 * Chờ thumbnail ảnh vừa upload (start/end frame) hết "aria-busy" trước khi
 * coi như upload xong — dùng chung cho cả uploadStartFrame và uploadEndFrame.
 * Thực tế xác nhận qua debug HTML: bấm Generate khi ảnh còn "aria-busy"
 * khiến site âm thầm từ chối bằng toast "Wait until picture upload
 * completes" (không khớp bất kỳ error indicator nào), khiến bot chờ vô ích
 * hết nguyên generationTimeoutMs (5 phút) rồi mới timeout.
 */
async function waitForFrameUploadToSettle(
  page: Page,
  label: string,
): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[aria-label="Uploaded image, click to preview"][aria-busy="true"]',
        ).length === 0,
      { timeout: 60_000 },
    );
  } catch {
    const stillBusy = await busyReferenceImageThumbnailLocator(page).count();
    if (stillBusy > 0) {
      throw new GenerationError(
        `Ảnh ${label} vẫn đang xử lý (aria-busy) sau 60s chờ — không bấm Generate để tránh bị site từ chối.`,
      );
    }
  }
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {});
}

/**
 * Upload ảnh "Start Frame" cho video (tuỳ chọn, người dùng yêu cầu rõ ràng
 * nên fail cứng nếu không tải lên được, thay vì âm thầm bỏ qua như
 * selectChipOption — khác model/resolution, start frame ảnh hưởng trực tiếp
 * tới nội dung video nên không thể để lặng lẽ tạo sai).
 */
async function uploadStartFrame(page: Page, imagePath: string): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    const button = await firstVisible(startFrameButtonCandidates(page), 8000);
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      clickDismissingModals(page, button),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);
  } catch (err) {
    throw new GenerationError(
      `Không tải được ảnh start frame lên — site có thể đã đổi giao diện upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await waitForFrameUploadToSettle(page, "start frame");
}

/**
 * Upload ảnh "End Frame" cho video — cùng cơ chế uploadStartFrame, chỉ khác
 * nút bấm (endFrameButtonCandidates). Gọi SAU uploadStartFrame (xem
 * generateVideo) — mode "Start/End Frame" yêu cầu upload start frame trước
 * mới thấy/dùng được nút End Frame trên 1 số phiên bản UI (chưa xác nhận
 * DOM thật, giữ đúng thứ tự gọi để an toàn).
 */
async function uploadEndFrame(page: Page, imagePath: string): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    const button = await firstVisible(endFrameButtonCandidates(page), 8000);
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      clickDismissingModals(page, button),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);
  } catch (err) {
    throw new GenerationError(
      `Không tải được ảnh end frame lên — site có thể đã đổi giao diện upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await waitForFrameUploadToSettle(page, "end frame");
}

/**
 * Chuyển mode nhập liệu video sang modeName (vd "Start/End Frame", "Image
 * Reference", "Character Reference", "Omni Reference") — bấm chip mở popover
 * rồi chọn option, cùng cơ chế popover đã dùng cho model/resolution
 * (dropdownOptionCandidates). Fail CỨNG nếu không chuyển được (khác
 * selectChipOption chỉ warn) vì bước upload ảnh ngay sau đó chắc chắn sai
 * nếu bỏ qua bước này.
 *
 * Site NHỚ mode đã chọn ở lần trước (sticky qua account, không reset khi vào
 * lại trang) — thực tế xác nhận: 1 job không yêu cầu mode tham chiếu nào vẫn
 * load ra trang đang ở mode "Image Reference" còn sót từ job trước đó. Vì
 * vậy hàm này: (1) không giả định trạng thái ban đầu là "Start/End Frame" —
 * dùng anyVideoInputModeChipCandidates để bấm mở popover bất kể chip đang
 * hiện nhãn nào; (2) bỏ qua ngay (no-op) nếu trang đã sẵn đúng modeName cần
 * dùng, tránh mở popover rồi lỡ chọn nhầm option khác.
 */
/**
 * page.getByText(...)/getByRole(...) khớp CẢ 1 bản sao ẩn NGOÀI VIEWPORT của
 * chip mode — xác nhận qua log boundingBox() thật: y luôn = -6078.125 GIỐNG
 * HỆT nhau ở NHIỀU job/lần chạy khác nhau (đã thử cả ép scrollTop=0 vẫn y
 * hệt), tức đây KHÔNG phải do cuộn/scroll mà là 1 phần tử cố định nằm ngoài
 * màn hình do CSS (nghi vấn: bản sao dùng để ĐO độ rộng text trước khi định
 * vị chip thật — kỹ thuật phổ biến ở component tự co giãn theo nội dung).
 * .first() trong firstVisible() luôn khớp trúng bản sao ẩn này thay vì chip
 * thật đang hiện cho user thấy. Duyệt HẾT các phần tử khớp text, chỉ lấy
 * phần tử có boundingBox thực sự nằm trong viewport.
 */
async function findOnscreenLocator(
  candidates: Array<() => Locator>,
  page: Page,
): Promise<Locator | null> {
  const viewport = page.viewportSize();
  const maxWidth = viewport?.width ?? 2000;
  const maxHeight = viewport?.height ?? 2000;
  for (const make of candidates) {
    const locator = make();
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const box = await candidate.boundingBox().catch(() => null);
      if (
        box &&
        box.width > 0 &&
        box.height > 0 &&
        box.x >= 0 &&
        box.x < maxWidth &&
        box.y >= 0 &&
        box.y < maxHeight
      ) {
        // boundingBox() khác 0 KHÔNG loại được trường hợp phần tử đang bị ẩn
        // qua CSS visibility:hidden (vẫn chiếm layout, vẫn có toạ độ hợp lệ,
        // chỉ không hiện ra) — kỹ thuật phổ biến khi 1 popover/option ĐÃ ĐÓNG
        // nhưng còn animation fade-out nên chưa unmount khỏi DOM ngay. Đây là
        // nghi vấn chính cho case "đang ở Start/End Frame nhưng vẫn khớp
        // 'Omni Reference'" — rất có thể là 1 OPTION còn sót trong popover cũ
        // đã đóng, không phải chip thật. isVisible() có kiểm tra visibility,
        // boundingBox không kiểm tra, nên cần cả 2 điều kiện.
        const isVisible = await candidate.isVisible().catch(() => false);
        // Loại thẳng nếu phần tử nằm BÊN TRONG 1 popover (kể cả đã đóng
        // nhưng chưa unmount) — option trong popover dùng đúng kiểu dáng
        // cursor-pointer + icon giống hệt chip thật, nên đây là nghi vấn
        // chính gây khớp nhầm.
        const insidePopover = await candidate
          .evaluate((el) => Boolean(el.closest(".ant-popover-content")))
          .catch(() => false);
        if (isVisible && !insidePopover) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/** Poll findOnscreenLocator tới khi tìm được hoặc hết timeoutMs. */
async function pollForOnscreenLocator(
  candidates: Array<() => Locator>,
  page: Page,
  timeoutMs: number,
): Promise<Locator | null> {
  const start = Date.now();
  do {
    const found = await findOnscreenLocator(candidates, page);
    if (found) return found;
    await page.waitForTimeout(300);
  } while (Date.now() - start < timeoutMs);
  return null;
}

async function switchVideoInputMode(
  page: Page,
  modeName: string,
  jobId: string,
): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    const alreadyMatchedChip = await pollForOnscreenLocator(
      exactVideoInputModeChipCandidates(page, modeName),
      page,
      2000,
    );
    if (alreadyMatchedChip) {
      // Log RÕ phần tử khớp — thực tế xác nhận (user báo trực tiếp): có lúc
      // trang đang hiện "Start/End Frame" thật nhưng check alreadyInTargetMode
      // cho mode "Omni Reference" vẫn trả về true, nghĩa là 1 phần tử KHÁC
      // (không phải chip thật) cũng thoả structure div.cursor-pointer + có
      // svg + đúng text. Log outerHTML để biết chính xác đó là phần tử gì.
      const outerHtml = await alreadyMatchedChip
        .evaluate((el) => el.outerHTML.slice(0, 500))
        .catch((err) => `<lỗi đọc outerHTML: ${err}>`);
      // console.warn(
      //   `[hailuo] switchVideoInputMode(${modeName}): alreadyInTargetMode=true, phần tử khớp outerHTML=`,
      //   outerHtml,
      // );
      return;
    }

    // Bấm chip đôi khi KHÔNG mở popover (đã xác nhận qua debug HTML thực tế
    // NHIỀU LẦN: click chạy xong không lỗi gì, nhưng .ant-popover-content
    // không hề xuất hiện trong DOM — kể cả khi screenshot cho thấy trang
    // đang ở trạng thái sạch, không popup/overlay nào che). Nghi vấn: trang
    // vừa chuyển sang (SPA) nên phần tử đã RENDER (nhìn thấy) nhưng React
    // chưa kịp HYDRATE xong (gắn xong event handler) tại đúng thời điểm
    // click — chờ 1 chút TRƯỚC lần bấm đầu tiên để giảm khả năng đua với
    // hydration, và chờ lâu hơn sau mỗi lần bấm trước khi kết luận popover
    // không mở. Xác nhận CHỦ ĐỘNG popover đã mở trước khi tìm option, thử
    // bấm lại vài lần nếu chưa — để báo lỗi đúng nguyên nhân (popover không
    // mở) thay vì lỗi gây hiểu lầm là "option sai text".
    await page.waitForTimeout(1500);

    const maxClickAttempts = 3;
    let popoverOpened = false;
    for (
      let attempt = 1;
      attempt <= maxClickAttempts && !popoverOpened;
      attempt++
    ) {
      const chip = await pollForOnscreenLocator(
        anyVideoInputModeChipCandidates(page),
        page,
        8000,
      );
      if (!chip) {
        throw new Error(
          `Không tìm thấy chip đổi mode nào đang hiển thị trong viewport (lần thử ${attempt})`,
        );
      }
      // await captureSnapshot(
      //   page,
      //   jobId + `-mode-before-click-${attempt}`,
      //   `mode-before-click-${attempt}`,
      // );
      // Log toạ độ thật của chip lúc click — nếu boundingBox null/lệch bất
      // thường (vd bị 0 width/height do 1 layout race chưa lộ ra trong
      // screenshot tĩnh chụp cùng lúc), đây là bằng chứng trực tiếp thay vì
      // đoán mò tiếp qua ảnh chụp (vốn luôn "trông bình thường" các lần trước).
      const box = await chip.boundingBox().catch(() => null);
      const outerHtml = await chip
        .evaluate((el) => el.outerHTML.slice(0, 500))
        .catch((err) => `<lỗi đọc outerHTML: ${err}>`);
      // console.warn(
      //   `[hailuo] switchVideoInputMode(${modeName}) attempt ${attempt}: chip boundingBox=`,
      //   box,
      //   "outerHTML=",
      //   outerHtml,
      // );
      // Rê chuột qua trước rồi mới bấm (tách riêng, không chỉ để .click() tự
      // làm) — 1 số popover chỉ "arm" sau mousemove/mouseenter thật, và click
      // ngay sau khi vừa hydrate có thể bị bỏ lỡ nếu chưa có bước hover riêng.
      await chip.hover().catch(() => {});
      await page.waitForTimeout(200);
      await clickDismissingModals(page, chip);
      popoverOpened = await firstVisible([() => openPopoverLocator(page)], 6000)
        .then(() => true)
        .catch(() => false);
      if (!popoverOpened) {
        await dismissBlockingOverlays(page);
      }
    }

    // Chụp debug ngay khi popover vừa mở (TRƯỚC khi chọn option) — nếu bước
    // sau vẫn lỗi, đây là bằng chứng trực tiếp để biết text option thật là
    // gì, thay vì đoán mò.
    // await captureSnapshot(
    //   page,
    //   jobId + "-mode-popover-open",
    //   "mode-popover-open",
    // );

    if (!popoverOpened) {
      throw new Error(
        `Đã bấm chip đổi mode (thử ${maxClickAttempts} lần) nhưng popover không mở ra — có thể click bị lỡ nhịp do site đang animation`,
      );
    }

    const option = await firstVisible(
      dropdownOptionCandidates(page, modeName),
      5000,
    );
    await clickWithForceFallback(option);
    await page.waitForTimeout(500);

    // Chọn "Character Reference" hiện popup "Subject Reference Terms of
    // Use" NGAY SAU ĐÓ (label mode chưa đổi tới khi popup này được xác
    // nhận) — PHẢI xử lý popup này TRƯỚC khi kiểm tra mode đã đổi chưa bên
    // dưới, nếu không sẽ báo lỗi sai "mode chưa đổi" trong khi thực ra chỉ
    // đang chờ xác nhận popup, không phải chọn sai option.
    await confirmTermsPopupIfPresent(page);

    // dropdownOptionCandidates có candidate fallback KHÔNG scope vào popover
    // (tìm cả trang) — có thể "click thành công" vào phần tử không liên
    // quan mà không báo lỗi gì, trong khi mode thực ra KHÔNG đổi. Xác nhận
    // lại chip đã thực sự đổi sang ĐÚNG modeName mong muốn, báo lỗi rõ ràng
    // nếu không, thay vì để lộ ra thành lỗi khó hiểu ở bước upload sau đó.
    const switchedChip = await pollForOnscreenLocator(
      exactVideoInputModeChipCandidates(page, modeName),
      page,
      5000,
    );
    if (switchedChip) {
      const outerHtml = await switchedChip
        .evaluate((el) => el.outerHTML.slice(0, 500))
        .catch((err) => `<lỗi đọc outerHTML: ${err}>`);
      // console.warn(
      //   `[hailuo] switchVideoInputMode(${modeName}): switchedOk=true, phần tử khớp outerHTML=`,
      //   outerHtml,
      // );
    }
    const switchedOk = Boolean(switchedChip);
    if (!switchedOk) {
      throw new Error(
        `Đã bấm option "${modeName}" nhưng chip vẫn chưa đổi sang đúng nhãn này — có thể chưa khớp đúng text option thật`,
      );
    }
  } catch (err) {
    throw new GenerationError(
      `Không chuyển được sang chế độ "${modeName}" — site có thể đã đổi giao diện: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Upload ảnh nhân vật cho mode "Character Reference" — cùng cơ chế/selector
 * upload ảnh dùng chung với Image Reference (addReferenceImageButtonCandidates).
 * Chỉ đúng 1 ảnh (bắt buộc), khác Image Reference cho phép tối đa 3.
 */
async function uploadCharacterImage(
  page: Page,
  imagePath: string,
): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    await attemptUploadCharacterImage(page, imagePath);
  } catch (err) {
    // console.warn(
    //   "[hailuo] Upload ảnh nhân vật lần đầu thất bại, thử đóng popup rồi thử lại:",
    //   err,
    // );
    await dismissBlockingOverlays(page);
    await attemptUploadCharacterImage(page, imagePath);
  }
}

async function attemptUploadCharacterImage(
  page: Page,
  imagePath: string,
): Promise<void> {
  try {
    const addButton = await firstVisible(
      addCharacterRefButtonCandidates(page),
      8000,
    );
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      clickDismissingModals(page, addButton),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);
  } catch (err) {
    throw new GenerationError(
      `Không tải được ảnh nhân vật lên — site có thể đã đổi giao diện upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Chọn mode "Character Reference" (trong switchVideoInputMode, TRƯỚC cả
 * bước upload ảnh) hiện popup Ant Design "Subject Reference Terms of Use"
 * dùng CÙNG nút "Confirm" — xác nhận qua thao tác thủ công trên site. Popup
 * này có thể xuất hiện SAU MỘT LÚC chứ không phải ngay lập tức, nên phải
 * CHỜ (poll qua firstVisible), không kiểm tra 1 lần rồi bỏ qua như bản
 * trước (isVisible không tự chờ, chỉ kiểm tra tức thời — sai với ý cần chờ
 * ở đây). Best-effort: không coi là lỗi nếu không thấy (popup có thể không
 * phải lúc nào cũng xuất hiện, vd với "Image Reference").
 */
/** Trả về true nếu THỰC SỰ tìm thấy và bấm được nút Confirm (best-effort, không throw). */
async function confirmTermsPopupIfPresent(
  page: Page,
  timeoutMs = 15_000,
): Promise<boolean> {
  const confirmButton = await firstVisible(
    confirmCharacterButtonCandidates(page),
    timeoutMs,
  ).catch(() => null);
  if (!confirmButton) return false;

  const isEnabled = await confirmButton.isEnabled().catch(() => false);
  if (isEnabled) {
    await confirmButton.click().catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/**
 * Sau khi upload ảnh nhân vật, site cần vài giây để nhận diện (character
 * detection) trước khi cho generate — do người dùng xác nhận trực tiếp qua
 * thao tác thủ công trên site. Poll tới khi 1 trong 2 điều xảy ra:
 * (a) text lỗi "No person detected"/"Change Characters" xuất hiện → không
 * nhận diện được nhân vật, báo lỗi rõ ràng thay vì tiếp tục generate sai;
 * (b) nút "Confirm" hết disabled (bấm được) → bấm để xác nhận rồi tiếp tục.
 */
async function waitForCharacterDetection(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  const pollIntervalMs = 2000;

  while (Date.now() - start < timeoutMs) {
    const failed = await firstVisible(
      characterDetectionFailedCandidates(page),
      500,
    )
      .then(() => true)
      .catch(() => false);
    if (failed) {
      throw new GenerationError("No person detected");
    }

    const confirmButton = confirmCharacterButtonCandidates(page)[0]().first();
    const isVisible = await confirmButton.isVisible().catch(() => false);
    const isEnabled =
      isVisible && (await confirmButton.isEnabled().catch(() => false));
    if (isEnabled) {
      await confirmButton.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(
    `Hết thời gian chờ nhận diện nhân vật (timeout ${timeoutMs}ms) — nút Confirm không bấm được và cũng không thấy lỗi "No person detected".`,
  );
}

/**
 * Upload 1 ảnh tham chiếu (trang /create/subject-reference-to-video, tối đa
 * 3 ảnh) — cùng cơ chế/selector với ảnh tham chiếu của tính năng tạo ảnh
 * (addReferenceImageButtonCandidates/getReferenceImageCount), vì đây cũng là
 * upload ảnh, chỉ khác trang. Retry 1 lần nếu lần đầu thất bại (có thể do
 * popup quảng cáo bật ra đúng lúc).
 *
 * Thực tế xác nhận qua debug screenshot: popup "MiniMax Hub" che gần kín
 * trang NGAY TỪ ĐẦU — khiến bước tìm nút upload timeout ngay ở khâu tìm
 * locator, chưa kịp click nên clickDismissingModals (chỉ đóng modal khi
 * CLICK bị chặn) không có cơ hội chạy. Phải đóng popup CHỦ ĐỘNG trước khi
 * tìm nút — xem dismissBlockingOverlays().
 */
async function uploadVideoRefImage(
  page: Page,
  imagePath: string,
  expectedCountAfter: number,
): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    await attemptUploadVideoRefImage(page, imagePath, expectedCountAfter);
  } catch (err) {
    // console.warn(
    //   "[hailuo] Upload ảnh tham chiếu lần đầu thất bại, thử đóng popup rồi thử lại:",
    //   err,
    // );
    await dismissBlockingOverlays(page);
    await attemptUploadVideoRefImage(page, imagePath, expectedCountAfter);
  }
}

async function attemptUploadVideoRefImage(
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

/**
 * Cùng lý do đã sửa cho start frame (xem uploadStartFrame): thumbnail ảnh
 * tham chiếu vẫn còn "aria-busy" một lúc sau khi upload — đợi hết busy
 * trước khi bấm Generate để tránh bị site âm thầm từ chối.
 */
async function waitForVideoRefImageUploadsToSettle(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {});

  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[aria-label="Uploaded image, click to preview"][aria-busy="true"]',
        ).length === 0,
      { timeout: 60_000 },
    );
  } catch {
    const stillBusy = await busyReferenceImageThumbnailLocator(page).count();
    if (stillBusy > 0) {
      throw new GenerationError(
        `Còn ${stillBusy} ảnh tham chiếu vẫn đang xử lý (aria-busy) sau 60s chờ — không bấm Generate để tránh dùng ảnh chưa load xong.`,
      );
    }
  }
}

/**
 * Upload 1 file tham chiếu (ảnh/video/audio) cho mode "Omni Reference" —
 * cùng cơ chế OS file-picker với Image/Character Reference. Retry 1 lần nếu
 * lần đầu thất bại (có thể do popup quảng cáo bật ra đúng lúc).
 */
async function uploadOmniReferenceFile(
  page: Page,
  filePath: string,
  expectedCountAfter: number,
): Promise<void> {
  await dismissBlockingOverlays(page);
  try {
    await attemptUploadOmniReferenceFile(page, filePath, expectedCountAfter);
  } catch (err) {
    // console.warn(
    //   "[hailuo] Upload file tham chiếu lần đầu thất bại, thử đóng popup rồi thử lại:",
    //   err,
    // );
    await dismissBlockingOverlays(page);
    await attemptUploadOmniReferenceFile(page, filePath, expectedCountAfter);
  }
}

async function attemptUploadOmniReferenceFile(
  page: Page,
  filePath: string,
  expectedCountAfter: number,
): Promise<void> {
  try {
    // "Omni Reference Guide" (Terms of Use riêng cho mode này) dùng CHUNG 1
    // cấu trúc Ant Design modal chuẩn với "Subject Reference Terms of Use"
    // của Character Reference (ant-modal-wrap + nút Confirm) — xác nhận qua
    // debug HTML thật, chỉ khác nội dung/tiêu đề. Khác Character Reference
    // (popup hiện ngay sau khi CHỌN MODE, đã xử lý trong switchVideoInputMode),
    // popup này hiện khi bấm nút "Upload Refs" — xác nhận CHỦ ĐỘNG trước
    // (best-effort, không lỗi nếu không có) để tránh phí 10s chờ filechooser
    // vô ích nếu modal đã che sẵn nút upload từ trước.
    await confirmTermsPopupIfPresent(page, 2000);

    const addButton = await firstVisible(
      addOmniReferenceButtonCandidates(page),
      8000,
    );

    // Trường hợp popup CHỈ xuất hiện SAU khi bấm (chưa từng bấm lần nào nên
    // check chủ động ở trên không thấy gì) — nếu chờ filechooser timeout,
    // thử xác nhận popup rồi bấm lại nút upload 1 lần nữa.
    let fileChooser;
    try {
      [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        clickDismissingModals(page, addButton),
      ]);
    } catch (err) {
      const confirmed = await confirmTermsPopupIfPresent(page, 3000);
      if (!confirmed) throw err;

      const addButtonAgain = await firstVisible(
        addOmniReferenceButtonCandidates(page),
        8000,
      );
      [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        clickDismissingModals(page, addButtonAgain),
      ]);
    }

    await fileChooser.setFiles(filePath);
    await page.waitForTimeout(1500);

    // Cùng quy ước aria-label "(N/M)" đã xác nhận với ảnh tham chiếu — best
    // effort, chỉ so sánh nếu đọc được số (không throw nếu format khác).
    const currentCount = await getOmniReferenceCount(page);
    if (currentCount !== null && currentCount < expectedCountAfter) {
      throw new Error(
        `Site chưa ghi nhận file vừa upload (đếm hiện tại: ${currentCount}/${expectedCountAfter} kỳ vọng)`,
      );
    }
  } catch (err) {
    throw new GenerationError(
      `Không tải được file tham chiếu lên — site có thể đã đổi giao diện upload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Cùng lý do đã sửa cho start frame/Image Reference: thumbnail file tham
 * chiếu (ảnh/video/audio) nhiều khả năng vẫn còn "aria-busy" một lúc sau khi
 * upload — đợi hết busy trước khi bấm Generate.
 */
/**
 * Thumbnail chỉ có tín hiệu nhị phân (aria-busy true/false), không có %
 * tiến độ như lúc generate video — nên không thể biết "đang xử lý bình
 * thường, chỉ chậm" hay "đã kẹt hẳn" chỉ bằng 1 lần chờ dài. Poll định kỳ,
 * theo dõi SỐ FILE còn busy: nếu con số này KHÔNG đổi trong
 * stuckThresholdMs liên tiếp (thực tế xác nhận: 1 video kẹt "aria-busy"
 * suốt 600s không hề nhúc nhích), coi là kẹt thật và báo lỗi ngay — thay vì
 * luôn chờ hết nguyên timeoutMs dù rõ ràng không còn tiến triển gì. Nếu số
 * file busy có giảm dần theo thời gian (nhiều file, xong dần từng cái) thì
 * vẫn tiếp tục chờ bình thường tới hết timeoutMs.
 */
async function waitForOmniReferenceUploadsToSettle(
  page: Page,
  timeoutMs = 600_000,
  stuckThresholdMs = 240_000,
): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {});

  const pollIntervalMs = 15_000;
  const start = Date.now();
  let lastBusyCount = await busyOmniReferenceThumbnailLocator(page).count();
  let lastChangeAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (lastBusyCount === 0) return;

    if (Date.now() - lastChangeAt >= stuckThresholdMs) {
      throw new GenerationError(
        `Còn ${lastBusyCount} file tham chiếu vẫn đang xử lý (aria-busy) và KHÔNG có tiến triển gì trong ${Math.round(stuckThresholdMs / 60_000)} phút liên tiếp — site có thể đã kẹt khi xử lý file này, không bấm Generate để tránh dùng file chưa load xong.`,
      );
    }

    await page.waitForTimeout(pollIntervalMs);
    const currentBusyCount =
      await busyOmniReferenceThumbnailLocator(page).count();
    if (currentBusyCount !== lastBusyCount) {
      lastBusyCount = currentBusyCount;
      lastChangeAt = Date.now();
    }
  }

  const stillBusy = await busyOmniReferenceThumbnailLocator(page).count();
  if (stillBusy > 0) {
    throw new GenerationError(
      `Còn ${stillBusy} file tham chiếu vẫn đang xử lý (aria-busy) sau ${Math.round(timeoutMs / 60_000)} phút chờ — không bấm Generate để tránh dùng file chưa load xong.`,
    );
  }
}

/**
 * Bấm 1 chip (model/resolution) để mở dropdown, rồi chọn option có text
 * khớp với giá trị mong muốn. Không throw nếu không tìm thấy — chỉ log
 * cảnh báo và giữ nguyên lựa chọn mặc định của site, để 1 chip lỗi không
 * làm hỏng cả job (video vẫn tạo được, chỉ sai model/resolution).
 * Xuất ra để hailuoImage.ts (tạo ảnh) dùng lại — cùng cơ chế chip/dropdown.
 */
export async function selectChipOption(
  page: Page,
  chipCandidates: Array<() => Locator>,
  targetText: string,
  label: string,
): Promise<void> {
  try {
    const chip = await firstVisible(chipCandidates, 3000);
    await clickDismissingModals(page, chip);

    const option = await firstVisible(
      dropdownOptionCandidates(page, targetText),
      3000,
    );
    await clickWithForceFallback(option);
  } catch (err) {
    // console.warn(
    //   `[hailuo] Không chọn được ${label} "${targetText}", dùng mặc định của site:`,
    //   err,
    // );
  }
}

/**
 * Rớt kết nối tạm thời qua proxy (net::ERR_TIMED_OUT, ERR_CONNECTION_*) khá
 * phổ biến khi chạy qua proxy — thử lại vài lần trước khi báo lỗi hẳn, thay
 * vì fail job ngay ở lần đầu.
 */
/** Xuất ra để hailuoImage.ts (tạo ảnh) dùng lại — cùng site, cùng vấn đề mạng/proxy. */
export async function gotoWithRetry(
  page: Page,
  url: string,
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      return;
    } catch (err) {
      lastErr = err;
      // console.warn(
      //   `[hailuo] page.goto lỗi (lần ${attempt}/${attempts}):`,
      //   err instanceof Error ? err.message : err,
      // );
      if (attempt < attempts) {
        await page.waitForTimeout(3000);
      }
    }
  }
  throw lastErr;
}

/**
 * File media (video/ảnh) vừa generate xong đôi khi CDN chưa kịp đồng bộ
 * object, trả về HTTP 404 dù URL trích xuất từ trang chi tiết là ĐÚNG (đã
 * xác nhận thực tế: feedId trong URL khớp đúng với ảnh đang tải, không phải
 * lỗi lấy nhầm URL) — thử lại vài lần trước khi báo lỗi hẳn, thay vì fail
 * job ngay ở lần đầu.
 */
export async function fetchWithRetry(
  page: Page,
  url: string,
  attempts = 4,
  delayMs = 5000,
): Promise<import("playwright").APIResponse> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // timeout: 0 = tắt hẳn giới hạn thời gian (cùng lý do đã sửa cho tải ảnh
    // GPT ở chatgptImage.ts, job e887e23c) — video dung lượng lớn qua mạng
    // VPS chậm không nên bị huỷ giữa chừng chỉ vì quá 30s mặc định.
    const response = await page.context().request.get(url, { timeout: 0 });
    if (response.ok()) return response;
    lastStatus = response.status();
    // console.warn(
    //   `[hailuo] Tải file lỗi HTTP ${lastStatus} (lần ${attempt}/${attempts}): ${url}`,
    // );
    if (attempt < attempts) {
      await page.waitForTimeout(delayMs);
    }
  }
  throw new GenerationError(
    `Tải file thất bại sau ${attempts} lần thử: HTTP ${lastStatus}`,
  );
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
    await antModalCloseButtonLocator(page)
      .first()
      .click()
      .catch(() => {});
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
export async function clickDismissingModals(
  page: Page,
  locator: Locator,
  timeoutMs = 15_000,
): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (err) {
    const dismissed = await dismissAntModalIfPresent(page);
    if (!dismissed) throw err;
    await locator.click({ timeout: timeoutMs });
  }
}

/**
 * Đóng CHỦ ĐỘNG mọi popup/modal đang che trang — gọi TRƯỚC khi tìm phần tử
 * (firstVisible), không đợi thao tác thất bại mới đóng như
 * clickDismissingModals. Thực tế xác nhận: popup "MiniMax Hub" có thể che
 * kín trang NGAY TỪ ĐẦU, khiến bước TÌM phần tử (firstVisible) timeout
 * trước khi kịp click — lúc đó clickDismissingModals không có cơ hội chạy
 * vì nó chỉ phản ứng khi CLICK bị chặn, không giúp gì nếu chưa tìm được
 * phần tử để click. Nên gọi hàm này trước MỌI bước quan trọng: tìm ô nhập
 * prompt, tìm nút upload ảnh, tìm nút Generate.
 *
 * Xử lý cả 2 dạng popup đã gặp: modal Ant Design chuẩn (.ant-modal-wrap, có
 * nút .ant-modal-close — dismissAntModalIfPresent) VÀ popup tuỳ biến không
 * theo chuẩn Ant Design (không có class trên, chỉ có nút mang tên "close"
 * chung hoặc lắng nghe phím Escape).
 *
 * Cũng ép khung lịch sử (#create-new-scroll-container) về đúng vị trí "mới
 * nhất" — DOM thật xác nhận container này dùng flex-col-reverse (thứ tự DOM
 * đảo ngược, "mới nhất" nằm ở scrollTop=0), và tài khoản test có RẤT NHIỀU
 * lịch sử. Thực tế xác nhận qua log boundingBox() thật: chip mode có lúc
 * boundingBox.y = -6078 (lệch khỏi viewport hơn 6000px, y hệt nhau qua cả 3
 * lần thử) — nghĩa là trang đang cuộn sâu vào lịch sử cũ, và .click() của
 * Playwright (vốn tự scrollIntoView) KHÔNG tự sửa được vị trí này (nghi do
 * bug scrollIntoView với flex-col-reverse ở nhiều engine trình duyệt). Set
 * thẳng scrollTop=0 bằng JS đáng tin cậy hơn nhiều so với chỉ bấm nút
 * "Return to Latest" (nút này không phải lúc nào cũng hiện/tìm được).
 */
export async function dismissBlockingOverlays(page: Page): Promise<void> {
  await dismissAntModalIfPresent(page);

  await page.keyboard.press("Escape").catch(() => {});
  const closeButton = page
    .getByRole("button", { name: /^(close|got it)$/i })
    .first();
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  await page
    .evaluate(() => {
      const container = document.querySelector<HTMLElement>(
        "#create-new-scroll-container",
      );
      if (container) container.scrollTop = 0;
    })
    .catch(() => {});

  const returnToLatestButton = await firstVisible(
    returnToLatestButtonCandidates(page),
    500,
  ).catch(() => null);
  if (returnToLatestButton) {
    await clickDismissingModals(page, returnToLatestButton).catch(() => {});
    // Bấm "Return to Latest" cuộn lịch sử về cuối có animation — chờ layout
    // ổn định trước khi trả về, tránh thao tác NGAY SAU đó (vd bấm chip mode)
    // nhắm vào toạ độ cũ lúc còn đang cuộn.
    await page.waitForTimeout(800);
  }
}

/**
 * Một số banner/ảnh quảng cáo động (vd "activity banner") nằm đè lên danh
 * sách option trong popover và liên tục thay đổi vị trí — khiến Playwright
 * coi phần tử đích là "not stable"/bị che, click thường không bao giờ qua
 * được. Fallback: bấm thẳng vào toạ độ phần tử (force), bỏ qua các kiểm tra
 * ổn định/che khuất của Playwright.
 */
async function clickWithForceFallback(
  locator: Locator,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: timeoutMs, force: true });
  }
}

export async function ensureLoggedIn(page: Page): Promise<void> {
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
export async function dismissPaywallIfBlocking(page: Page): Promise<void> {
  const visible = await firstVisible(creditPaywallModalCandidates(page), 2000)
    .then(() => true)
    .catch(() => false);
  if (!visible) return;

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const stillVisible = await firstVisible(
    creditPaywallModalCandidates(page),
    2000,
  )
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
  /** Số nút "Delete All Failed" đang hiện SẴN trong lịch sử (từ các job cũ) — dùng để phát hiện lỗi MỚI, xem waitForNewVideo. */
  failedMarkerCount: number;
}

async function captureVideoBaseline(page: Page): Promise<VideoBaseline> {
  const videos = historyVideoLocator(page);
  const count = await videos.count();
  return {
    count,
    firstSrc: count > 0 ? await videos.first().getAttribute("src") : null,
    lastSrc: count > 0 ? await videos.last().getAttribute("src") : null,
    failedMarkerCount: await deleteAllFailedButtonLocator(page).count(),
  };
}

/**
 * Chờ tới khi có video MỚI xuất hiện trong lịch sử (count tăng so với
 * baseline), rồi tự phát hiện video mới nằm ở đầu hay cuối danh sách bằng
 * cách so sánh src với baseline — không giả định cố định .first()/.last().
 *
 * Card generate LỖI KHÔNG bao giờ có thẻ <video> (chỉ icon placeholder
 * chung) — nên count <video> KHÔNG BAO GIỜ tăng khi job thất bại, khiến
 * trước đây phải đợi hết nguyên timeoutMs (vd 10 phút) mới báo lỗi, dù
 * errorIndicatorCandidates (toast) có thể đã trôi qua mất trước khi bot kịp
 * poll tới. DOM thật do người dùng cung cấp trực tiếp xác nhận: card lỗi
 * luôn kèm nút "Delete All Failed" (deleteAllFailedButtonLocator) — đáng tin
 * cậy hơn data-batch-disabled/aria-disabled (những marker đó dùng chung cho
 * cả đang xử lý). So sánh SỐ LƯỢNG nút này với baseline (không phải chỉ
 * "có tồn tại hay không") để tránh báo nhầm lỗi cũ có sẵn từ trước trong
 * lịch sử — chỉ coi là lỗi MỚI khi số lượng TĂNG so với lúc bắt đầu job.
 */
async function waitForNewVideo(
  page: Page,
  baseline: VideoBaseline,
  timeoutMs: number,
): Promise<Locator> {
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

    const currentFailedMarkerCount =
      await deleteAllFailedButtonLocator(page).count();
    if (currentFailedMarkerCount > baseline.failedMarkerCount) {
      throw new GenerationError(
        'Website báo lỗi khi tạo video (card mới xuất hiện với nút "Delete All Failed") — không cần đợi hết timeout',
      );
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new GenerationError(
    `Hết thời gian chờ tạo video (timeout ${timeoutMs}ms)`,
  );
}

/**
 * Tải video KHÔNG watermark: click vào video trong lịch sử để chuyển sang
 * trang chi tiết → hover nút dropdown (icon download) để mở popup → chọn
 * "Remove watermark" → bắt sự kiện download của Playwright để lưu file.
 * (Trước đây fetch thẳng attribute src của thẻ <video> — bản đó có watermark.)
 */
/** Xuất ra để scripts/download-last-video.ts dùng lại đúng logic tải video không watermark. */
export async function downloadVideo(
  page: Page,
  video: Locator,
  jobId: string,
): Promise<string> {
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
  const filePath = path.join(config.downloadDir, `${jobId}.mp4`);

  // Click vào video/card để "chuyển trang" không đáng tin cậy (thẻ <video>
  // chặn click bằng play/pause, card wrapper không phải lúc nào cũng đúng
  // phần tử điều hướng). Trang chi tiết có URL cố định dạng
  // /my-work-detail/ai-video/<id>?source-page=create, với <id> chính là
  // data-feed-id của card — nên điều hướng thẳng bằng goto, bỏ qua click.
  const card = video.locator("xpath=ancestor::div[@data-feed-id][1]");
  const feedId = await card
    .first()
    .getAttribute("data-feed-id")
    .catch(() => null);
  if (!feedId) {
    throw new GenerationError(
      "Không lấy được id video (data-feed-id) để mở trang chi tiết tải xuống",
    );
  }

  const detailUrl = new URL(
    `/my-work-detail/ai-video/${feedId}`,
    config.hailuoBaseUrl,
  );
  detailUrl.searchParams.set("source-page", "create");
  await gotoWithRetry(page, detailUrl.toString());

  // gotoWithRetry chỉ chờ domcontentloaded — trang chi tiết là SPA, có lúc
  // vẫn còn màn hình loading trống khi đọc page.content() ngay (đã xác nhận
  // qua debug screenshot ở luồng tạo ảnh dùng chung hàm gotoWithRetry này).
  // Chờ tới khi flight data thật sự xuất hiện trong DOM trước khi trích xuất.
  await page
    .waitForFunction(
      () =>
        document.documentElement.innerHTML.includes(
          "downloadURLWithoutWatermark",
        ),
      {
        timeout: 600_000,
      },
    )
    .catch(() => {});

  // Trang chi tiết nhúng sẵn URL không watermark ngay trong dữ liệu Next.js
  // flight data (self.__next_f.push(...)) của chính trang, dạng
  // downloadURLWithoutWatermark — đáng tin cậy hơn nhiều so với hover/click
  // dropdown (site có thể đổi UI dropdown, nhưng field data này ổn định
  // hơn vì là dữ liệu thô, không phải giao diện).
  const flightData = await getFlightDataText(page);
  const noWatermarkUrl = extractDownloadUrlWithoutWatermark(flightData, feedId);
  // console.log(`Đã tìm thấy URL không watermark: ${noWatermarkUrl}`);

  const response = await fetchWithRetry(page, noWatermarkUrl);
  await fs.promises.writeFile(filePath, await response.body());
  return filePath;
}

/**
 * Next.js stream flight data qua NHIỀU lần self.__next_f.push(...), mỗi lần
 * nằm trong 1 thẻ <script> RIÊNG — page.content() (HTML source thô) giữ
 * nguyên ranh giới các thẻ tách rời này, trong khi 1 giá trị string (vd URL)
 * có thể bị CẮT NGANG giữa 2 lần push liên tiếp. Xác nhận qua debug HTML
 * thật: 1 URL bị cắt còn "https://cdn.hailuoai.video/mo", phần còn lại
 * "ss/prod/..." nằm ở <script> KẾ TIẾP — khiến regex trên page.content() bắt
 * được 1 URL cụt, fetch 404 dù URL thật hoàn toàn hợp lệ. Đọc thẳng mảng
 * self.__next_f trong browser rồi NỐI LẠI các đoạn string trước khi chạy
 * regex — đúng như cách runtime Next.js tự ráp lại dữ liệu, tránh bị cắt
 * ngang do ranh giới thẻ <script>. Fallback về page.content() nếu vì lý do
 * gì đó không đọc được __next_f (vd site đổi tên biến global).
 */
export async function getFlightDataText(page: Page): Promise<string> {
  const flightData = await page
    .evaluate(() => {
      const chunks = (
        window as unknown as { __next_f?: Array<[number, unknown]> }
      ).__next_f;
      if (!Array.isArray(chunks)) return "";
      return chunks
        .map((chunk) => (typeof chunk[1] === "string" ? chunk[1] : ""))
        .join("");
    })
    .catch(() => "");

  if (flightData.includes("downloadURLWithoutWatermark")) {
    return flightData;
  }
  return page.content();
}

/**
 * Trích downloadURLWithoutWatermark từ HTML trang chi tiết — dùng chung cho
 * cả tải video (downloadVideo) và tải ảnh (downloadImageByFeedId trong
 * hailuoImage.ts). html.match() (không có flag "g") chỉ lấy KHỚP ĐẦU TIÊN
 * trong toàn trang — thực tế xác nhận: khớp đầu tiên có thể là 1 định nghĩa
 * schema/placeholder rỗng (vd `"downloadURLWithoutWatermark":""` nằm trong
 * dữ liệu khai báo type, không phải data thật), khiến regex cũ "tràn" qua
 * dấu `"` rỗng đó và bắt nhầm cả đống code JS phía sau làm thành "URL" —
 * gây lỗi "Invalid URL" khi fetch. Dùng matchAll (global) để lấy HẾT các
 * khớp, chỉ giữ giá trị trông giống URL thật (bắt đầu bằng "http").
 *
 * Trang chi tiết 1 video/ảnh vẫn nhúng kèm data của NHIỀU video/ảnh khác
 * trong cùng flight data (vd panel lịch sử bên cạnh) — "khớp cuối cùng"
 * KHÔNG đáng tin cậy để biết đâu là video/ảnh ĐANG XEM (đã xác nhận thực tế:
 * tải nhầm video cũ). feedId (data-feed-id, dạng số ~18 chữ số) KHÔNG xuất
 * hiện trong chính giá trị downloadURLWithoutWatermark (hệ ID khác,
 * "multi_chat_file/<id-khác>"), nhưng lại xuất hiện làm hậu tố filename
 * trong "downloadURLWithWatermark"/"downloadURL" NẰM CHUNG 1 khối JSON với
 * downloadURLWithoutWatermark của đúng video/ảnh đó (vd
 * "..._540859288556474375.mp4") — xác nhận qua debug HTML thật. Vậy tìm vị
 * trí ký tự của feedId trong html, rồi chọn khớp downloadURLWithoutWatermark
 * GẦN vị trí đó NHẤT (cùng khối JSON, khoảng cách rất nhỏ so với data của
 * video/ảnh khác) — đáng tin cậy hơn nhiều so với đoán theo thứ tự xuất hiện.
 */
export function extractDownloadUrlWithoutWatermark(
  html: string,
  feedId: string,
): string {
  const matches = [
    ...html.matchAll(/downloadURLWithoutWatermark[\\"]*:[\\"]*([^"\\]+)/g),
  ]
    .map((m) => ({ index: m.index ?? -1, url: m[1] }))
    .filter((m) => /^https?:\/\//i.test(m.url));

  if (matches.length === 0) {
    throw new GenerationError(
      "Không tìm thấy downloadURLWithoutWatermark hợp lệ trên trang chi tiết",
    );
  }

  const feedIdIndex = html.indexOf(feedId);
  if (feedIdIndex !== -1) {
    const closest = matches.reduce((best, current) =>
      Math.abs(current.index - feedIdIndex) < Math.abs(best.index - feedIdIndex)
        ? current
        : best,
    );
    return closest.url;
  }

  return matches[matches.length - 1].url;
}

async function writeSnapshotFiles(page: Page, jobId: string): Promise<void> {
  await fs.promises.mkdir(config.debugDir, { recursive: true });
  await page.screenshot({
    path: path.join(config.debugDir, `${jobId}.png`),
    fullPage: true,
  });
  await fs.promises.writeFile(
    path.join(config.debugDir, `${jobId}.html`),
    await page.content(),
    "utf-8",
  );
}

/** Chụp trạng thái trang giữa luồng để debug — KHÔNG có nghĩa là job lỗi. */
export async function captureSnapshot(
  page: Page,
  jobId: string,
  label: string,
): Promise<void> {
  try {
    await writeSnapshotFiles(page, jobId);
    // console.log(
    //   `[hailuo] Snapshot "${label}" đã lưu: storage/debug/${jobId}.png`,
    // );
  } catch (debugErr) {
    console.error("[hailuo] Không thể lưu debug snapshot:", debugErr);
  }
}

/** Chụp trạng thái trang khi job THỰC SỰ lỗi (gọi trong catch). */
export async function captureErrorSnapshot(
  page: Page,
  jobId: string,
  err: unknown,
): Promise<void> {
  try {
    await writeSnapshotFiles(page, jobId);
  } catch (debugErr) {
    console.error("[hailuo] Không thể lưu debug snapshot:", debugErr);
  }
  console.error(`[hailuo] Job ${jobId} lỗi:`, err);
}
