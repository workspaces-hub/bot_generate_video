import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, fetchWithRetry } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import { resultVideoLocator } from "../src/automation/polloSelectors";

/**
 * One-off tái sử dụng: job VIDEO generate xong THẬT trên pollo.ai nhưng
 * script cũ hết timeout trước khi kịp thấy kết quả — server vẫn tiếp tục
 * render sau khi page đóng. Quét TẤT CẢ <video class="vjs-tech"> trên
 * /create, lấy video có timestamp trong tên file MỚI NHẤT SAU thời điểm
 * job bắt đầu, tải về rồi đặt đúng chỗ output.
 *
 * Đổi ENTRY_ID/JOB_START_MS/DEST_PATH mỗi lần dùng lại cho entry khác.
 */
const ENTRY_ID = "SHOT_12_CLIP_01_VIDEO";
const JOB_START_MS = new Date("2026-09-04T17:44:59.336Z").getTime();
// Chặn trên: entry KẾ TIẾP (SHOT_13) đã bắt đầu lỗi lúc 18:07:53 — nghĩa là
// queue đã chuyển sang xử lý entry khác trước mốc này. Video của SHOT_12
// (nếu có) PHẢI nằm trong khoảng [JOB_START_MS, SHOT_13_START_MS], không
// được lấy bừa "video sớm nhất sau JOB_START_MS" vì rất nhiều entry khác đã
// chạy tiếp sau đó hàng giờ, tạo ra nhiều video không liên quan.
const NEXT_ENTRY_START_MS = new Date("2026-09-04T18:07:53.474Z").getTime();
const DEST_PATH = path.resolve(`./storage/generated/EP01_drama/${ENTRY_ID}.mp4`);

function extractTimestamp(url: string): number | null {
  const m = url.match(/\/(\d{13})-/);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "recover-pollo-video-download";
  try {
    await page.goto(new URL("/create", config.polloBaseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await dismissBlockingOverlays(page);

    const videos = resultVideoLocator(page);
    const count = await videos.count();
    console.log(`Tổng số video trên trang: ${count}`);

    const candidates: { src: string; ts: number }[] = [];
    for (let i = 0; i < count; i++) {
      const src = await videos.nth(i).getAttribute("src").catch(() => null);
      if (!src) continue;
      const ts = extractTimestamp(src);
      if (ts !== null) candidates.push({ src, ts });
    }

    candidates.sort((a, b) => b.ts - a.ts);
    console.log("5 video gần nhất (mới nhất trước):");
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${new Date(c.ts).toISOString()} — ${c.src}`);
    }

    const inWindow = candidates.filter(
      (c) => c.ts >= JOB_START_MS - 60_000 && c.ts <= NEXT_ENTRY_START_MS,
    );
    console.log(
      `Video trong khoảng [${new Date(JOB_START_MS).toISOString()}, ${new Date(NEXT_ENTRY_START_MS).toISOString()}]:`,
      inWindow.length,
    );
    for (const c of inWindow) {
      console.log(`  ${new Date(c.ts).toISOString()} — ${c.src}`);
    }
    if (inWindow.length === 0) {
      throw new Error(
        "Không tìm thấy video nào trong đúng khoảng thời gian của entry này — có thể entry thật sự chưa render xong / lỗi thật, KHÔNG PHẢI chỉ chậm.",
      );
    }
    if (inWindow.length > 1) {
      throw new Error(
        `Tìm thấy ${inWindow.length} video trong khoảng thời gian này — không chắc video nào đúng, cần kiểm tra thủ công thay vì đoán.`,
      );
    }
    const target = inWindow[0];
    console.log("Chọn video:", target.src, new Date(target.ts).toISOString());

    const response = await fetchWithRetry(page, target.src);
    const buffer = await response.body();
    console.log(`Tải xong, kích thước: ${buffer.length} bytes`);

    if (buffer.length < 10_000) {
      throw new Error(`File tải về chỉ ${buffer.length} bytes — nghi ngờ không phải video thật.`);
    }

    await fs.promises.mkdir(path.dirname(DEST_PATH), { recursive: true });
    await fs.promises.writeFile(DEST_PATH, buffer);
    console.log(`Đã lưu: ${DEST_PATH}`);
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();
