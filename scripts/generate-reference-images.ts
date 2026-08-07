import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateReferenceImage } from "../src/automation/chatgptImage";

interface StoryboardEntry {
  type?: string;
  id?: string;
  prompt?: string;
  /** true nếu lần generate ảnh gần nhất bị lỗi — ghi lại vào file input gốc để biết entry nào cần chạy lại. */
  error?: boolean;
  [key: string]: unknown;
}

/** Chỉ giữ ký tự an toàn cho tên file — id trong JSON input có thể chứa dấu cách/ký tự lạ. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Đọc 1 file JSON storyboard (list entry {type, id, prompt, ...} — output
 * của tính năng GPT storyboard, xem askChatGpt/downloadAttachedFiles trong
 * src/automation/chatgpt.ts), lọc entry CHARACTER/LOCATION (bỏ qua VIDEO vì
 * đó là prompt tạo VIDEO, không phải ảnh), rồi lần lượt nhờ GPT tạo ảnh cho
 * từng entry và tải về.
 *
 * Output: 1 folder cùng tên file input (bỏ đuôi), bên trong có 2 folder con
 * "characters" và "locations", mỗi ảnh lưu tên "<id>.<đuôi>".
 *
 * Chạy TUẦN TỰ từng entry (không song song) — cùng 1 browser context
 * chatgpt.com dùng chung, tránh nhiều tab cùng thao tác gây xung đột (đúng
 * nguyên tắc queue video/ảnh/gpt hiện có trong src/queue.ts).
 *
 * Entry nào generate lỗi được đánh dấu "error": true, thành công thì
 * "error": false — LUÔN ghi tường minh (không xoá field), để phân biệt được
 * với entry CHƯA TỪNG chạy (không có field "error" nào cả). Sau khi xử lý
 * xong HẾT (kể cả có lỗi), ghi đè lại TOÀN BỘ mảng vào đúng file input gốc —
 * để biết entry nào cần chạy lại mà không cần dò log.
 *
 * Cách dùng: npm run generate-reference-images -- <inputJsonPath>
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Cách dùng: npm run generate-reference-images -- <inputJsonPath>");
    process.exit(1);
  }

  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputDir = path.resolve("./storage/reference-images", baseName);
  const charactersDir = path.join(outputDir, "characters");
  const locationsDir = path.join(outputDir, "locations");
  await fs.promises.mkdir(charactersDir, { recursive: true });
  await fs.promises.mkdir(locationsDir, { recursive: true });

  const targets = entries.filter(
    (e): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> & StoryboardEntry => {
      if (e.type !== "CHARACTER" && e.type !== "LOCATION") return false;
      if (!e.id || !e.prompt) {
        console.warn(`Bỏ qua entry thiếu "id"/"prompt":`, e);
        return false;
      }
      return true;
    },
  );
  console.log(`Tìm thấy ${targets.length} entry CHARACTER/LOCATION trong ${entries.length} entry.`);

  let succeeded = 0;
  let failed = 0;
  for (const entry of targets) {
    const destDir = entry.type === "CHARACTER" ? charactersDir : locationsDir;
    const jobId = randomUUID();
    console.log(`[${entry.type}] ${entry.id} — đang tạo ảnh...`);
    try {
      const savedPath = await generateReferenceImage(
        entry.prompt,
        destDir,
        sanitizeId(entry.id),
        jobId,
      );
      console.log(`[${entry.type}] ${entry.id} — đã lưu: ${savedPath}`);
      entry.error = false;
      succeeded++;
    } catch (err) {
      console.error(`[${entry.type}] ${entry.id} — lỗi:`, err instanceof Error ? err.message : err);
      entry.error = true;
      failed++;
    }
  }

  await fs.promises.writeFile(inputPath, JSON.stringify(entries, null, 2), "utf-8");
  console.log(`Đã cập nhật lại file gốc: ${inputPath}`);

  console.log(`\nHoàn tất: ${succeeded} thành công, ${failed} lỗi. Output: ${outputDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
