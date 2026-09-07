import { config } from "../src/config";
import { getPolloImageBrowserContext } from "../src/automation/polloBrowser";
import {
  clickWithOverlayDismiss,
  dismissBlockingOverlays,
  enableUnlimitedIfNotEnoughCredit,
  ensureComposerReadyOrThrow,
  gotoPolloWithRetry,
  waitForGenerateButtonEnabled,
} from "../src/automation/pollo";
import {
  generateButtonLocator,
  promptEditorLocator,
  resultCardLocator,
} from "../src/automation/polloSelectors";

/**
 * Test THẬT theo yêu cầu user ("có cách nào check job gen xong hay chưa dựa
 * vào videoID"): bắt TOÀN BỘ request/response JSON (không phải asset tĩnh)
 * trong lúc bấm Generate thật + trong lúc đang generate — để tìm xem có
 * endpoint nào trả về id ngay lúc submit, và có endpoint nào pollo.ai tự
 * poll để cập nhật % tiến độ hiển thị trên UI không (nếu có, đó chính là
 * cách đáng tin cậy hơn để check trạng thái generate thay vì dò DOM).
 */
const STATIC_ASSET_RE = /\.(png|jpe?g|webp|mp4|css|js|woff2?|ico|svg|gif)(\?|$)/i;

async function main(): Promise<void> {
  const context = await getPolloImageBrowserContext();
  const page = await context.newPage();

  const logs: string[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("pollo.ai") || STATIC_ASSET_RE.test(url)) return;
    const method = req.method();
    if (method === "GET") return; // log response thay vì request cho GET, đỡ trùng
    const body = req.postData();
    logs.push(
      `>> ${method} ${url}` + (body ? `\n   body: ${body.slice(0, 800)}` : ""),
    );
  });

  page.on("response", (res) => {
    const req = res.request();
    const url = req.url();
    if (!url.includes("pollo.ai") || STATIC_ASSET_RE.test(url)) return;
    const ct = res.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;
    res
      .text()
      .then((bodyText) => {
        logs.push(
          `<< ${res.status()} ${req.method()} ${url}\n   resp: ${bodyText.slice(0, 1500)}`,
        );
      })
      .catch(() => {});
  });

  try {
    const url = new URL("/image", config.polloBaseUrl).toString();
    console.log("Đang mở:", url);
    await gotoPolloWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 0 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismissBlockingOverlays(page);
    await ensureComposerReadyOrThrow(page, url, "tạo ảnh (network trace test)");

    const editor = promptEditorLocator(page).first();
    await editor.focus();
    await page.keyboard.insertText(
      "A simple photorealistic red apple on a white table, studio lighting, shallow depth of field",
    );
    await page.waitForTimeout(300);

    await enableUnlimitedIfNotEnoughCredit(page);

    const baseline = await resultCardLocator(page).count();
    const generateButton = generateButtonLocator(page).first();
    await waitForGenerateButtonEnabled(page, generateButton);

    logs.push("=== BẤM GENERATE ===");
    await clickWithOverlayDismiss(page, generateButton);

    const timeoutMs = 3 * 60_000;
    const start = Date.now();
    let lastPrinted = 0;
    while (Date.now() - start < timeoutMs) {
      await page.waitForTimeout(3000);
      if (logs.length > lastPrinted) {
        console.log(logs.slice(lastPrinted).join("\n\n"));
        lastPrinted = logs.length;
      }
      const count = await resultCardLocator(page).count();
      if (count > baseline) {
        console.log("=== PHÁT HIỆN CARD MỚI, dừng trace sau 5s nữa để bắt nốt log cuối ===");
        await page.waitForTimeout(5000);
        if (logs.length > lastPrinted) {
          console.log(logs.slice(lastPrinted).join("\n\n"));
          lastPrinted = logs.length;
        }
        break;
      }
    }

    console.log(`\n=== HẾT, tổng ${logs.length} dòng log (đã in ở trên) ===`);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
