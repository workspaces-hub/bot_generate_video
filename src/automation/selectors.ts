import type { Locator, Page } from "playwright";

/**
 * hailuoai.video là SPA đứng sau đăng nhập nên không thể soi DOM thật trước.
 * Mỗi phần tử dưới đây liệt kê NHIỀU cách chọn (candidates), thử lần lượt
 * cho tới khi tìm được phần tử hiển thị. Nếu tất cả candidates đều fail,
 * mở screenshot debug (storage/debug/<jobId>.png) rồi bổ sung selector đúng
 * vào đây.
 */
export async function firstVisible(candidates: Array<() => Locator>, timeoutMs = 5000): Promise<Locator> {
  const errors: string[] = [];
  for (const make of candidates) {
    const locator = make().first();
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      return locator;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(
    `Không tìm thấy phần tử nào khớp trong danh sách selector. Cần cập nhật src/automation/selectors.ts.\n${errors.join("\n")}`,
  );
}

/**
 * Nhận diện lỗi Chrome renderer CRASH THẬT (khác lỗi selector/timeout thường)
 * — xác nhận qua log lỗi thật: "page.screenshot: Target crashed" xảy ra khi
 * tiến trình renderer của tab chết giữa chừng (thường do OOM dưới Xvfb, xem
 * launch.ts). Khi đã crash, page/context KHÔNG dùng lại được nữa — mọi thao
 * tác Playwright tiếp theo trên cùng page đều throw lỗi có message chứa
 * "crashed" hoặc "has been closed". Dùng chung cho hailuo.ts (generateVideo)
 * và chatgptImage.ts (generateReferenceImage) để tự mở tab MỚI thử lại thay
 * vì để cả job fail hẳn vì 1 lần crash thoáng qua.
 */
export function isPageCrashError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /crashed|has been closed/i.test(message);
}

export const promptInputCandidates = (page: Page): Array<() => Locator> => [
  // Ô nhập prompt thật là rich-text editor (Slate.js, contenteditable) với
  // id cố định, không phải <textarea>/<input>. Không dùng getByRole("textbox")
  // chung chung vì sau khi đã có lịch sử video, trang còn có ô "Search" cũng
  // mang role textbox và có thể bị khớp nhầm.
  () => page.locator("#video-create-textarea"),
  () => page.locator('[data-slate-editor="true"]'),
  () => page.getByPlaceholder(/prompt|describe|mô tả|nhập|imagine|tưởng tượng/i),
  () => page.locator("textarea"),
];

/** Chip chọn model trong toolbar khung nhập prompt, hiện nhãn dạng "Hailuo 2.3". */
export const modelChipCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /hailuo\s*\d/i }),
  () => page.getByText(/hailuo\s*\d(\.\d)?(\s*fast)?/i),
];

/** Chip chọn độ phân giải trong toolbar khung nhập prompt, hiện nhãn dạng "768p". */
export const resolutionChipCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^\d{3,4}p$/i }),
  () => page.getByText(/^\d{3,4}p$/i),
];

/**
 * DOM THẬT xác nhận (debug snapshot "<jobId>-before-generate-click"): chip
 * chọn SỐ LƯỢNG ảnh tạo ra mỗi lần generate là 1 `<div class="... cursor-pointer
 * ...">` chứa icon (stack/layers) + `<span class="ml-1 text-[13px]
 * text-hl_text_02">4</span>` — hoàn toàn KHÔNG có role="button"/thẻ <button>
 * nào (khác hẳn chip model/resolution) — getByRole("button", ...) dùng ở bản
 * phỏng đoán ban đầu KHÔNG BAO GIỜ khớp được, xác nhận đây chính là lý do
 * selectImageCount (hailuoImage.ts) chưa từng chọn được số ảnh (chip vẫn giữ
 * mặc định "4" dù gọi với imageCount=1). Nằm trong toolbar góc dưới-phải
 * khung nhập prompt (`div[class*="right-3"][class*="bottom-3"]`), ngay TRƯỚC
 * icon credit + nút "Create" — KHÔNG cùng khu vực với chip model/resolution
 * như phỏng đoán ban đầu.
 *
 * CHƯA có DOM thật của POPOVER sau khi bấm chip này (chưa xác nhận có đúng
 * dùng chung cấu trúc "ant-popover-content"/dropdownOptionCandidates với các
 * chip khác không) — nếu selectChipOption vẫn không chọn được sau khi sửa
 * candidate này, cần thêm 1 debug snapshot NGAY SAU KHI CLICK chip để xem
 * cấu trúc popover thật.
 */
export const imageCountChipCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("span.ml-1", { hasText: /^[1-4]$/ }),
  () =>
    page.locator('div[class*="right-3"][class*="bottom-3"] div.cursor-pointer', {
      hasText: /^[1-4]$/,
    }),
];

const VIDEO_INPUT_MODE_NAMES = [
  "Start/End Frame",
  "Image Reference",
  "Character Reference",
  "Omni Reference",
];

/**
 * Site NHỚ mode nhập liệu đã chọn ở lần trước (sticky qua account, không
 * reset khi vào lại trang) — thực tế xác nhận: 1 job chỉ dùng start frame
 * (không yêu cầu mode tham chiếu nào) vẫn load ra trang đang ở mode "Image
 * Reference" còn sót lại từ job trước đó. Vì vậy chip hiện tại có thể mang
 * BẤT KỲ nhãn nào trong 4 nhãn có thể có, không chỉ "Start/End Frame" mặc
 * định — cần match cả 4 để luôn bấm mở được popover đổi mode, bất kể trang
 * đang ở mode nào lúc load.
 */
/**
 * DOM thật xác nhận: mỗi tag video trong lịch sử (dưới mỗi entry) hiện y hệt
 * tên mode làm nhãn tĩnh, KHÔNG phải chip — vd
 * `<div class="text-hl_text_03 bg-hl_bg_05 rounded-[6px] px-2 py-1 cl_hl_H9_R">Omni Reference</div>`,
 * không có "cursor-pointer", không border, không icon svg bên trong. Chip
 * mode THẬT trong composer luôn có "cursor-pointer" + 1 icon <svg> con (xem
 * class thật: "... flex h-8 cursor-pointer items-center gap-1 ... rounded-
 * [10px] border ..."). Nếu chỉ match theo text (getByText/getByRole) sẽ khớp
 * NHẦM cả 2 loại — đã xác nhận gây 2 lỗi khác nhau: false NEGATIVE khi khớp
 * trúng 1 bản sao ẩn ngoài viewport (xem findOnscreenLocator ở hailuo.ts),
 * và false POSITIVE khi khớp trúng tag lịch sử (khiến verify "đã đổi mode
 * đúng chưa" báo sai đã thành công dù chip thật chưa hề đổi). Scope theo
 * cấu trúc div.cursor-pointer có chứa svg để loại tag lịch sử ngay từ đầu.
 *
 * KHÔNG được thêm getByText/getByRole match-theo-text thuần làm fallback ở 2
 * hàm dưới — đã xác nhận qua log thật: khi chipStructureLocator không tìm
 * thấy gì (vd vì chip thật đang hiện mode KHÁC), findOnscreenLocator rơi
 * xuống candidate fallback đó và khớp thẳng vào tag lịch sử (onscreen +
 * visible + không nằm trong popover nên lọt qua hết các điều kiện lọc khác).
 * Thà báo "không tìm thấy chip" còn hơn báo nhầm "đã đúng mode".
 */
function chipStructureLocator(page: Page, pattern: RegExp): Locator {
  return page
    .locator("div.cursor-pointer")
    .filter({ has: page.locator("svg") })
    .filter({ hasText: pattern });
}

export const anyVideoInputModeChipCandidates = (page: Page): Array<() => Locator> => {
  const pattern = new RegExp(`^(${VIDEO_INPUT_MODE_NAMES.join("|").replace(/\//g, "\\/")})$`, "i");
  return [() => chipStructureLocator(page, pattern)];
};

/** Chip đang hiện ĐÚNG nhãn modeName (dùng để kiểm tra "đã ở đúng mode chưa"). */
export const exactVideoInputModeChipCandidates = (page: Page, modeName: string): Array<() => Locator> => {
  const pattern = new RegExp(`^${modeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  return [() => chipStructureLocator(page, pattern)];
};

/**
 * Mode "Character Reference": sau khi upload ảnh nhân vật, site cần vài
 * giây để nhận diện (character detection) trước khi cho generate. Nếu
 * KHÔNG nhận diện được sẽ hiện text "No person detected" hoặc đổi nút thành
 * "Change Characters" (do người dùng xác nhận trực tiếp qua thao tác thủ
 * công trên site).
 */
export const characterDetectionFailedCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/no person detected/i),
  () => page.getByText(/change characters?/i),
];

/**
 * Nút xác nhận popup Terms of Use — dùng chung cho nhiều mode nhưng NHÃN
 * THẬT không giống nhau:
 * - "Character Reference": DOM thật do người dùng cung cấp trực tiếp:
 *   <button class="new-color-btn-bg ... disabled:cursor-not-allowed
 *   disabled:opacity-50">Confirm</button> — nhãn đúng "Confirm".
 * - "Omni Reference": locale JSON nhúng sẵn trong trang xác nhận nhãn thật là
 *   "I confirm" (key "omni_reference_upload_info_ctn":"I confirm"), KHÔNG
 *   phải "Confirm" — trước đây chỉ match "^confirm$" nên bỏ lỡ nút này, khiến
 *   bấm Generate ở mode Omni Reference không lỗi gì nhưng không có gì xảy ra
 *   (popup Terms vẫn còn che, generate chưa thực sự bắt đầu).
 * Dùng exact text match cho từng biến thể, KHÔNG dùng class (trùng class với
 * nút Generate thường — button.new-color-btn-bg).
 */
export const confirmCharacterButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^confirm$/i }),
  () => page.getByRole("button", { name: /^i confirm$/i }),
];

/**
 * Nút "Start Frame" (upload ảnh khởi đầu video) hiện trực tiếp trong khung
 * nhập prompt tạo video, cạnh "End Frame". Locale JSON nhúng sẵn trong trang
 * xác nhận nhãn nút thật là "Start" (key "start_frame_upload_btn":"Start"),
 * KHÔNG phải "Start Frame" ("Start Frame" chỉ là tên gọi field/label trong
 * text khác, ví dụ "first_frame":"Start Frame") — đây là nguyên nhân job chỉ
 * dùng start frame liên tục báo không tìm thấy nút dù mode đã đúng
 * "Start/End Frame". Ưu tiên match "Start" trước, giữ lại 2 candidate cũ làm
 * fallback phòng site đổi lại.
 */
export const startFrameButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^start$/i }),
  () => page.getByRole("button", { name: /start frame/i }),
  () => page.getByText(/^start frame$/i),
];

/**
 * Nút "End Frame" (upload ảnh kết thúc video) — cạnh nút "Start" trong cùng
 * khung nhập prompt (xem startFrameButtonCandidates). Locale key thật của
 * "Start" là "start_frame_upload_btn":"Start" (không phải "Start Frame") —
 * suy ra theo cùng quy ước, nhãn nút thật nhiều khả năng là "End" (không
 * phải "End Frame"). Ưu tiên match "End" trước, giữ "End Frame" làm fallback
 * phòng site đặt khác — CHƯA có DOM thật xác nhận riêng cho nút này, cần
 * chỉnh lại qua debug snapshot nếu sai.
 */
export const endFrameButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^end$/i }),
  () => page.getByRole("button", { name: /end frame/i }),
  () => page.getByText(/^end frame$/i),
];

/**
 * Popover mở ra sau khi bấm chip model/resolution là Ant Design popover
 * (class "ant-popover-content"). Chỉ 1 popover mở tại 1 thời điểm, nên scope
 * tìm kiếm vào đây giúp tránh khớp nhầm chữ ẩn ở nơi khác trên trang.
 */
export const openPopoverLocator = (page: Page): Locator => page.locator(".ant-popover-content");

/**
 * Nút nổi "Return to Latest" xuất hiện khi khung lịch sử đang bị cuộn lên
 * xem entry cũ — DOM thật do người dùng cung cấp trực tiếp. Lúc nút này còn
 * hiện, layout trang có thể khác trạng thái mặc định (đã cuộn xuống cuối),
 * nghi vấn ảnh hưởng tới độ tin cậy khi thao tác composer/chip mode phía
 * dưới — nên bấm về lại "mới nhất" trước khi thao tác.
 */
export const returnToLatestButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^Return to Latest$/i }),
  () => page.getByText(/^Return to Latest$/i),
];

/**
 * Các option trong popover model là <div class="... cursor-pointer"> THƯỜNG
 * (không có role option/menuitem/button nào cả) — nên getByRole không bao
 * giờ khớp được, phải dựa vào text. Dùng exact-match làm ưu tiên số 1 để
 * tránh khớp nhầm submatch (vd "Hailuo 1.0" nằm lẫn trong "Hailuo 1.0-Director").
 */
export const dropdownOptionCandidates = (page: Page, targetText: string): Array<() => Locator> => {
  const pattern = new RegExp(`^${targetText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const popover = openPopoverLocator(page);
  return [
    () => popover.getByText(targetText, { exact: true }),
    () => popover.getByRole("option", { name: pattern }),
    () => popover.getByRole("menuitem", { name: pattern }),
    () => popover.getByRole("button", { name: pattern }),
    () => page.getByText(pattern),
  ];
};

export const generateButtonCandidates = (page: Page): Array<() => Locator> => [
  // Nút generate thật của hailuoai.video không có chữ "Generate" — chỉ có
  // icon + số credit (vd "25"). Xác định qua class riêng của app.
  () => page.locator("button.new-color-btn-bg"),
  // Mode "Image Reference" (model Veo) dùng nút khác hẳn — cũng không có
  // chữ "generate"/"create"/"tạo", chỉ icon + số credit + badge "63% Off",
  // nhưng class riêng "bg-hl_brand_00" (xác nhận qua debug HTML thực tế,
  // chỉ xuất hiện đúng 1 lần trên trang).
  () => page.locator("button.bg-hl_brand_00"),
  () => page.getByRole("button", { name: /generate/i }),
  () => page.getByRole("button", { name: /create/i }),
  () => page.getByRole("button", { name: /tạo/i }),
];

/**
 * CHỈ khớp EXACT (^...$), không dùng substring rộng — thực tế đã gặp báo
 * nhầm "chưa đăng nhập" vì popup quảng cáo MiniMax Hub có câu "Sign in for
 * 3,000 free credits" chứa substring "sign in", trong khi session vẫn hợp
 * lệ (xác nhận qua scripts/check-session.ts). "Continue with Google" là
 * nút đăng nhập thật đã xác nhận từ dữ liệu tracking khi site ở trạng thái
 * chưa đăng nhập — ưu tiên tín hiệu này hơn text "sign in" chung chung.
 */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^continue with google$/i }),
  () => page.getByRole("button", { name: /^(sign in|log in|đăng nhập)$/i }),
  () => page.getByText(/^(sign in|log in|đăng nhập)$/i),
];

/**
 * CHỈ khớp các câu thông báo lỗi/toast NGẮN, cụ thể — không dùng regex rộng
 * kiểu /error|failed|lỗi/i vì nó khớp nhầm cả câu chữ dài không liên quan
 * (vd FAQ "Do I get charged if a video failed to generate?" bên trong popup
 * nâng cấp gói, từng khiến bot báo lỗi sai be bét).
 */
export const errorIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/generation failed/i),
  () => page.getByText(/something went wrong/i),
  () => page.getByText(/tạo video thất bại/i),
  () => page.getByText(/đã xảy ra lỗi/i),
  // Toast "Please select a picture" (toast_please_select_pic) — chế độ
  // Start/End Frame đang bật nhưng bot chỉ điền text, không upload ảnh nào.
  () => page.getByText(/please select a picture/i),
  // Toast thực tế gặp: bấm Generate khi ảnh start frame vẫn còn aria-busy
  // (chưa xử lý xong) — đã sửa gốc bằng cách đợi hết busy trước khi bấm,
  // giữ lại đây làm lớp phòng vệ thứ 2 nếu race lại xảy ra.
  () => page.getByText(/wait until picture upload completes/i),
  // Text lỗi THẬT của card generate — tra được nguyên văn từ chính locale
  // strings nhúng trong trang (key "bk_hard_moss_video_failed": "The content
  // generation has failed. Please try again."). KHÔNG khớp regex
  // /generation failed/i ở trên vì có chữ "has" chen giữa ("generation HAS
  // failed") — cần khai báo riêng. Đáng tin cậy hơn nhiều so với đoán cấu
  // trúc DOM (data-batch-disabled, spinner, nút Cancel...) — những cách đó
  // đã thử và đều gây false positive vì site dùng chung marker cấu trúc cho
  // cả trạng thái "đang xử lý" lẫn "lỗi thật".
  () => page.getByText(/content generation has failed/i),
];

/**
 * Nút "Delete All Failed" chỉ xuất hiện (hover trên entry lịch sử) khi entry
 * đó có card ĐÃ THẤT BẠI thật — DOM thật do người dùng cung cấp trực tiếp:
 * media-card-wrapper mang data-batch-disabled/aria-disabled="true", card con
 * chỉ có icon placeholder chung (không <video>/<img> nào), và ngay dưới có
 * nút "Delete All Failed" cạnh "Recreate". Khác hẳn 2 trạng thái ĐANG XỬ LÝ
 * đã từng gây false positive trước đây (spinner "Optimizing prompt...",
 * progress ring "N% Generating...") — cả 2 trạng thái đó không có nút xoá
 * này (chưa có gì để xoá). Đáng tin cậy hơn nhiều so với chỉ dựa vào
 * data-batch-disabled/aria-disabled (những marker đó dùng chung cho cả
 * đang-xử-lý lẫn lỗi thật, xem chú thích errorIndicatorCandidates).
 */
export const deleteAllFailedButtonLocator = (page: Page): Locator =>
  page.getByText(/^Delete All Failed$/i);

/**
 * Text "Generating..." hiện trên card đang xử lý trong lịch sử — DOM thật
 * xác nhận (job fb09b10a): `<div class="line-clamp-2 ...">Generating...</div>`.
 * Nhận `Page` hoặc `Locator` làm scope — waitForNewVideo dùng bản scope theo
 * 1 entry cụ thể (div[data-feed-id="..."]) để chỉ theo dõi ĐÚNG job hiện tại,
 * không nhầm lẫn với job KHÁC của tài khoản cũng đang generate song song
 * (đếm số lượng "Generating..." toàn trang không đủ tin cậy cho việc đó).
 */
export const generatingIndicatorLocator = (scope: Page | Locator): Locator =>
  scope.getByText(/^Generating\.\.\.$/i);

/**
 * Popup nâng cấp gói / hết credit (vd "Seedance 2.0 Full Lineup... Choose
 * Your Plan, Subscribe, Redeem a Code") có thể che kín trang khi tài khoản
 * không đủ credit để generate. Phát hiện riêng để báo lỗi rõ ràng thay vì
 * để timeout mơ hồ hoặc khớp nhầm chữ trong nội dung popup.
 */
export const creditPaywallModalCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/redeem a code/i),
  () => page.getByText(/choose your plan/i),
];

/**
 * hailuoai.video hay bật popup quảng cáo/sự kiện (Ant Design Modal) bất chợt
 * ở nhiều thời điểm khác nhau trong lúc dùng, không chỉ lúc mới vào trang —
 * mỗi loại có nội dung khác nhau (giảm giá, sự kiện, hết credit...) nên
 * không thể liệt kê hết theo text. ".ant-modal-wrap"/".ant-modal-close" là
 * class CHUẨN của thư viện Ant Design, áp dụng cho MỌI modal loại này bất
 * kể nội dung — đáng tin cậy hơn dò text cụ thể.
 */
export const antModalWrapperLocator = (page: Page): Locator => page.locator(".ant-modal-wrap");
export const antModalCloseButtonLocator = (page: Page): Locator => page.locator(".ant-modal-close");

export const downloadTriggerCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /download/i }),
  () => page.getByRole("link", { name: /download/i }),
];

export const videoElementCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("video[src]"),
  () => page.locator("video source[src]"),
];

/**
 * Khu vực lịch sử video (id="create-new-scroll-container") dùng
 * flex-col-reverse: video mới nhất được thêm vào CUỐI DOM nhưng hiển thị
 * ở TRÊN CÙNG. Vì vậy không thể tin vào .first()/.last() một cách cố định —
 * xem waitForNewVideo() trong hailuo.ts, nơi tự phát hiện đầu nào vừa đổi.
 *
 * Mỗi card thực ra có 2 thẻ <video> TRÙNG src: 1 cái hiển thị (thumbnail
 * dạng lưới, object-cover) và 1 cái ẩn (preload="none", dùng cho
 * lightbox/modal chi tiết, chỉ hiện khi mở). Nếu khớp trúng cái ẩn, click
 * để mở trang chi tiết sẽ luôn timeout "element is not visible" và không
 * tìm thấy ancestor div[data-feed-id] (vì nằm trong container khác) — nên
 * dùng ":visible" (pseudo-class riêng của Playwright) để chỉ khớp bản
 * đang hiển thị thật sự.
 */
export const historyVideoLocator = (page: Page): Locator =>
  page.locator("#create-new-scroll-container video[src]:visible");

// data-batch-disabled KHÔNG dùng được để phát hiện lỗi generation — đã thử
// 2 cách loại trừ khác nhau (:not(:has(.animate-spin)), rồi :not(:has(button
// :has-text("Cancel")))) và cả 2 đều gây false positive thật (chặn nhầm job
// đang generate bình thường), vì site dùng marker này cho RẤT NHIỀU trạng
// thái "chưa phải asset hoàn chỉnh" khác nhau (ít nhất 3 kiểu UI "đang xử
// lý" đã gặp: spinner tròn, progress ring %, và % không kèm nút nào) — bỏ
// hẳn, không dùng lại cách này nữa. Chỉ dựa vào errorIndicatorCandidates
// (toast lỗi) + timeout để phát hiện lỗi generation.

/**
 * CHƯA CÓ DOM THẬT — đây là phỏng đoán ban đầu cho tính năng tạo ẢNH (mới
 * thêm). Khung nhập prompt có tab chuyển "Video"/"Image"/"Audio" (đã thấy
 * trong screenshot trước đây nhưng chưa lấy được HTML chính xác). Nhiều
 * khả năng cần chỉnh qua debug snapshot sau lần chạy thử đầu.
 */
export const imageModeTabCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^image$/i }),
  () => page.getByText(/^image$/i),
];

/**
 * Nút thêm ảnh tham chiếu ở chế độ tạo ảnh — cùng cơ chế "Upload Start/End
 * Frame" trước đây (div role="button" mở file picker hệ điều hành). Xác
 * nhận được DOM thật: aria-label="Upload Image Refs(N/16)" — số đếm N thay
 * đổi động sau mỗi lần upload, nên chỉ match phần PREFIX cố định, không
 * match cả cụm (khớp cả số sẽ luôn fail sau lần upload đầu vì số đổi).
 */
export const addReferenceImageButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^Upload Image Refs/i }),
];

/**
 * Nút upload ảnh nhân vật ở mode "Character Reference" — DOM thật xác nhận
 * aria-label="Upload Character Refs" (KHÔNG có số đếm (N/M) như Image Refs,
 * vì chỉ nhận đúng 1 ảnh).
 */
export const addCharacterRefButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^Upload Character Refs/i }),
];

/** Nút upload file tham chiếu (ảnh/video/audio) ở mode "Omni Reference". */
export const addOmniReferenceButtonCandidates = (page: Page): Array<() => Locator> => [
  // DOM thật xác nhận: aria-label="Upload Refs (0/12)" (có khoảng trắng
  // trước dấu ngoặc, KHÁC "Upload Image Refs(N/16)" không có khoảng trắng) —
  // giới hạn thật là 12, không phải 3.
  () => page.getByRole("button", { name: /^Upload Refs/i }),
];

/** Đọc số ảnh tham chiếu hiện tại từ aria-label "Upload Image Refs(N/16)". */
export async function getReferenceImageCount(page: Page): Promise<number | null> {
  const button = page.getByRole("button", { name: /^Upload Image Refs/i }).first();
  const label = await button.getAttribute("aria-label").catch(() => null);
  const match = label?.match(/\((\d+)\/\d+\)/);
  return match ? Number(match[1]) : null;
}

/** Đọc số file tham chiếu hiện tại ở mode "Omni Reference" — cùng quy ước "(N/M)". */
export async function getOmniReferenceCount(page: Page): Promise<number | null> {
  const button = page.getByRole("button", { name: /^Upload Refs/i }).first();
  const label = await button.getAttribute("aria-label").catch(() => null);
  const match = label?.match(/\((\d+)\/\d+\)/);
  return match ? Number(match[1]) : null;
}

/**
 * Mỗi thumbnail ảnh tham chiếu vừa upload có aria-label cố định "Uploaded
 * image, click to preview" và aria-busy="true" TRONG LÚC còn đang xử lý
 * (kèm spinner .anticon-spin) — khi xong thì aria-busy biến mất/thành
 * false. Đáng tin cậy hơn nhiều so với đếm số lượng hay networkidle để biết
 * ảnh đã THỰC SỰ sẵn sàng trước khi bấm Generate.
 */
export const busyReferenceImageThumbnailLocator = (page: Page): Locator =>
  page.locator('[aria-label="Uploaded image, click to preview"][aria-busy="true"]');

/**
 * DOM thật xác nhận: mỗi loại file dùng aria-label KHÁC NHAU khi đang xử lý
 * — ảnh: "Uploaded image, click to preview" (có hậu tố ", click to
 * preview"), video: "Uploaded video" (KHÔNG có hậu tố đó). Vì vậy chỉ dùng
 * prefix match "Uploaded" (bỏ suffix match) để bắt được cả 2 dạng cùng lúc —
 * bản trước dùng suffix match nên bỏ sót video, khiến bot bấm Generate khi
 * video vẫn còn đang tải.
 */
export const busyOmniReferenceThumbnailLocator = (page: Page): Locator =>
  page.locator('[aria-label^="Uploaded"][aria-busy="true"]');

/**
 * Mỗi lần generate ảnh, hailuoai.video trả về CẢ CỤM (thực tế xác nhận: 4
 * ảnh) gộp chung trong 1 "entry", bên trong chứa nhiều div[data-feed-id]
 * (mỗi ảnh 1 feed-id riêng, xem class "grid grid-cols-2" bọc ngoài trong DOM
 * thật). Vì vậy KHÔNG thể đếm/so sánh theo từng <img> phẳng như video (1
 * video = 1 entry = 1 file) — phải so sánh theo ENTRY rồi lấy hết ảnh bên
 * trong entry mới, nếu không sẽ chỉ tải được 1/4 ảnh.
 *
 * SỬA LỖI: trước đây dùng "#create-new-scroll-container > div" (con TRỰC
 * TIẾP) — SAI, vì con trực tiếp thật sự chỉ là vài div cấu trúc cố định
 * (hint "not all results...", div rỗng, div wrapper bọc cả danh sách), số
 * lượng KHÔNG BAO GIỜ tăng dù có generate thêm bao nhiêu lần — khiến
 * waitForNewImageEntry không bao giờ phát hiện được entry mới và luôn
 * timeout 5 phút. DOM thật xác nhận mỗi lần generate (video lẫn ảnh) được
 * bọc trong div id="media-group-<id>" (nằm SÂU hơn, không phải con trực
 * tiếp) — dùng selector này, không phụ thuộc độ sâu lồng nhau.
 */
export const historyEntryLocator = (page: Page): Locator =>
  page.locator('#create-new-scroll-container div[id^="media-group-"]');

/**
 * Lịch sử gộp CHUNG cả video lẫn ảnh (cùng #create-new-scroll-container),
 * nên historyEntryLocator ở trên khớp CẢ HAI loại — nếu dùng thẳng để dò
 * "ảnh mới" thì có rủi ro (dù hiếm, do queue xử lý tuần tự) nhầm 1 entry
 * video vừa xuất hiện thành ảnh mới, dẫn tới tải nhầm sang trang chi tiết
 * /ai-image/ của 1 video. Lọc bỏ entry có chứa <video> để chỉ còn entry ảnh
 * — mỗi media-group đã xác nhận chỉ chứa 1 loại nội dung, không trộn lẫn.
 */
export const historyImageEntryLocator = (page: Page): Locator =>
  historyEntryLocator(page).filter({ hasNot: page.locator("video") });

/** Các ảnh (có thể nhiều, vd 4 ảnh/lần generate) bên trong 1 entry lịch sử. */
export const entryImagesLocator = (entry: Locator): Locator =>
  entry.locator("div[data-feed-id] img[src]:visible");

/**
 * Số credit còn lại của tài khoản, hiện ở sidebar trái cạnh nhãn gói đang
 * dùng (vd "Max") — DOM thật xác nhận:
 * `<span class="text-hl_text_00 select-none text-[12px] font-medium leading-[22px] ">21,580</span>`.
 * Không dùng class Tailwind có ngoặc vuông (vd "text-[12px]") trong CSS
 * selector (cần escape phức tạp) — chỉ dùng 2 class thường + lọc thêm theo
 * đúng định dạng số có dấu phẩy ngăn cách hàng nghìn để tránh khớp nhầm các
 * text khác dùng chung 2 class này.
 */
export const creditBalanceLocator = (page: Page): Locator =>
  page
    .locator("span.text-hl_text_00.select-none")
    .filter({ hasText: /^[\d,]+$/ });

export async function getEntryFeedId(entry: Locator): Promise<string | null> {
  return entry.locator("div[data-feed-id]").first().getAttribute("data-feed-id").catch(() => null);
}
