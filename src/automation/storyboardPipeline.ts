import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateReferenceImage } from "./chatAIImage";
import { generateVideo, type GenerateVideoOptions } from "./aiVideo";
import { generateImage } from "./aiVideoImage";

/**
 * Logic dùng CHUNG cho cả 2 nơi gọi: script CLI (scripts/generate-reference-images.ts,
 * scripts/generate-videos.ts) và bot Telegram (xử lý job "chatAI" trong
 * src/queue.ts, sau khi askChatAI tải về file JSON storyboard) — tránh viết
 * trùng cùng 1 logic ở 2 chỗ.
 */

export interface StoryboardRefItem {
  id?: string;
  type?: string;
}

export interface StoryboardEntry {
  type?: string;
  id?: string;
  ref?: StoryboardRefItem[];
  prompt?: string;
  duration?: number;
  /** true/false nếu đã từng generate (ảnh hoặc video) THÀNH CÔNG hay không — không có field này nghĩa là CHƯA TỪNG chạy. */
  success?: boolean;
  /** Id hội thoại ChatAI (phần "/c/<id>" trên URL) lúc gen ảnh cho entry này — chỉ có ở entry CHARACTER/LOCATION/SCENE_SETTING (dùng ChatAI), VIDEO không có (dùng AIVideo). */
  chatAISessionId?: string;
  [key: string]: unknown;
}

/** Chỉ giữ ký tự an toàn cho tên file — id trong JSON input có thể chứa dấu cách/ký tự lạ. */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Chờ ms mili giây — dùng giữa các lần gọi generateReferenceImage/askChatAI
 * liên tiếp (xem generateReferenceImagesForFile/generateSceneImagesForFile
 * bên dưới, và processChatAIQueue trong queue.ts), tránh gửi request quá nhanh
 * liên tiếp lên ChatAI (theo yêu cầu người dùng, giảm rủi ro rate-limit
 * hoặc bị nghi ngờ bot).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REQUEST_THROTTLE_MS = 15000;

/**
 * Cờ dừng SỚM toàn cục cho 3 vòng lặp generateReferenceImagesForFile/
 * generateSceneImagesForFile/generateVideosForFile — dùng cho nút "Stop All"
 * (xem stopAll() trong queue.ts). Entry ĐANG generate dở (đã gọi
 * generateReferenceImage/generateVideo, còn đang chờ Playwright chạy xong)
 * được để chạy XONG BÌNH THƯỜNG, không bị abort giữa chừng — chỉ các entry
 * CHƯA bắt đầu (lượt lặp KẾ TIẾP của vòng for) mới bị bỏ qua, giữ nguyên
 * "success" chưa xác định để lần chạy lại sau (resume) vẫn xử lý tiếp được.
 *
 * Cờ CHUNG cho mọi file/job (không phân biệt theo jobId) — đúng ý nghĩa
 * "Stop All" (dừng tất cả), đơn giản hơn nhiều so với theo dõi riêng từng
 * job. Phải gọi clearStopStoryboardRequest() SAU KHI job đang dừng đã thực
 * sự thoát hẳn (xem processChatAIQueue trong queue.ts), nếu không các job MỚI
 * sau đó sẽ bị chặn nhầm ngay từ đầu.
 */
let stopStoryboardRequested = false;

export function requestStopStoryboardPipeline(): void {
  stopStoryboardRequested = true;
}

export function clearStopStoryboardRequest(): void {
  stopStoryboardRequested = false;
}

export function isStopStoryboardRequested(): boolean {
  return stopStoryboardRequested;
}

/**
 * Ghi đè lại TOÀN BỘ mảng entries vào file input — gọi lại NGAY sau MỖI entry
 * xử lý xong (không đợi hết cả loạt), để nếu tiến trình bị dừng/crash giữa
 * chừng (vd hết credit, mất mạng ở entry sau) thì các entry ĐÃ generate trước
 * đó không bị mất field "success" đã cập nhật.
 */
async function saveEntries(
  inputPath: string,
  entries: StoryboardEntry[],
): Promise<void> {
  await fs.promises.writeFile(
    inputPath,
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
}

/** Thư mục generated/<tên file input, bỏ đuôi> — DÙNG CHUNG giữa bước tạo ảnh và tạo video của CÙNG 1 file input. */
export function generatedDirFor(inputPath: string): string {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.resolve("./storage/generated", baseName);
}

/**
 * Tạo (nếu chưa có) folder generated/<tên file input>/ và copy file
 * input JSON vào đó — gọi SỚM, NGAY sau khi ChatAI trả JSON xong (xem
 * processChatAIQueue trong queue.ts), TRƯỚC KHI user xác nhận có gen ảnh hay
 * không, để user có thể upload ảnh/JSON thay thế vào đúng folder trong lúc
 * chờ xác nhận (xem tryReplaceGeneratedFile trong handlers.ts). Các hàm
 * generate*ForFile bên dưới cũng tự làm việc này khi chạy (idempotent, ghi
 * đè an toàn) nên gọi hàm này trước không ảnh hưởng gì tới chúng.
 */
export async function ensureGeneratedFolder(
  inputPath: string,
): Promise<string> {
  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );
  return outputDir;
}

export interface FailedEntry {
  id: string;
  type: string;
}

export interface GenerateImagesResult {
  outputDir: string;
  succeeded: number;
  failed: number;
  failedEntries: FailedEntry[];
}

/**
 * Đọc 1 file JSON storyboard (list entry {type, id, prompt, ...} — output
 * của tính năng ChatAI storyboard, xem askChatAI/downloadAttachedFiles trong
 * chatAI.ts), lọc entry CHARACTER/LOCATION (bỏ qua VIDEO vì đó là prompt tạo
 * VIDEO, không phải ảnh), rồi lần lượt nhờ ChatAI tạo ảnh cho từng entry và tải
 * về CHUNG 1 folder generated/<tên file input>/<id>.<đuôi> — không
 * chia riêng characters/locations nữa (đơn giản hoá, dễ duyệt file).
 *
 * Chạy TUẦN TỰ từng entry (không song song) — cùng 1 browser context
 * ChatAI dùng chung, tránh nhiều tab cùng thao tác gây xung đột.
 *
 * Entry nào generate thành công được đánh dấu "success": true, lỗi thì
 * "success": false — LUÔN ghi tường minh (không xoá field), để phân biệt được
 * với entry CHƯA TỪNG chạy. Ghi đè lại TOÀN BỘ mảng vào đúng file input gốc
 * NGAY sau MỖI entry (xem saveEntries) — không đợi xử lý xong hết cả loạt.
 *
 * onEntryDone (tuỳ chọn): gọi NGAY sau MỖI entry generate ảnh THÀNH CÔNG (path
 * ảnh vừa lưu) — dùng để gửi file về cho user NGAY LÚC ĐÓ (xem queue.ts) thay
 * vì đợi xử lý xong hết cả file mới gửi hàng loạt. Lỗi từ callback này (vd
 * gửi Telegram thất bại) KHÔNG được coi là lỗi generate — chỉ log cảnh báo,
 * không đánh dấu entry.success = false (ảnh đã tạo thành công thật, chỉ gửi
 * lỗi thôi, không nên bắt generate lại tốn credit).
 */
export async function generateReferenceImagesForFile(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
): Promise<GenerateImagesResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "CHARACTER" && e.type !== "LOCATION") return false;
      // Chỉ gen khi "prompt" là string thật — entry thiếu id, hoặc prompt bị
      // sai kiểu (số/object/null từ JSON input lỗi) đều bỏ qua thay vì gọi
      // generateReferenceImage với giá trị không phải string.
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        // console.warn(`[storyboardPipeline] Bỏ qua entry thiếu "id"/"prompt" hợp lệ:`, e);
        return false;
      }
      return true;
    },
  );
  // console.log(
  //   `[storyboardPipeline] Tìm thấy ${targets.length} entry CHARACTER/LOCATION trong ${entries.length} entry (${inputPath}).`,
  // );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  for (const entry of targets) {
    if (isStopStoryboardRequested()) break;
    if (entry?.success) continue;
    const jobId = randomUUID();
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh...`,
    );
    try {
      const result = await generateReferenceImage(
        entry.prompt,
        outputDir,
        sanitizeId(entry.id),
        jobId,
      );
      console.log(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — đã lưu: ${result.path}`,
      );
      entry.success = true;
      entry.chatAISessionId = result.sessionId;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(result.path).catch((err) => {
          console.error(
            `[storyboardPipeline] Gửi file "${result.path}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: entry.type });
    }
    await saveEntries(inputPath, entries);
    // Chờ giữa các lần gọi gen ảnh liên tiếp — tránh gửi request quá nhanh
    // lên ChatAI (theo yêu cầu người dùng).
    await sleep(REQUEST_THROTTLE_MS);
  }

  return {
    outputDir,
    succeeded,
    failed,
    failedEntries,
  };
}

/**
 * GIỐNG generateReferenceImagesForFile (cùng đọc/lọc entry CHARACTER/
 * LOCATION, cùng quy ước lưu file/success/onEntryDone/resume) nhưng tạo ảnh
 * qua AIVideo (generateImage trong aiVideoImage.ts) THAY VÌ hỏi ChatAI
 * (ChatAI) — dùng khi muốn tránh phụ thuộc ChatAI hoặc đổi nguồn
 * tạo ảnh. Hàm RIÊNG, KHÔNG sửa generateReferenceImagesForFile — cả 2 hàm
 * cùng ghi vào field "success"/lưu file cùng quy ước (<id>.<đuôi> trong
 * generated/<tên file input>/) nên hoàn toàn tương thích ngược: ảnh
 * tạo bằng hàm nào cũng dùng được làm ref cho generateSceneImagesForFile/
 * generateVideosForFile sau đó.
 *
 * generateImage() trả về CẢ CỤM ảnh (thường 4 ảnh/lần, xem aiVideoImage.ts) —
 * chỉ lấy ảnh ĐẦU TIÊN đặt tên "<id>.<đuôi>" (khớp đúng 1 file/id như
 * resolveRefImagePath cần), các ảnh còn lại trong cụm bị xoá luôn (không giữ
 * làm rác, vì entry.ref chỉ có thể trỏ tới 1 ảnh/id).
 */
export async function generateReferenceImagesForFileViaAIVideo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (id: string) => Promise<void>,
): Promise<GenerateImagesResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "CHARACTER" && e.type !== "LOCATION") return false;
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));
  for (const entry of targets) {
    if (isStopStoryboardRequested()) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh (aiVideo)...`,
    );
    let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
    try {
      const imagePaths = await generateImage(
        entry.prompt,
        { imageCount: 1 },
        jobId,
      );
      if (imagePaths.length === 0) {
        throw new Error("Không tạo được ảnh nào");
      }
      const [firstImage, ...extraImages] = imagePaths;
      destPath = path.join(
        outputDir,
        `${sanitizeId(entry.id)}${path.extname(firstImage)}`,
      );
      try {
        await fs.promises.rename(firstImage, destPath);
      } catch {
        await fs.promises.copyFile(firstImage, destPath);
        await fs.promises.unlink(firstImage).catch(() => {});
      }
      for (const extra of extraImages) {
        await fs.promises.unlink(extra).catch(() => {});
      }
      console.log(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — đã lưu: ${destPath}`,
      );
      entry.success = true;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(destPath).catch((err) => {
          console.error(
            `[storyboardPipeline] Gửi file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: entry.type });
      if (onEntryError) {
        await onEntryError(entry.id).catch((err) => {
          console.error(
            `[storyboardPipeline] Thông báo tạo file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    }
    await saveEntries(inputPath, entries);
  }

  return {
    outputDir,
    succeeded,
    failed,
    failedEntries,
  };
}

/**
 * Tìm file ảnh ref theo id trong 1 folder — ưu tiên đúng "<id>.png", fallback
 * dò bất kỳ đuôi nào khác nếu không có (generate-reference-images lưu theo
 * đuôi THẬT của ảnh ChatAI trả về, có thể không phải .png — xem
 * guessImageExtension trong chatAIImage.ts).
 */
async function resolveRefImagePath(dir: string, id: string): Promise<string> {
  const exact = path.join(dir, `${id}.png`);
  if (fs.existsSync(exact)) return exact;

  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(`${id}.`));
  if (match) return path.join(dir, match);

  throw new Error(
    `Không tìm thấy file ảnh tham chiếu cho id "${id}" trong ${dir}`,
  );
}

export interface GenerateVideosResult {
  outputDir: string;
  succeeded: number;
  failed: number;
  failedEntries: FailedEntry[];
}

/**
 * Quyết định ảnh nào đi vào start frame/end frame từ danh sách refPaths ĐÃ
 * lọc (0-2 ảnh — 3+ ảnh dùng Omni Reference thay vì hàm này, xem
 * generateVideosForFile):
 * - 1 ảnh: LUÔN dùng làm start frame.
 * - 2 ảnh: ảnh nào có tên file (basename) chứa "start" → start frame, chứa
 *   "end" → end frame. Nếu không xác định được qua tên (không ảnh nào khớp
 *   "start"/"end"), fallback theo đúng THỨ TỰ khai báo trong "ref": ảnh đầu
 *   → start, ảnh sau → end.
 * - 0 ảnh: trả về rỗng (video thuần từ prompt, không upload ảnh nào).
 */
function assignStartEndFrames(
  refPaths: string[],
): Pick<GenerateVideoOptions, "startFramePath" | "endFramePath"> {
  if (refPaths.length === 0) return {};
  if (refPaths.length === 1) return { startFramePath: refPaths[0] };

  const startPath = refPaths.find((p) => /start/i.test(path.basename(p)));
  const endPath = refPaths.find((p) => /end/i.test(path.basename(p)));
  if (startPath || endPath) {
    return {
      startFramePath: startPath ?? refPaths.find((p) => p !== endPath),
      endFramePath: endPath,
    };
  }
  return { startFramePath: refPaths[0], endFramePath: refPaths[1] };
}

/**
 * Đọc 1 file JSON storyboard (CÙNG file input dùng chung với
 * generateReferenceImagesForFile), lọc entry type "VIDEO", rồi lần lượt gọi
 * generateVideo trên AIVideo cho từng entry.
 *
 * ref có thể trỏ tới entry CHARACTER, LOCATION hoặc SCENE_SETTING (đều đã
 * generate ảnh trước đó, cùng lưu trong generated/<tên file input>/).
 *
 * Chọn mode theo số ảnh ref resolve được:
 * - >= 3 ảnh: mode "Omni Reference".
 * - 1-2 ảnh: mode "Start/End Frame", ảnh lấy từ
 *   generated/<tên file input>/<ref.id>.png (xem assignStartEndFrames
 *   để biết cách chọn ảnh nào vào start/end) — PHẢI đã chạy
 *   generateReferenceImagesForFile/generateSceneImagesForFile trước đó (tuỳ
 *   type của ref).
 * - 0 ảnh (không có ref): mode "Start/End Frame" nhưng KHÔNG upload ảnh nào
 *   (chỉ tạo video thuần từ prompt).
 *
 * Video tạo xong lưu CHUNG vào generated/<tên file input>/<id>.mp4 —
 * cùng 1 folder với ảnh character/location/scene setting (không tách riêng
 * folder "videos").
 *
 * Chạy TUẦN TỰ, đánh dấu "success" trên từng entry, ghi đè lại file input gốc
 * NGAY sau MỖI entry — cùng quy tắc với generateReferenceImagesForFile.
 *
 * onEntryDone (tuỳ chọn): gọi NGAY sau MỖI video tạo THÀNH CÔNG (path video
 * vừa lưu) — cùng cơ chế/lý do với generateReferenceImagesForFile.
 */
export async function generateVideosForFile(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
): Promise<GenerateVideosResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "VIDEO") return false;
      // Chỉ gen khi "prompt" là string thật — xem lý do ở generateReferenceImagesForFile.
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        // console.warn(`[storyboardPipeline] Bỏ qua entry thiếu "id"/"prompt" hợp lệ:`, e);
        return false;
      }
      return true;
    },
  );
  // console.log(
  //   `[storyboardPipeline] Tìm thấy ${targets.length} entry VIDEO trong ${entries.length} entry (${inputPath}).`,
  // );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));

  for (const entry of targets) {
    if (isStopStoryboardRequested()) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    // console.log(`[storyboardPipeline] [VIDEO] ${entry.id} — đang tạo video...`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING"),
      );

      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      // if (entry.duration) {
      // console.warn(
      //   `[storyboardPipeline] [VIDEO] ${entry.id} — field "duration" (${entry.duration}s) chưa được hỗ trợ tự động chọn trên AIVideo, bỏ qua.`,
      // );
      // }

      const options: GenerateVideoOptions =
        refPaths.length >= 3
          ? { omniReferencePaths: refPaths }
          : assignStartEndFrames(refPaths);

      // Check lại NGAY TRƯỚC khi gọi generateVideo (không chỉ ở đầu vòng for)
      // — resolveRefImagePath ở trên là async (đọc đĩa), Stop All có thể vừa
      // được bấm đúng lúc đang chờ đoạn đó. Entry CHƯA gọi generateVideo (chưa
      // tốn credit AIVideo) nên bỏ qua an toàn — giữ "success" chưa xác
      // định để resume sau, đúng ý "chưa gen thì ko gen nữa".
      if (isStopStoryboardRequested()) break;

      const tempFilePath = await generateVideo(entry.prompt, options, jobId);

      const destPath = path.join(outputDir, `${sanitizeId(entry.id)}.mp4`);
      try {
        await fs.promises.rename(tempFilePath, destPath);
      } catch {
        await fs.promises.copyFile(tempFilePath, destPath);
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }

      // console.log(`[storyboardPipeline] [VIDEO] ${entry.id} — đã lưu: ${destPath}`);
      entry.success = true;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(destPath).catch((err) => {
          console.error(
            `[storyboardPipeline] Gửi file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [VIDEO] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: "VIDEO" });
    }
    await saveEntries(inputPath, entries);
  }

  return { outputDir, succeeded, failed, failedEntries };
}

/**
 * Đọc 1 file JSON storyboard (CÙNG file input dùng chung với
 * generateReferenceImagesForFile/generateVideosForFile), lọc entry type
 * "SCENE_SETTING", rồi nhờ ChatAI tạo ảnh bối cảnh cho từng entry.
 *
 * Nếu entry có "ref" (trỏ tới CHARACTER/LOCATION đã generate trước đó bằng
 * generateReferenceImagesForFile), upload các ảnh ref đó lên ChatAI
 * TRƯỚC khi gõ prompt (xem generateReferenceImage's refImagePaths) để ChatAI vẽ
 * cảnh giữ đúng nhận diện nhân vật/địa điểm đã có. Không có "ref" thì generate
 * thuần từ prompt (giống CHARACTER/LOCATION).
 *
 * Ảnh lưu CHUNG vào generated/<tên file input>/<id>.<đuôi> — cùng 1
 * folder với ảnh CHARACTER/LOCATION/video (không tách folder riêng).
 *
 * Chạy TUẦN TỰ, đánh dấu "success" trên từng entry, ghi đè lại file input gốc
 * NGAY sau MỖI entry — cùng quy tắc với generateReferenceImagesForFile.
 *
 * onEntryDone (tuỳ chọn): gọi NGAY sau MỖI entry generate ảnh THÀNH CÔNG —
 * cùng cơ chế/lý do với generateReferenceImagesForFile.
 */
export async function generateSceneImagesForFile(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
): Promise<GenerateImagesResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "SCENE_SETTING") return false;
      // Chỉ gen khi "prompt" là string thật — xem lý do ở generateReferenceImagesForFile.
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));
  for (const entry of targets) {
    if (isStopStoryboardRequested()) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    try {
      // Xác nhận qua thực tế (job d1bf82f7, entry SCENE_19_END): JSON
      // storyboard có thể tự khai báo ref TỚI 1 entry SCENE_SETTING khác (vd
      // "SCENE_19_START" làm ảnh "opening frame" cho "SCENE_19_END") — chấp
      // nhận cả type SCENE_SETTING, không chỉ CHARACTER/LOCATION.
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING"),
      );
      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      const result = await generateReferenceImage(
        entry.prompt,
        outputDir,
        sanitizeId(entry.id),
        jobId,
        refPaths,
      );
      console.log(
        `[storyboardPipeline] [SCENE_SETTING] ${entry.id} — đã lưu: ${result.path}`,
      );
      entry.success = true;
      entry.chatAISessionId = result.sessionId;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(result.path).catch((err) => {
          console.error(
            `[storyboardPipeline] Gửi file "${result.path}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [SCENE_SETTING] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: "SCENE_SETTING" });
    }
    await saveEntries(inputPath, entries);
    // Chờ giữa các lần gọi gen ảnh liên tiếp — tránh gửi request quá nhanh
    // lên ChatAI (theo yêu cầu người dùng).
    await sleep(REQUEST_THROTTLE_MS);
  }

  return { outputDir, succeeded, failed, failedEntries };
}

/**
 * GIỐNG generateSceneImagesForFile (cùng đọc/lọc entry SCENE_SETTING, cùng
 * quy ước resolve ref CHARACTER/LOCATION/SCENE_SETTING, lưu file/success/
 * onEntryDone/resume) nhưng tạo ảnh qua AIVideo (generateImage trong
 * aiVideoImage.ts, cùng cách generateReferenceImagesForFileViaAIVideo đã làm)
 * THAY VÌ hỏi ChatAI. Hàm RIÊNG, KHÔNG sửa generateSceneImagesForFile.
 *
 * Ảnh ref (nếu có) truyền qua GenerateImageOptions.referenceImagePaths —
 * AIVideo hỗ trợ tối đa 16 ảnh tham chiếu, dư sức cho vài ảnh
 * CHARACTER/LOCATION/SCENE_SETTING thường gặp mỗi entry.
 *
 * generateImage() trả về CẢ CỤM ảnh — chỉ lấy ảnh ĐẦU TIÊN đặt tên
 * "<id>.<đuôi>", các ảnh còn lại trong cụm bị xoá luôn — cùng lý do đã giải
 * thích ở generateReferenceImagesForFileViaAIVideo.
 */
export async function generateSceneImagesForFileViaAIVideo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string) => Promise<void>,
): Promise<GenerateImagesResult> {
  const raw = await fs.promises.readFile(inputPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("File input phải là 1 JSON array");
  }

  const outputDir = generatedDirFor(inputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(
    inputPath,
    path.join(outputDir, path.basename(inputPath)),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "SCENE_SETTING") return false;
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));
  for (const entry of targets) {
    if (isStopStoryboardRequested()) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    console.log(
      `[storyboardPipeline] [SCENE_SETTING] ${entry.id} — đang tạo ảnh (aiVideo)...`,
    );
    let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING"),
      );
      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      const imagePaths = await generateImage(
        entry.prompt,
        { referenceImagePaths: refPaths, imageCount: 1 },
        jobId,
      );
      if (imagePaths.length === 0) {
        throw new Error("Không tạo được ảnh nào");
      }
      const [firstImage, ...extraImages] = imagePaths;
      destPath = path.join(
        outputDir,
        `${sanitizeId(entry.id)}${path.extname(firstImage)}`,
      );
      try {
        await fs.promises.rename(firstImage, destPath);
      } catch {
        await fs.promises.copyFile(firstImage, destPath);
        await fs.promises.unlink(firstImage).catch(() => {});
      }
      for (const extra of extraImages) {
        await fs.promises.unlink(extra).catch(() => {});
      }
      console.log(
        `[storyboardPipeline] [SCENE_SETTING] ${entry.id} — đã lưu: ${destPath}`,
      );
      entry.success = true;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(destPath).catch((err) => {
          console.error(
            `[storyboardPipeline] Gửi file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [SCENE_SETTING] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: "SCENE_SETTING" });
      if (onEntryError) {
        await onEntryError(entry.id).catch((err) => {
          console.error(
            `[storyboardPipeline] Thông báo tạo file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
      }
    }
    await saveEntries(inputPath, entries);
  }

  return { outputDir, succeeded, failed, failedEntries };
}
