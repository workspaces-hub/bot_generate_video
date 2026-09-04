import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot, captureSnapshot, fetchWithRetry } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";
import { resultVideoLocator } from "../src/automation/polloSelectors";

/**
 * One-off tái sử dụng (đã dùng lần trước cho SHOT_01_CLIP_01_VIDEO): job
 * VIDEO generate xong THẬT trên pollo.ai nhưng script cũ hết timeout (20
 * phút) trước khi kịp thấy kết quả — server vẫn tiếp tục render sau khi
 * page đóng. Quét TẤT CẢ <video class="vjs-tech"> trên /create (không dùng
 * resultCardLocator — data-widget-name="project_content_card" là 1 GRID
 * CONTAINER chứa nhiều item, không phải 1 card đơn, đã xác nhận lần trước),
 * lấy video có timestamp trong tên file MỚI NHẤT SAU thời điểm job bắt đầu,
 * tải về rồi đặt đúng chỗ output.
 *
 * Đổi ENTRY_ID/JOB_START_MS mỗi lần dùng lại cho entry khác.
 */
const ENTRY_ID = "SHOT_01_CLIP_02_VIDEO";
const JOB_START_MS = new Date("2026-09-04T06:30:24.075Z").getTime();
const DEST_PATH = path.resolve(`./storage/generated/cay_khe_rm_end/${ENTRY_ID}.mp4`);
const JSON_PATH = path.resolve("./storage/generated/cay_khe_rm_end/cay_khe_rm_end.json");

function extractTimestamp(url: string): number | null {
  const m = url.match(/\/(\d{13})-/);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "recover-pollo-video-download-2";
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

    const afterJobStart = candidates.filter((c) => c.ts >= JOB_START_MS - 60_000);
    if (afterJobStart.length === 0) {
      throw new Error(
        `Không tìm thấy video nào có timestamp sau ${new Date(JOB_START_MS).toISOString()} (job start).`,
      );
    }
    const target = afterJobStart[afterJobStart.length - 1]; // cũ nhất trong nhóm "sau job start" = khớp job này nhất (job kế tiếp sẽ mới hơn nữa)
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

    const raw = await fs.promises.readFile(JSON_PATH, "utf-8");
    const entries = JSON.parse(raw);
    const entry = entries.find((e: { id?: string }) => e.id === ENTRY_ID);
    if (entry) {
      entry.success = true;
      await fs.promises.writeFile(JSON_PATH, JSON.stringify(entries, null, 2), "utf-8");
      console.log("Đã đánh dấu success=true trong JSON.");
    } else {
      console.warn(`Không tìm thấy entry ${ENTRY_ID} trong JSON để đánh dấu success.`);
    }

    await captureSnapshot(page, jobId, "after-recover");
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
