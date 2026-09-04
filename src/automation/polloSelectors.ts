import type { Locator, Page } from "playwright";

/**
 * Selector cho pollo.ai — xác nhận qua debug DOM thật (storage/debug/inspect-pollo-*),
 * lấy bằng cách mở /image, /video, /create bằng session đã đăng nhập rồi
 * chụp/click từng phần tử (xem scripts/inspect-pollo*.ts). Composer dùng
 * CHUNG cấu trúc cho cả trang /image, /video, /create (chỉ khác mode mặc
 * định) — nên các selector dưới đây dùng chung được cho cả generateImage
 * (polloImage.ts) và generateVideo (pollo.ts).
 */

/** Ô nhập prompt — ProseMirror contenteditable (giống ChatAI), KHÔNG dùng .fill() được. */
export const promptEditorLocator = (page: Page): Locator =>
  page.locator('[data-testid="prompt-editor"] [contenteditable="true"]');

/**
 * Nút "+" mở dialog chọn/upload ảnh tham chiếu — mode "Frames to Video" có
 * NHIỀU nút cùng data-testid này (Start/End), disambiguate qua
 * data-upload-card-label sibling (xem uploadCardButtonByLabel bên dưới).
 * Mode "Reference to Video" cũng có 2 nút (ảnh riêng + video riêng, xem
 * uploadCardButtonForImage bên dưới). Mode "Text/Image to Image"/"Text/Image
 * to Video" chỉ có ĐÚNG 1 nút — dùng .first().
 */
export const uploadCardButtonLocator = (page: Page): Locator =>
  page.locator('[data-testid="upload-card-asset-picker"]');

/**
 * Nút upload ĐÚNG theo nhãn "Start"/"End" (mode "Frames to Video") — nhãn
 * nằm trong div[data-upload-card-label] SIBLING với nút picker, cùng 1 div
 * cha `.flex.flex-col.items-center`.
 */
export const uploadCardButtonByLabel = (page: Page, label: "Start" | "End"): Locator =>
  page
    .locator(`div:has(> [data-upload-card-label]:text-is("${label}"))`)
    .locator('[data-testid="upload-card-asset-picker"]');

/**
 * Nút upload ẢNH tham chiếu trong mode "Reference to Video" — mode này có 2
 * nút "+" cạnh nhau (ảnh riêng, class bao ngoài "group/image-upload"; video
 * riêng, class "group/video-upload", icon "i-cus--pol-add-video") — xác nhận
 * qua DOM thật (storage/debug/inspect-pollo-video-reference-mode.html). Chỉ
 * cần nút ảnh cho storyboard (CHARACTER/LOCATION/SCENE_SETTING đều là ảnh).
 */
export const uploadCardButtonForImage = (page: Page): Locator =>
  page.locator('div.group\\/image-upload [data-testid="upload-card-asset-picker"]');

/**
 * Input file THẬT (ẩn) bên trong dialog "Uploads" mở ra sau khi bấm nút "+"
 * — KHÁC HẲN cơ chế filechooser của AIVideo, dùng setInputFiles() thẳng vào
 * input này (đáng tin cậy hơn, không cần đợi sự kiện filechooser).
 */
export const uploadDialogFileInputLocator = (page: Page): Locator =>
  page.locator('input[type="file"][name="file"]');

/**
 * Thumbnail 1 ảnh trong lưới "Uploads" (data-testid="asset-picker-grid") —
 * xác nhận qua lỗi thật (job test-pollo-image-ref-e2e): upload xong ảnh
 * THẬT SỰ xuất hiện thành thumbnail này, nhưng KHÔNG tự động ở trạng thái
 * "đã chọn" — PHẢI click vào thumbnail để chọn (data-asset-url mang URL ảnh
 * vừa upload) thì nút "Select" mới hết disabled. Trước đây thiếu bước này,
 * khiến uploadReferenceImage/uploadFrameImage treo 30s chờ nút Select enable.
 */
export const assetPickerCardLocator = (page: Page): Locator =>
  page.locator('[data-testid="asset-picker-card"]');

/** Nút "Select" xác nhận ảnh vừa CHỌN (xem assetPickerCardLocator) trong dialog — chỉ enable sau khi đã click thumbnail. */
export const uploadDialogSelectButtonLocator = (page: Page): Locator =>
  page.locator('[data-testid="asset-picker-confirm"]');

/** Chip mode (vd "Text/Image to Image", "Frames to Video"...) — bấm mở menu các mode khác. */
export const modeChipLocator = (page: Page): Locator =>
  page.locator('button[data-button-name="func"]');

/** 1 option mode trong menu vừa mở — khớp CHÍNH XÁC theo tên hiển thị. */
export const modeMenuOptionLocator = (page: Page, modeName: string): Locator =>
  page.getByText(new RegExp(`^${modeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));

/**
 * Chip chọn MODEL (vd "GPT Image 2", "Seedance 2.5") — div[data-button-name="params"]
 * chứa 1 <button class="group/model"> lồng bên trong, PHÂN BIỆT với chip
 * tỉ lệ/thời lượng (params chip khác — role="button" đặt TRỰC TIẾP trên div,
 * KHÔNG có button con).
 */
export const modelChipLocator = (page: Page): Locator =>
  page.locator('div[data-button-name="params"] button.group\\/model');

/**
 * Ô "Search…" trong popup chọn model mở ra sau khi bấm modelChipLocator —
 * xác nhận qua DOM thật (storage/debug/inspect-pollo-video-model-dialog.html):
 * popup KHÔNG có role="dialog" nào (không phải Ant/Radix dialog chuẩn), chỉ
 * là 1 khối "chat-popup-surface" tự custom, input tìm kiếm có placeholder
 * "Search…" (dùng dấu ba chấm Unicode "…", KHÔNG phải 3 dấu chấm thường).
 */
export const modelSearchInputLocator = (page: Page): Locator =>
  page.locator('input[placeholder="Search…"]');

/**
 * 1 model trong popup vừa mở (dùng cùng modelSearchInputLocator ở trên) —
 * mỗi hàng model là 1 div[data-button-name="<slug nội bộ>"] (vd
 * "minimax-hailuo-03" cho "MiniMax H3" — slug KHÔNG suy ra được từ tên hiển
 * thị, không dùng làm selector trực tiếp được) chứa 1 <p class="font-semibold">
 * mang ĐÚNG tên hiển thị — khớp CHÍNH XÁC theo tên để tránh nhầm giữa các
 * biến thể cùng họ (vd "MiniMax H3" vs "MiniMax H3 Max").
 */
export const modelDialogOptionLocator = (page: Page, modelName: string): Locator =>
  page.locator(
    `div[data-button-name]:has(p.font-semibold:text-is("${modelName}"))`,
  );

/**
 * Chip tỉ lệ/số lượng/độ phân giải/chất lượng (ảnh) hoặc tỉ lệ/thời lượng/
 * độ phân giải (video) — div[data-button-name="params"] với role="button"
 * đặt TRỰC TIẾP (không lồng <button>).
 */
export const paramsChipLocator = (page: Page): Locator =>
  page.locator('div[data-button-name="params"][role="button"]');

/** Popup/dialog mở ra sau khi bấm modelChipLocator/paramsChipLocator — CHƯA có DOM thật xác nhận cấu trúc bên trong, cần bằng chứng thêm khi cần đổi model/tỉ lệ thật. */
export const openDialogLocator = (page: Page): Locator => page.locator('[role="dialog"]');

/**
 * Nhãn section "Video Length" — dùng CHUNG class marker
 * "text-f-text-quaternary text-xs font-normal" cho MỌI section label (kể cả
 * "Resolution"/"Aspect Ratio"), lọc thêm bằng text exact "Video Length" để
 * chỉ còn đúng 1 phần tử — xác nhận đây là selector DUY NHẤT không bị ambiguous
 * dù DOM có 2 biến thể khác nhau tuỳ chỗ xuất hiện (xem 2 hàm bên dưới):
 * 1. Trong popup mở từ paramsChipLocator (mode "Text/Image to Video" — job
 *    inspect-pollo-duration3): label text nằm trong <span> con, div cha
 *    mang class marker này.
 * 2. Nằm SẴN (không cần bấm gì) trong composer mode "Reference to Video" +
 *    model MiniMax H3 (job inspect-pollo-duration-slider, DOM user cung
 *    cấp trực tiếp): label text nằm THẲNG trên div, cùng class marker.
 * Cả 2 trường hợp, div mang class marker này chính là label — dùng
 * `.locator("xpath=following-sibling::div[1]")` để lấy khối nội dung
 * (option buttons HOẶC slider) ngay sau nó.
 */
const videoLengthLabelLocator = (page: Page): Locator =>
  page
    .locator("div.text-f-text-quaternary.text-xs.font-normal")
    .filter({ hasText: /^Video Length$/ });

/**
 * 1 option "Video Length" dạng NÚT BẤM (vd "5s"/"10s") — xem docstring
 * videoLengthLabelLocator, biến thể 1 (mode "Text/Image to Video", model có
 * số lựa chọn cố định, vd Pollo 2.0 chỉ 5s/10s). Khớp CHÍNH XÁC theo text để
 * tránh nhầm sang Resolution (480p/720p/1080p) hay Aspect Ratio (16:9/9:16...)
 * dùng chung cấu trúc div.grid.
 */
export const videoLengthOptionLocator = (page: Page, duration: string): Locator =>
  videoLengthLabelLocator(page).locator(
    `xpath=following-sibling::div[1]//span[normalize-space(text())="${duration}"]`,
  );

/**
 * Slider "Video Length" dạng KÉO THẢ (min=4 max=15, step=1) — xác nhận qua
 * DOM thật user cung cấp trực tiếp (mode "Reference to Video" + model
 * MiniMax H3, job inspect-pollo-duration-slider): input[type=range] THẬT tồn
 * tại ngay trên trang khi vừa load, KHÔNG cần bấm gì để lộ ra — nhưng
 * Playwright coi là "không visible" (clip-path: inset(50%) — kỹ thuật ẩn
 * input thật, chỉ hiện track/thumb custom bên cạnh, chuẩn a11y pattern cho
 * slider tự vẽ lại giao diện). VÌ VẬY không dùng click/drag thường được (fail
 * actionability check do "không visible") — phải set value bằng JS + tự bắn
 * sự kiện input/change (xem setSliderValue trong pollo.ts).
 */
export const videoLengthSliderInputLocator = (page: Page): Locator =>
  videoLengthLabelLocator(page).locator('xpath=following-sibling::div[1]//input[@type="range"]');

/** Nút Generate — luôn có data-testid cố định, tự "aria-disabled=true" khi chưa nhập prompt. */
export const generateButtonLocator = (page: Page): Locator =>
  page.locator('[data-testid="prompt-generate-btn"]');

/**
 * 1 khối kết quả generate (chứa prompt + ảnh/video vừa tạo) — xuất hiện dần
 * trong lịch sử trang /create SAU KHI generate, ảnh/video MỚI thường nằm ở
 * CUỐI danh sách (xác nhận qua debug thật: card cũ nằm trên, card mới thêm
 * vào dưới — ngược thứ tự so với AIVideo).
 */
export const resultCardLocator = (page: Page): Locator =>
  page.locator('[data-widget-name="project_content_card"]');

/**
 * Ảnh THÀNH CÔNG bên trong 1 result card — alt cố định "Generated image",
 * src là URL CDN cuối cùng. Xác nhận qua file tải THẬT (job
 * test-pollo-image-e2e): ảnh VẪN có watermark "Pollo.ai" đóng góc, KHÔNG có
 * bản sạch nào khác (không thấy dropdown "Download without watermark" cho
 * ảnh như video) — nhận định "ảnh không watermark" trước đó là SAI.
 */
export const resultImageLocator = (scope: Page | Locator): Locator =>
  scope.locator('img[alt="Generated image"]');

/** Video THÀNH CÔNG bên trong 1 result card (video.js player) — src mặc định trỏ tới bản CÓ watermark (đường dẫn chứa "/wm/") nếu tài khoản chưa có quyền tải bản sạch. */
export const resultVideoLocator = (scope: Page | Locator): Locator =>
  scope.locator("video.vjs-tech");

/** Nút Download (icon) của 1 result card — hover/xuất hiện khi hover vào card, mở dropdown "Download with/without watermark". */
export const resultDownloadButtonLocator = (scope: Page | Locator): Locator =>
  scope.locator('[data-testid="record-action"][aria-label="Download"]');

/** Option "Download without watermark" trong dropdown vừa mở — CHỈ dùng được nếu gói tài khoản hỗ trợ (xác nhận qua thực tế: tài khoản thường/free bấm vào hiện popup yêu cầu nâng cấp, không tải được). */
export const downloadWithoutWatermarkOptionLocator = (page: Page): Locator =>
  page.locator('[data-testid="record-action"][data-action-key="without-watermark"]');

/** Option "Download with watermark" — luôn dùng được, xác nhận qua thực tế trả về sự kiện download thật (page.waitForEvent("download")). */
export const downloadWithWatermarkOptionLocator = (page: Page): Locator =>
  page.locator('[data-testid="record-action"][data-action-key="with-watermark"]');

/**
 * Popup hết credit khi bấm Generate — xác nhận qua lỗi thật (job
 * debug-pollo-video): bấm Generate lúc tài khoản không đủ credit cho model/
 * cấu hình đang chọn hiện popup "Upgrade to get more credits" kèm câu chính
 * xác "You don't have enough credits to generate this video." — KHÔNG bắt
 * đầu generate (không tốn credit), nhưng cũng KHÔNG có card kết quả nào xuất
 * hiện, khiến waitForNewResult (polloImage.ts/pollo.ts) treo VÔ HẠN nếu
 * không phát hiện riêng trường hợp này (đã từng treo thật ~8 phút không có
 * dấu hiệu gì trước khi phát hiện ra popup này qua debug snapshot).
 */
export const creditPaywallLocator = (page: Page): Locator =>
  page.getByText(/you don't have enough credits/i);

/**
 * Nút đóng (X) của popup quảng cáo/promo (vd "Unlock Unlimited MiniMax H3"
 * kèm video nền tự phát) — xác nhận qua lỗi thật (job inspect-pollo-
 * reference-upload): popup này che kín composer, chặn mọi click vào mode
 * chip/model chip bên dưới ("... subtree intercepts pointer events"). Class
 * ".coco-modal-close" là class CHUNG của cả hệ thống modal "coco-modal" (thấy
 * lặp lại ở nhiều nơi khác, vd coco-dropdown-menu) — không riêng promo này,
 * nên đáng tin cậy dùng chung cho MỌI popup dạng coco-modal.
 */
export const modalCloseButtonLocator = (page: Page): Locator =>
  page.locator(".coco-modal-close");

/**
 * Dấu hiệu chưa đăng nhập — CHƯA có DOM thật xác nhận riêng cho pollo.ai
 * (đăng nhập qua Google/email popup khác nhiều site), tạm dùng suy đoán hợp
 * lý (nút "Sign In"/"Log in" ở header) — cần chỉnh lại nếu sai khi gặp thật.
 */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^sign in$/i }),
  () => page.getByRole("link", { name: /^sign in$/i }),
];

/**
 * Nút "@" mở picker chọn asset để "mention" vào prompt — mode "Reference to
 * Video" (xem uYunWS/uRxp8f trong locale strings: "... add up to 3 voices and
 * @ them ..." — cùng cơ chế mention dùng chung cho audio/video reference).
 * Xác nhận qua lỗi thật (job inspect-pollo-reference-upload): nút này nằm
 * TRONG placeholder rỗng của editor (data-slot="editor-placeholder"), đúng
 * lúc editor CHƯA có nội dung — div cha mang aria-hidden="true" nên
 * getByRole("button", {name: "Mention"}) KHÔNG tìm thấy được (loại khỏi
 * accessibility tree dù vẫn click được thật bằng chuột, pointer-events:auto
 * override riêng cho nút) — PHẢI dùng locator theo attribute, không dùng
 * role. Editor hết rỗng (đã gõ prompt/mention trước đó) thì nút này biến mất
 * — dùng page.keyboard.type("@") ngay tại vị trí con trỏ trong editor để mở
 * lại đúng picker này cho các lần mention tiếp theo.
 */
export const mentionButtonLocator = (page: Page): Locator =>
  page.locator('button[aria-label="Mention"]');

/**
 * 1 item trong picker mention vừa mở, ứng với 1 file mới upload — xác nhận
 * qua DOM thật: data-testid="asset-item-upload" (KHÔNG đặc thù theo tên file,
 * mọi file upload gần đây đều dùng chung testid này) chứa tên file (không
 * đuôi) trong <span class="truncate">. Khớp CHÍNH XÁC theo tên (đã sanitize,
 * không đuôi mở rộng — trùng quy ước đặt tên file ref của storyboardPipeline,
 * xem sanitizeId) để chọn đúng file vừa upload, không nhầm sang creation cũ.
 */
export const mentionPickerItemLocator = (page: Page, fileNameNoExt: string): Locator =>
  page
    .locator('[data-testid="asset-item-upload"]')
    .filter({ has: page.locator(`span.truncate:text-is("${fileNameNoExt}")`) });

/**
 * Cùng 1 item trong picker mention như mentionPickerItemLocator, nhưng khớp
 * theo URL ảnh (data-asset-url lúc upload = src của <img> trong item này) —
 * KHÔNG khớp theo tên hiển thị. Xác nhận qua lỗi thật (job
 * cay_khe_rm_end_SHOT_01_CLIP_02_VIDEO): pollo.ai có thể tự gắn nhãn SAI cho
 * ảnh vừa upload theo hệ thống "Character Library" của họ (vd ảnh
 * CHAR_OLDER_BROTHER hiện tên "CHAR_YOUNGER_BROTHER (2)" dù nội dung ảnh
 * hoàn toàn khác) — tên hiển thị không đáng tin, phải bám theo URL cụ thể
 * của file đã upload (lấy từ submitAssetUpload) thay vì tên file.
 */
export const mentionPickerItemByUrlLocator = (page: Page, assetUrl: string): Locator =>
  page
    .locator('[data-testid="asset-item-upload"]')
    .filter({ has: page.locator(`img[src="${assetUrl}"]`) });
