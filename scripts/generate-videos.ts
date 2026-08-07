import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateVideo, type GenerateVideoOptions } from "../src/automation/hailuo";

interface RefItem {
  id?: string;
  type?: string;
}

interface StoryboardEntry {
  type?: string;
  id?: string;
  ref?: RefItem[];
  prompt?: string;
  duration?: number;
  /** true nếu lần generate video gần nhất bị lỗi — ghi lại vào file input gốc để biết entry nào cần chạy lại. */
  error?: boolean;
  [key: string]: unknown;
}

/** Chỉ giữ ký tự an toàn cho tên file — id trong JSON input có thể chứa dấu cách/ký tự lạ. Phải khớp với sanitizeId trong generate-reference-images.ts (dùng để đặt tên file ảnh ref). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Tìm file ảnh ref theo id trong 1 folder — ưu tiên đúng "<id>.png" (theo
 * đúng format user mô tả), fallback dò bất kỳ đuôi nào khác nếu không có
 * (generate-reference-images.ts lưu theo đuôi THẬT của ảnh GPT trả về, có
 * thể không phải .png — xem guessImageExtension trong chatgptImage.ts).
 */
async function resolveRefImagePath(dir: string, id: string): Promise<string> {
  const exact = path.join(dir, `${id}.png`);
  console.log("🚀 ~ resolveRefImagePath ~ exact:", exact)
  if (fs.existsSync(exact)) return exact;

  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(`${id}.`));
  if (match) return path.join(dir, match);

  throw new Error(`Không tìm thấy file ảnh tham chiếu cho id "${id}" trong ${dir}`);
}

/**
 * Đọc 1 file JSON storyboard (list entry {id, type, ref, prompt, duration,
 * ...} — cùng file input dùng chung với generate-reference-images.ts), lọc
 * entry type "VIDEO", rồi lần lượt gọi generateVideo trên hailuoai.video cho
 * từng entry.
 *
 * Chọn mode theo ref:
 * - ref.length > 0: mode "Omni Reference", ảnh/file ref lấy từ
 *   reference-images/<tên file input>/characters|locations/<ref.id>.png
 *   (tuỳ ref.type).
 * - ref.length === 0 (hoặc không có): mode "Start/End Frame" — KHÔNG upload
 *   ảnh start frame nào (chỉ tạo video thuần từ prompt).
 *
 * Video tạo xong được lưu vào reference-images/<tên file input>/videos/<id>.mp4.
 *
 * Chạy TUẦN TỰ từng entry (không song song) — cùng 1 browser context
 * hailuoai.video dùng chung, tránh nhiều tab cùng thao tác gây xung đột
 * (đúng nguyên tắc queue video/ảnh/gpt hiện có trong src/queue.ts).
 *
 * Entry nào generate lỗi được đánh dấu "error": true, thành công thì
 * "error": false — LUÔN ghi tường minh (không xoá field), để phân biệt được
 * với entry CHƯA TỪNG chạy. Sau khi xử lý xong HẾT (kể cả có lỗi), ghi đè lại
 * TOÀN BỘ mảng vào đúng file input gốc.
 *
 * Cách dùng: npm run generate-videos -- <inputJsonPath>
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Cách dùng: npm run generate-videos -- <inputJsonPath>");
    process.exit(1);
  }

  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const refImagesDir = path.resolve("./storage/reference-images", baseName);
  const charactersDir = path.join(refImagesDir, "characters");
  const locationsDir = path.join(refImagesDir, "locations");
  const videosDir = path.join(refImagesDir, "videos");
  await fs.promises.mkdir(videosDir, { recursive: true });

  const targets = entries.filter(
    (e): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> & StoryboardEntry => {
      if (e.type !== "VIDEO") return false;
      if (!e.id || !e.prompt) {
        console.warn(`Bỏ qua entry thiếu "id"/"prompt":`, e);
        return false;
      }
      return true;
    },
  );
  console.log(`Tìm thấy ${targets.length} entry VIDEO trong ${entries.length} entry.`);

  let succeeded = 0;
  let failed = 0;
  for (const entry of targets) {
    const jobId = randomUUID();
    console.log(`[VIDEO] ${entry.id} — đang tạo video...`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<RefItem> => Boolean(r.id) && (r.type === "CHARACTER" || r.type === "LOCATION"),
      );

      const refPaths: string[] = [];
      for (const ref of refs) {
        const dir = ref.type === "CHARACTER" ? charactersDir : locationsDir;
        refPaths.push(await resolveRefImagePath(dir, sanitizeId(ref.id)));
      }

      if (entry.duration) {
        console.warn(
          `[VIDEO] ${entry.id} — field "duration" (${entry.duration}s) chưa được hỗ trợ tự động chọn trên hailuoai.video, bỏ qua (dùng độ dài mặc định của trang).`,
        );
      }

      const options: GenerateVideoOptions =
        refPaths.length > 0 ? { omniReferencePaths: refPaths } : {};

      const tempFilePath = await generateVideo(entry.prompt, options, jobId);

      const destPath = path.join(videosDir, `${sanitizeId(entry.id)}.mp4`);
      try {
        await fs.promises.rename(tempFilePath, destPath);
      } catch {
        // rename có thể lỗi nếu khác device/filesystem — fallback copy + xoá file tạm.
        await fs.promises.copyFile(tempFilePath, destPath);
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }

      console.log(`[VIDEO] ${entry.id} — đã lưu: ${destPath}`);
      entry.error = false;
      succeeded++;
    } catch (err) {
      console.error(`[VIDEO] ${entry.id} — lỗi:`, err instanceof Error ? err.message : err);
      entry.error = true;
      failed++;
    }
  }

  await fs.promises.writeFile(inputPath, JSON.stringify(entries, null, 2), "utf-8");
  console.log(`Đã cập nhật lại file gốc: ${inputPath}`);

  console.log(`\nHoàn tất: ${succeeded} thành công, ${failed} lỗi. Output: ${videosDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
