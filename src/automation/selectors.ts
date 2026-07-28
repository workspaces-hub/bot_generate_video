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

export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /sign in|log in|đăng nhập/i }),
  () => page.getByText(/sign in|log in|đăng nhập/i),
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
 * Khu vực lịch sử ảnh đã tạo — tương tự historyVideoLocator nhưng cho thẻ
 * <img>. Scope vào div[data-feed-id] để tránh khớp icon/avatar không liên
 * quan tới nội dung đã tạo. CHƯA CÓ DOM THẬT, cần xác nhận sau khi test.
 */
export const historyImageLocator = (page: Page): Locator =>
  page.locator("#create-new-scroll-container div[data-feed-id] img[src]:visible");
