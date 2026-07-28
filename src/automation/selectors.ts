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
 * Nút "Start Frame" (upload ảnh khởi đầu video) hiện trực tiếp trong khung
 * nhập prompt tạo video, cạnh "End Frame" — đã thấy qua screenshot debug
 * nhưng CHƯA CÓ DOM thật (chưa lấy được HTML lúc đó), nên đây là candidate
 * ban đầu, có thể cần chỉnh qua debug snapshot lần chạy thử đầu — cùng cách
 * các tính năng khác trong project này đã được tinh chỉnh dần.
 */
export const startFrameButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /start frame/i }),
  () => page.getByText(/^start frame$/i),
];

/**
 * Popover mở ra sau khi bấm chip model/resolution là Ant Design popover
 * (class "ant-popover-content"). Chỉ 1 popover mở tại 1 thời điểm, nên scope
 * tìm kiếm vào đây giúp tránh khớp nhầm chữ ẩn ở nơi khác trên trang.
 */
export const openPopoverLocator = (page: Page): Locator => page.locator(".ant-popover-content");

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
];

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

/**
 * Card lịch sử bị lỗi (generate thất bại) mang data-batch-disabled +
 * aria-disabled="true", KHÔNG có nội dung thật (<video>/<img>) bên trong.
 *
 * SỬA LỖI: lúc đầu tưởng data-batch-disabled = "lỗi", nhưng thực tế xác
 * nhận qua debug HTML là SAI — card đang generate BÌNH THƯỜNG ("Optimizing
 * prompt...", có spinner .animate-spin, nút Recreate/Cancel) CŨNG mang
 * data-batch-disabled (ý nghĩa thật: "chưa phải asset hoàn chỉnh/có thể
 * chọn", áp dụng cho CẢ đang xử lý LẪN lỗi thật) — khiến bot báo lỗi ngay
 * khi entry mới vừa xuất hiện, dù đang generate bình thường (false
 * positive). Card ĐANG xử lý luôn có spinner ".animate-spin" (xác nhận qua
 * class "animate-spin" trên icon xoay); card LỖI THẬT thì không còn spinner
 * (icon tĩnh, không animate) — dùng ":not(:has(.animate-spin))" để chỉ khớp
 * card đã NGÃ NGŨ thành lỗi, không phải đang xử lý dở dang.
 */
export const failedGenerationCardLocator = (page: Page): Locator =>
  page.locator("#create-new-scroll-container [data-batch-disabled]:not(:has(.animate-spin))");

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

/** Đọc số ảnh tham chiếu hiện tại từ aria-label "Upload Image Refs(N/16)". */
export async function getReferenceImageCount(page: Page): Promise<number | null> {
  const button = page.getByRole("button", { name: /^Upload Image Refs/i }).first();
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

export async function getEntryFeedId(entry: Locator): Promise<string | null> {
  return entry.locator("div[data-feed-id]").first().getAttribute("data-feed-id").catch(() => null);
}
