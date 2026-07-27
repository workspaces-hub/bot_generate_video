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

export const errorIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/failed|error|thất bại|lỗi/i),
];

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
 */
export const historyVideoLocator = (page: Page): Locator => page.locator("#create-new-scroll-container video[src]");
