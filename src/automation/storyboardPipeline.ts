import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { generateReferenceImage } from "./chatAIImage";
import { generateVideo, type GenerateVideoOptions } from "./aiVideo";
import { generateImage } from "./aiVideoImage";
import {
  reviseGenerationPrompt,
  verifyVideo,
  type VerifyVideoRef,
} from "./chatAI";
import { generateVideo as generateVideoPollo } from "./pollo";
import { generateImage as generateImagePollo } from "./polloImage";
import { withPolloTaskSlot } from "./polloBrowser";
import {
  generateVideoComfyMiniMaxH3,
  MAX_MINIMAX_H3_REFERENCE_IMAGES,
} from "./comfyui";

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
  /** Tỉ lệ khung hình VIDEO ("9:16"/"16:9", xem format_output.txt) — chỉ có ở entry type VIDEO. */
  aspectRatio?: string;
  /** Số khung hình/giây (fps) của VIDEO, xem format_output.txt — chỉ có ở entry type VIDEO. */
  frameRate?: number;
  /** true/false nếu đã từng generate (ảnh hoặc video) THÀNH CÔNG hay không — không có field này nghĩa là CHƯA TỪNG chạy. */
  success?: boolean;
  /** Id hội thoại ChatAI (phần "/c/<id>" trên URL) lúc gen ảnh cho entry này — chỉ có ở entry CHARACTER/LOCATION/SCENE_SETTING (dùng ChatAI), VIDEO không có (dùng AIVideo). */
  chatAISessionId?: string;
  /** Id nội bộ pollo.ai (phần "/v/<id>" trên URL, vd https://pollo.ai/create?target=text-to-image&videoId=<id>) của kết quả gen ảnh/video mới nhất qua Pollo cho entry này — theo yêu cầu người dùng, xem captureResultId trong pollo.ts. */
  polloResultId?: string;
  /** prompt_id ComfyUI trả về (xem POST /prompt trong comfyui.ts) của lần gen video ComfyUI mới nhất cho entry này — cùng ý nghĩa/lý do lưu với polloResultId. */
  comfyPromptId?: string;
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

/**
 * Site AIVideo từ chối vì vi phạm chính sách nội dung — nguyên văn xác nhận
 * qua log lỗi thật: "Generation failed because content violated Community
 * Guidelines. Your prompt or image may contain sensitive terms or
 * copyrighted IP (e.g. character names or likenesses). Please revise and
 * retry." Match rộng theo cụm từ đặc trưng thay vì nguyên câu, phòng site đổi
 * chữ nhưng vẫn cùng ý (vd rút gọn câu sau).
 *
 * "flagged by the third-party model" — thêm cho pollo.ai, xác nhận qua lỗi
 * thật (job test_master_live_CHARACTER_LAM_YEN_NHIEN): card kết quả hiện
 * nguyên văn "Input flagged by the third-party model. Please modify your
 * input and try again. Credits refunded." (xem waitForNewResult trong
 * polloImage.ts/pollo.ts) — cùng BẢN CHẤT vi phạm chính sách nội dung như
 * AIVideo, chỉ khác chữ, nên gộp chung pattern để generateWithContentViolationRetry
 * bên dưới cũng tự nhờ ChatAI viết lại prompt cho pollo.ai thay vì bỏ cuộc
 * ngay (trước đây pollo.ai KHÔNG match được pattern cũ, luôn rơi vào lỗi
 * chung "không thấy ảnh nào", không bao giờ kích hoạt retry).
 */
const CONTENT_VIOLATION_PATTERN =
  /community guidelines|sensitive terms|copyrighted ip|flagged by the third-party model/i;

function isContentViolationError(errorMessage: string): boolean {
  return CONTENT_VIOLATION_PATTERN.test(errorMessage);
}

/**
 * Khi generate thất bại vì vi phạm chính sách nội dung (xem
 * CONTENT_VIOLATION_PATTERN), nhờ ChatAI viết lại prompt của entry (loại bỏ
 * tên riêng/IP có bản quyền/từ ngữ nhạy cảm — xem reviseGenerationPrompt
 * trong chatAI.ts) rồi ghi đè "entry.prompt" ngay để lần retry (gọi ngay sau
 * đây) VÀ mọi lần chạy lại sau (kể cả job khác, hoặc resume sau restart) đều
 * dùng luôn bản mới — trả về true nếu đã viết lại được (nên thử generate lại
 * ngay 1 lần), false nếu không áp dụng được (không phải lỗi vi phạm nội dung,
 * hoặc bản thân việc nhờ ChatAI viết lại cũng thất bại) — false thì giữ
 * nguyên lỗi gốc, không retry.
 */
async function reviseEntryPromptIfContentViolation(
  entry: StoryboardEntry,
  errorMessage: string,
  jobId: string,
): Promise<boolean> {
  if (!isContentViolationError(errorMessage)) return false;
  if (typeof entry.prompt !== "string" || !entry.prompt) return false;
  try {
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — prompt bị site từ chối (vi phạm chính sách nội dung), nhờ ChatAI viết lại rồi thử tạo lại...`,
    );
    const revisedPrompt = await reviseGenerationPrompt(
      entry.prompt,
      errorMessage,
      jobId,
    );
    if (!revisedPrompt || revisedPrompt === entry.prompt) return false;
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đã có prompt mới từ ChatAI, thử tạo lại.`,
    );
    entry.prompt = revisedPrompt;
    return true;
  } catch (err) {
    console.error(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — nhờ ChatAI viết lại prompt thất bại:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Chạy attempt() 1 lần — nếu lỗi VÀ là lỗi vi phạm chính sách nội dung (xem
 * reviseEntryPromptIfContentViolation), thử ĐÚNG 1 LẦN NỮA sau khi đã viết
 * lại entry.prompt (attempt() phải tự đọc entry.prompt lúc gọi, không được
 * chốt sẵn giá trị cũ, để lần thử lại dùng đúng prompt mới). Lỗi ở lần thử
 * lại (dù cùng lý do hay khác) đều ném thẳng ra ngoài — chỉ retry 1 lần/entry,
 * tránh vòng lặp vô hạn nếu ChatAI viết lại vẫn bị site từ chối.
 */
async function generateWithContentViolationRetry<T>(
  entry: StoryboardEntry,
  jobId: string,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    throw err;
    // const errorMessage = err instanceof Error ? err.message : String(err);
    // const revised = await reviseEntryPromptIfContentViolation(
    //   entry,
    //   errorMessage,
    //   jobId,
    // );
    // if (!revised) throw err;
    // return await attempt();
  }
}

const REQUEST_THROTTLE_MS = 15000;

/**
 * Cờ dừng SỚM cho 3 vòng lặp generateReferenceImagesForFile/
 * generateSceneImagesForFile/generateVideosForFile — dùng cho nút "Stop All"
 * (xem stopAll() trong queue.ts). Entry ĐANG generate dở (đã gọi
 * generateReferenceImage/generateVideo, còn đang chờ Playwright chạy xong)
 * được để chạy XONG BÌNH THƯỜNG, không bị abort giữa chừng — chỉ các entry
 * CHƯA bắt đầu (lượt lặp KẾ TIẾP của vòng for) mới bị bỏ qua, giữ nguyên
 * "success" chưa xác định để lần chạy lại sau (resume) vẫn xử lý tiếp được.
 *
 * Theo YÊU CẦU NGƯỜI DÙNG: "Stop All" chỉ được dừng job của ĐÚNG user đã bấm,
 * không được dừng job của user khác — nên đổi từ 1 cờ boolean CHUNG (dừng mù
 * quáng mọi job đang chạy, bất kể của ai) sang tập hợp CÁC jsonPath cụ thể
 * đang bị yêu cầu dừng. stopAll(userId) chỉ thêm jsonPath của job ĐANG XỬ LÝ
 * (index 0 hàng đợi ảnh / currentVideoJob hàng đợi video) NẾU job đó thuộc
 * đúng userId — job của user khác đang chạy dở không hề bị đụng tới. Resolve
 * qua path.resolve() trước khi dùng làm key — cùng 1 file có thể được truyền
 * vào dưới dạng path tương đối/tuyệt đối khác nhau tuỳ nơi gọi.
 *
 * Phải gọi clearStopStoryboardRequest(jsonPath) SAU KHI job đang dừng đã thực
 * sự thoát hẳn (xem processImageQueue/processVideoQueue trong queue.ts), nếu
 * không job MỚI sau đó dùng LẠI đúng jsonPath này (vd bấm "Tiếp tục...") sẽ bị
 * chặn nhầm ngay từ đầu.
 *
 * Ghi ra file (STOP_STORYBOARD_REQUESTS_FILE) SAU MỖI lần thêm/xoá — cùng cơ
 * chế/lý do với imageJobs/videoJobs/chatAIJobs trong queue.ts: sống sót qua
 * restart/crash. Quan trọng vì job đang xử lý dở lúc bị yêu cầu dừng có thể
 * VẪN còn nguyên trong file hàng đợi (chỉ xoá ở "finally" sau khi thực sự
 * xong) — nếu bot restart ngay sau đó mà không nhớ lại yêu cầu dừng này, job
 * đó sẽ chạy tiếp như chưa hề bị yêu cầu dừng.
 */
const STOP_STORYBOARD_REQUESTS_FILE = path.resolve(
  "./storage/stop-storyboard-requests.json",
);

const stopStoryboardRequestedPaths = new Set<string>();

function persistStopStoryboardRequests(): void {
  try {
    fs.mkdirSync(path.dirname(STOP_STORYBOARD_REQUESTS_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      STOP_STORYBOARD_REQUESTS_FILE,
      JSON.stringify(Array.from(stopStoryboardRequestedPaths), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error(
      "[storyboardPipeline] Không ghi được file yêu cầu dừng storyboard:",
      err,
    );
  }
}

/** Gọi 1 lần lúc khởi động bot (xem initQueue trong queue.ts), TRƯỚC khi các hàng đợi bắt đầu xử lý lại. */
export function loadPersistedStopStoryboardRequests(): void {
  try {
    if (!fs.existsSync(STOP_STORYBOARD_REQUESTS_FILE)) return;
    const restored: string[] = JSON.parse(
      fs.readFileSync(STOP_STORYBOARD_REQUESTS_FILE, "utf-8"),
    );
    if (restored.length > 0) {
      for (const jsonPath of restored) {
        stopStoryboardRequestedPaths.add(jsonPath);
      }
      console.log(
        `[storyboardPipeline] Khôi phục ${restored.length} yêu cầu dừng storyboard từ lần chạy trước.`,
      );
    }
  } catch (err) {
    console.error(
      "[storyboardPipeline] Không đọc được file yêu cầu dừng storyboard đã lưu, bỏ qua:",
      err,
    );
  }
}

export function requestStopStoryboardPipeline(jsonPath: string): void {
  stopStoryboardRequestedPaths.add(path.resolve(jsonPath));
  persistStopStoryboardRequests();
}

export function clearStopStoryboardRequest(jsonPath: string): void {
  stopStoryboardRequestedPaths.delete(path.resolve(jsonPath));
  persistStopStoryboardRequests();
}

export function isStopStoryboardRequested(jsonPath: string): boolean {
  return stopStoryboardRequestedPaths.has(path.resolve(jsonPath));
}

/**
 * Ghi đè lại TOÀN BỘ mảng entries vào file input — gọi lại NGAY sau MỖI entry
 * xử lý xong (không đợi hết cả loạt), để nếu tiến trình bị dừng/crash giữa
 * chừng (vd hết credit, mất mạng ở entry sau) thì các entry ĐÃ generate trước
 * đó không bị mất field "success" đã cập nhật.
 */
// Chuỗi promise nối đuôi — bảo đảm các lần gọi saveEntries() chồng lấp (nhiều
// worker cùng lúc gọi khi generateVideosForFilePollo chạy song song, xem
// POLLO_VIDEO_CONCURRENCY) ghi file TUẦN TỰ đúng thứ tự gọi, không bị 1 lần
// ghi CHẬM hơn hoàn tất SAU rồi đè mất nội dung mới hơn của 1 lần ghi khác đã
// xong trước đó (mỗi lần gọi serialize TOÀN BỘ mảng entries trong bộ nhớ tại
// đúng thời điểm gọi, nhưng fs.writeFile là bất đồng bộ nên thứ tự HOÀN TẤT
// trên đĩa có thể khác thứ tự GỌI nếu không khoá lại).
let saveEntriesLockTail: Promise<void> = Promise.resolve();

async function saveEntries(
  inputPath: string,
  entries: StoryboardEntry[],
): Promise<void> {
  const json = JSON.stringify(entries, null, 2);
  const run = (): Promise<void> => fs.promises.writeFile(inputPath, json, "utf-8");
  const result = saveEntriesLockTail.then(run, run);
  saveEntriesLockTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * Thư mục generated/<tên file input, bỏ đuôi> — DÙNG CHUNG giữa bước tạo ảnh
 * và tạo video của CÙNG 1 file input.
 *
 * Xác nhận qua báo cáo thật của người dùng: caption "6.0-test-TNCPA__CHAR_001_HO_VUONG"
 * (xem tryReplaceGeneratedFile trong handlers.ts, và jsonFileName do user gõ
 * tay trong continueFailedStoryboardJob ở queue.ts) ra folder SAI là
 * "storage/generated/6" thay vì "storage/generated/6.0-test-TNCPA" — 2 nơi
 * gọi này truyền vào 1 basename KHÔNG có đuôi file thật (không phải path.json
 * đầy đủ), nhưng path.extname("6.0-test-TNCPA") lại hiểu NHẦM dấu "." trong
 * "6.0" là bắt đầu phần đuôi, trả về ".0-test-TNCPA", khiến path.basename cắt
 * mất gần hết tên, chỉ còn lại "6". Chỉ cắt đuôi khi ĐÚNG LÀ ".json" ở cuối
 * chuỗi (không dùng path.extname() thô) — an toàn cho cả file path đầy đủ
 * (vd "cay_khe_full.json") lẫn basename không có đuôi chứa dấu "." nội bộ
 * (vd tên phiên bản "6.0-test-TNCPA").
 */
export function generatedDirFor(inputPath: string): string {
  const withoutJsonExt = /\.json$/i.test(inputPath)
    ? inputPath.slice(0, -".json".length)
    : inputPath;
  return path.resolve("./storage/generated", path.basename(withoutJsonExt));
}

/** Đuôi file coi là video kết quả — dùng cho archiveExistingGeneratedFiles (xem ensureGeneratedFolder). */
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);

/**
 * MOVE (không phải copy — tránh để lại bản trùng ở gốc outputDir) các video
 * ĐANG CÓ SẴN ở gốc outputDir (từ lần gen TRƯỚC, cùng tên folder) vào 1
 * subfolder "vXX" mới — XX tăng dần theo subfolder "vXX" lớn nhất đã có (bắt
 * đầu "v01" nếu chưa có subfolder nào).
 *
 * SỬA (theo yêu cầu người dùng): MOVE THÊM CẢ file JSON storyboard CŨ (nếu có
 * sẵn ở gốc outputDir từ lần gen trước) vào CÙNG subfolder "vXX" đó — trước
 * đây chỉ move video, để lại JSON cũ ở gốc rồi bị chính copyFile ở
 * ensureGeneratedFolder ghi đè mất, khiến folder "vXX" chỉ có video mà không
 * có JSON gốc đã sinh ra chúng (không tra lại được prompt/ref của lần gen
 * đó). Giờ mỗi "vXX" là 1 bản snapshot đầy đủ (JSON + video) của đúng lần gen
 * trước.
 *
 * Best-effort: lỗi đọc folder hay move 1 file không chặn cả job, chỉ cảnh
 * báo. Dùng rename trước (nhanh, đúng nghĩa move), fallback copy+xoá bản gốc
 * nếu rename lỗi (vd khác partition/device — không thể rename xuyên device).
 */
async function archiveExistingGeneratedFiles(outputDir: string): Promise<void> {
  const entries = await fs.promises
    .readdir(outputDir, { withFileTypes: true })
    .catch(() => []);
  const filesToArchive = entries
    .filter(
      (e) =>
        e.isFile() &&
        (VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()) ||
          path.extname(e.name).toLowerCase() === ".json"),
    )
    .map((e) => e.name);
  if (filesToArchive.length === 0) return;

  const existingVersions = entries
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => Number.parseInt(e.name.slice(1), 10));
  const nextVersion =
    (existingVersions.length > 0 ? Math.max(...existingVersions) : 0) + 1;
  const versionDir = path.join(
    outputDir,
    `v${String(nextVersion).padStart(2, "0")}`,
  );

  await fs.promises.mkdir(versionDir, { recursive: true });
  for (const fileName of filesToArchive) {
    const srcPath = path.join(outputDir, fileName);
    const destPath = path.join(versionDir, fileName);
    try {
      await fs.promises.rename(srcPath, destPath);
    } catch (err) {
      try {
        await fs.promises.copyFile(srcPath, destPath);
        await fs.promises.unlink(srcPath);
      } catch (copyErr) {
        console.warn(
          `[storyboardPipeline] Không move được file "${fileName}" vào "${versionDir}":`,
          copyErr,
        );
      }
    }
  }
}

/**
 * Tạo (nếu chưa có) folder generated/<tên file input>/ và copy file
 * input JSON vào đó — gọi SỚM, NGAY sau khi ChatAI trả JSON xong (xem
 * processChatAIQueue trong queue.ts), TRƯỚC KHI user xác nhận có gen ảnh hay
 * không, để user có thể upload ảnh/JSON thay thế vào đúng folder trong lúc
 * chờ xác nhận (xem tryReplaceGeneratedFile trong handlers.ts).
 *
 * SỬA (theo yêu cầu người dùng): KHÔNG xoá folder cũ nữa (đã thử, không phù
 * hợp) — thay vào đó, nếu folder đã có sẵn video/JSON từ lần gen TRƯỚC (trùng
 * tên folder), move CẢ video LẪN file JSON storyboard cũ đó vào 1 subfolder
 * "vXX" (XX tăng dần mỗi lần gen, xem archiveExistingGeneratedFiles) để giữ
 * lại lịch sử ĐẦY ĐỦ (JSON + video) các lần gen trước, trước khi tiếp tục ghi
 * đè bình thường ở gốc folder cho lần gen MỚI.
 */
export async function ensureGeneratedFolder(
  inputPath: string,
): Promise<string> {
  const outputDir = generatedDirFor(inputPath);
  await archiveExistingGeneratedFiles(outputDir);
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
    if (isStopStoryboardRequested(inputPath)) break;
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
  onEntryError?: (id: string, errorMessage: string) => Promise<void>,
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
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;

    // Cùng lý do đã sửa cho generateSceneImagesForFileViaAIVideo: ảnh id này
    // đã tồn tại sẵn trong folder generated/ (vd user tự upload thay thế,
    // hoặc lần chạy trước đã lưu file nhưng saveEntries chưa kịp ghi
    // "success": true) — không gen lại tốn credit, chỉ đánh dấu success.
    const existingImagePath = await findExistingImageById(
      outputDir,
      sanitizeId(entry.id),
    );
    if (existingImagePath) {
      entry.success = true;
      succeeded++;
      await saveEntries(inputPath, entries);
      continue;
    }

    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh (aiVideo)...`,
    );
    let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
    try {
      const imagePaths = await generateWithContentViolationRetry(
        entry,
        jobId,
        () => generateImage(entry.prompt!, { imageCount: 1 }, jobId),
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
        await onEntryError(
          entry.id,
          err instanceof Error ? err.message : String(err),
        ).catch((err) => {
          console.error(
            `[storyboardPipeline] Thông báo tạo file "${destPath}" thất bại (không tính là lỗi generate):`,
            err,
          );
        });
        await sleep(1000);
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
 * GIỐNG generateReferenceImagesForFileViaAIVideo HỆT (cùng lọc CHARACTER/
 * LOCATION, cùng quy ước lưu file/success/onEntryDone/onEntryError/resume)
 * nhưng tạo ảnh qua pollo.ai (generateImage trong polloImage.ts) THAY VÌ
 * AIVideo — provider SONG SONG (xem chú thích đầu pollo.ts/polloImage.ts),
 * KHÔNG thay thế hàm trên, người dùng tự chọn qua nút bấm riêng (xem
 * StoryboardImagesPolloJob trong queue.ts). generateImage của polloImage.ts
 * LUÔN trả về mảng ĐÚNG 1 ảnh (không có khái niệm "imageCount" nhiều ảnh/lần
 * như AIVideo) nên đoạn "ảnh đầu + xoá ảnh thừa" bên dưới gần như no-op (mảng
 * extra luôn rỗng) — giữ nguyên cấu trúc để đồng nhất/dễ so sánh với hàm
 * AIVideo.
 */
export async function generateReferenceImagesForFileViaPollo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (id: string, errorMessage: string) => Promise<void>,
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

  // CHARACTER/LOCATION không tham chiếu lẫn nhau (ref luôn rỗng, xem
  // format_output.txt) nên hoàn toàn ĐỘC LẬP — an toàn chạy song song bằng
  // worker-pool, cùng cơ chế "nextIndex" dùng chung với
  // generateVideosForFilePollo (xem docstring ở đó). config.polloImageConcurrency
  // CHỈ dùng ở đây — generateSceneImagesForFileViaPollo chạy TUẦN TỰ (theo
  // yêu cầu người dùng, xem docstring ở đó: SCENE_SETTING_END của clip N ref
  // tới ảnh của clip N-1 cùng shot, có dây chuyền phụ thuộc thật).
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (isStopStoryboardRequested(inputPath)) break;
      const index = nextIndex++;
      if (index >= targets.length) break;
      const entry = targets[index];
      if (entry?.success) continue;

      const existingImagePath = await findExistingImageById(
        outputDir,
        sanitizeId(entry.id),
      );
      if (existingImagePath) {
        entry.success = true;
        succeeded++;
        await saveEntries(inputPath, entries);
        continue;
      }

      const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
      console.log(
        `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh (pollo)...`,
      );
      let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
      try {
        const { filePaths: imagePaths, polloResultId } =
          await generateWithContentViolationRetry(entry, jobId, () =>
            withPolloTaskSlot(() => generateImagePollo(entry.prompt!, {}, jobId)),
          );
        if (imagePaths.length === 0) {
          throw new Error("Không tạo được ảnh nào");
        }
        // Lưu id kết quả pollo.ai (dạng "/v/<id>") NGAY VÀO entry trong file
        // JSON storyboard gốc — theo yêu cầu người dùng, KHÔNG lưu file riêng.
        if (polloResultId) {
          entry.polloResultId = polloResultId;
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
          await onEntryError(
            entry.id,
            err instanceof Error ? err.message : String(err),
          ).catch((err) => {
            console.error(
              `[storyboardPipeline] Thông báo tạo file "${destPath}" thất bại (không tính là lỗi generate):`,
              err,
            );
          });
          await sleep(1000);
        }
      }
      await saveEntries(inputPath, entries);
    }
  }

  await Promise.all(
    Array.from({ length: config.polloImageConcurrency }, () => runWorker()),
  );

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
/**
 * Tìm file ảnh theo id (đã sanitize) trong 1 folder, không throw nếu không
 * có — dùng để kiểm tra ảnh ĐÃ TỒN TẠI SẴN trước khi generate (xem
 * generateSceneImagesForFileViaAIVideo: id đã có file trong folder generated/
 * thì bỏ qua gen lại, chỉ đánh dấu success luôn).
 */
async function findExistingImageById(
  dir: string,
  id: string,
): Promise<string | null> {
  const exact = path.join(dir, `${id}.png`);
  if (fs.existsSync(exact)) return exact;

  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(`${id}.`));
  return match ? path.join(dir, match) : null;
}

export async function resolveRefImagePath(
  dir: string,
  id: string,
): Promise<string> {
  const found = await findExistingImageById(dir, id);
  if (found) return found;

  throw new Error(
    `Không tìm thấy file ảnh tham chiếu cho id "${id}" trong ${dir}`,
  );
}

/**
 * Sau khi 1 entry SCENE_SETTING_END vừa xong (generate mới hoặc phát hiện đã
 * có sẵn file, xem generateSceneImagesForFileViaAIVideo), tìm các entry VIDEO
 * đã ĐỦ ĐIỀU KIỆN tạo video NGAY — dùng để queue.ts tự đẩy job
 * "storyboardVideo" riêng cho từng clip ngay khi sẵn sàng, không cần chờ hết
 * toàn bộ file (xem generateVideosForFile, tham số onlyEntryIds).
 *
 * 1 entry VIDEO đủ điều kiện khi: (a) type "VIDEO", (b) CHƯA "success": true
 * (chưa tạo xong — tránh đẩy lại job cho clip đã xong), (c) ref có chứa ĐÚNG
 * id vừa xong (finishedEndId), và (d) TẤT CẢ ref khác của nó cũng đã có file
 * trên đĩa — check bằng findExistingImageById (CÙNG hàm generateVideosForFile
 * dùng để resolve ref thật khi tạo video, không đoán qua field "success" của
 * ref vì có thể lệch với file thật, xem tryRegenerateStoryboardItem/
 * markStoryboardEntrySuccess trong handlers.ts).
 *
 * 1 entry SCENE_SETTING_END có thể được tối đa 2 entry VIDEO tham chiếu (làm
 * end của chính clip đó, VÀ làm start "kế thừa" của clip kế tiếp — xem
 * assignStartEndFrames) — nhưng clip kế tiếp chắc chắn còn thiếu END của
 * chính nó (chưa generate tới) nên tự động không lọt qua điều kiện (d), không
 * cần xử lý đặc biệt gì thêm cho trường hợp này.
 */
async function findVideoEntriesReadyAfterEnd(
  entries: StoryboardEntry[],
  outputDir: string,
  finishedEndId: string,
): Promise<string[]> {
  const candidates = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id">> & StoryboardEntry =>
      e.type === "VIDEO" &&
      Boolean(e.id) &&
      e.success !== true &&
      (e.ref ?? []).some((r) => r.id === finishedEndId),
  );

  const readyIds: string[] = [];
  for (const entry of candidates) {
    const refs = (entry.ref ?? []).filter(
      (r): r is Required<StoryboardRefItem> => Boolean(r.id),
    );
    let allReady = true;
    for (const ref of refs) {
      const found = await findExistingImageById(outputDir, sanitizeId(ref.id));
      if (!found) {
        allReady = false;
        break;
      }
    }
    if (allReady) readyIds.push(entry.id);
  }
  return readyIds;
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
interface StartEndFrameRef {
  /** type khai báo trong entry.ref (vd "SCENE_SETTING_START"/"SCENE_SETTING_END"/"CHARACTER"/"LOCATION") — dùng để xác định vai trò, KHÔNG đoán qua tên file. */
  type?: string;
  path: string;
}

/**
 * Xác định startFramePath/endFramePath dựa THẲNG vào type + thứ tự khai báo
 * trong entry.ref (đúng hợp đồng JSON format_output.txt), không còn đoán qua
 * tên file như trước:
 * - Có ref type "SCENE_SETTING_START": ref đó LUÔN là start, ref còn lại
 *   (thường "SCENE_SETTING_END") là end.
 * - Không có "SCENE_SETTING_START" (clip N từ 2 trở đi: ref = [END_N-1,
 *   END_N], CẢ 2 CÙNG type "SCENE_SETTING_END"): giữ ĐÚNG thứ tự khai báo —
 *   ref ĐẦU TIÊN (END của clip trước, đóng vai start kế thừa) → start, ref
 *   THỨ HAI (END của clip hiện tại) → end.
 */
function assignStartEndFrames(
  refs: StartEndFrameRef[],
): Pick<GenerateVideoOptions, "startFramePath" | "endFramePath"> {
  if (refs.length === 0) return {};
  if (refs.length === 1) return { startFramePath: refs[0].path };

  const startRef = refs.find((r) => r.type === "SCENE_SETTING_START");
  if (startRef) {
    const endRef = refs.find((r) => r !== startRef);
    return { startFramePath: startRef.path, endFramePath: endRef?.path };
  }

  return { startFramePath: refs[0].path, endFramePath: refs[1].path };
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
 *
 * onlyEntryIds (tuỳ chọn): CHỈ xử lý đúng các entry VIDEO có id nằm trong
 * danh sách này (bỏ qua mọi entry VIDEO khác trong file, kể cả entry chưa
 * "success"), dùng cho job "storyboardVideo" per-clip tự đẩy ngay khi 1 clip
 * đủ ref (xem findVideoEntriesReadyAfterEnd/StoryboardVideoJob.entryIds
 * trong queue.ts) — KHÔNG truyền (mặc định) = xử lý HẾT entry VIDEO chưa
 * "success" trong file, giữ nguyên hành vi cũ (nút "Tạo video" thủ công/CLI
 * script).
 */
export async function generateVideosForFile(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string, errorMessage: string) => Promise<void>,
  onlyEntryIds?: string[],
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
      if (onlyEntryIds && !onlyEntryIds.includes(e.id)) return false;
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
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    // console.log(`[storyboardPipeline] [VIDEO] ${entry.id} — đang tạo video...`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING_START" ||
            r.type === "SCENE_SETTING_END"),
      );

      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      // Field "duration" (giây) trong JSON storyboard — trước đây bị bỏ qua
      // hoàn toàn (chỉ log cảnh báo, đã comment sẵn). Giờ truyền thẳng vào
      // GenerateVideoOptions.duration (chuẩn hoá về "Ns", khớp nhãn chip
      // durationChipCandidates) để tự chọn đúng thời lượng trên AIVideo.
      const duration =
        typeof entry.duration === "number" && entry.duration > 0
          ? `${Math.round(entry.duration)}s`
          : undefined;

      // Gắn type khai báo trong entry.ref theo ĐÚNG THỨ TỰ với refPaths —
      // assignStartEndFrames dùng type này để xác định start/end (xem
      // docstring hàm đó), KHÔNG đoán qua tên file nữa.
      const options: GenerateVideoOptions = {
        duration,
        ...(refPaths.length >= 3
          ? { omniReferencePaths: refPaths }
          : assignStartEndFrames(
              refs.map((r, i) => ({ type: r.type, path: refPaths[i] })),
            )),
      };

      // Check lại NGAY TRƯỚC khi gọi generateVideo (không chỉ ở đầu vòng for)
      // — resolveRefImagePath ở trên là async (đọc đĩa), Stop All có thể vừa
      // được bấm đúng lúc đang chờ đoạn đó. Entry CHƯA gọi generateVideo (chưa
      // tốn credit AIVideo) nên bỏ qua an toàn — giữ "success" chưa xác
      // định để resume sau, đúng ý "chưa gen thì ko gen nữa".
      if (isStopStoryboardRequested(inputPath)) break;

      const tempFilePath = await generateWithContentViolationRetry(
        entry,
        jobId,
        () => generateVideo(entry.prompt!, options, jobId),
      );

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
        await onEntryDone(destPath).catch((err) => {});
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [VIDEO] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      if (onEntryError) {
        await onEntryError(
          entry.id,
          err instanceof Error ? err.message : String(err),
        ).catch((err) => {});
        await sleep(1000);
      }
      entry.success = false;
      failed++;
      failedEntries.push({ id: entry.id, type: "VIDEO" });
    }
    await saveEntries(inputPath, entries);
  }

  return { outputDir, succeeded, failed, failedEntries };
}

export interface VerifyVideosResult {
  outputDir: string;
  total: number;
  verified: number;
  failed: number;
  failedEntries: FailedEntry[];
}

/**
 * Đọc 1 file JSON storyboard trong storage/generated/, duyệt từng entry
 * "VIDEO" ĐÃ có file video thật trên đĩa (<sanitizeId(entry.id)>.mp4 trong
 * outputDir — entry chưa gen video thì bỏ qua, không phải lỗi) rồi gọi
 * verifyVideo (chatAI.ts) kiểm tra từng video — theo yêu cầu người dùng.
 *
 * refs resolve giống hệt generateVideosForFile (resolveRefImagePath theo
 * entry.ref, ĐÚNG THỨ TỰ khai báo trong JSON).
 *
 * Best-effort theo từng entry — 1 video lỗi (thiếu ref trên đĩa, ChatAI lỗi
 * phiên đăng nhập...) không chặn các video khác trong CÙNG file, chỉ tính
 * vào failedEntries.
 */
/**
 * Tách shot/clip của 1 entry VIDEO — ưu tiên field "shot"/"clip" (schema mới,
 * xem format_output.txt), fallback parse từ id dạng SHOT_XX_CLIP_YY_VIDEO cho
 * file JSON cũ chưa có 2 field này. Trả về null nếu không xác định được (id
 * không đúng mẫu) — verifyVideos khi đó bỏ qua hẳn việc tìm PREVIOUS_VIDEO
 * cho entry đó, không suy đoán mù.
 */
function parseShotClip(
  entry: StoryboardEntry,
): { shot: number; clip: number } | null {
  if (typeof entry.shot === "number" && typeof entry.clip === "number") {
    return { shot: entry.shot, clip: entry.clip };
  }
  const match = /^SHOT_(\d+)_CLIP_(\d+)_VIDEO$/i.exec(entry.id ?? "");
  if (!match) return null;
  return { shot: Number(match[1]), clip: Number(match[2]) };
}

export async function verifyVideos(
  inputPath: string,
): Promise<VerifyVideosResult> {
  const outputDir = generatedDirFor(inputPath);
  const entries: StoryboardEntry[] = JSON.parse(
    await fs.promises.readFile(inputPath, "utf-8"),
  );

  const targets = entries.filter(
    (
      e,
    ): e is Required<Pick<StoryboardEntry, "type" | "id" | "prompt">> &
      StoryboardEntry => {
      if (e.type !== "VIDEO") return false;
      return Boolean(e.id) && typeof e.prompt === "string" && Boolean(e.prompt);
    },
  );

  let verified = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  // Video liền trước ĐÃ XÁC NHẬN tồn tại trên đĩa cho từng SHOT — theo yêu
  // cầu người dùng, dùng làm PREVIOUS_VIDEO khi verify clip kế tiếp CÙNG shot
  // (clip số N-1). Cập nhật sau mỗi entry có file thật, bất kể verify entry
  // đó thành công hay lỗi — chỉ cần file .mp4 tồn tại là đủ làm continuity
  // reference cho clip sau.
  const lastVideoPathByShot = new Map<number, { clip: number; path: string }>();

  for (const entry of targets) {
    const videoPath = path.join(outputDir, `${sanitizeId(entry.id)}.mp4`);
    if (!fs.existsSync(videoPath)) continue;

    const shotClip = parseShotClip(entry);
    let previousVideoPath: string | undefined;
    if (shotClip) {
      const prev = lastVideoPathByShot.get(shotClip.shot);
      if (
        prev &&
        prev.clip === shotClip.clip - 1 &&
        fs.existsSync(prev.path)
      ) {
        previousVideoPath = prev.path;
      }
    }

    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> => Boolean(r.id),
      );
      const verifyRefs: VerifyVideoRef[] = [];
      for (const ref of refs) {
        const refId = sanitizeId(ref.id);
        verifyRefs.push({
          id: refId,
          path: await resolveRefImagePath(outputDir, refId),
        });
      }

      await verifyVideo(entry.prompt, verifyRefs, videoPath, previousVideoPath);
      verified++;
    } catch (err) {
      console.error(
        `[storyboardPipeline] [VERIFY] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      failed++;
      failedEntries.push({ id: entry.id, type: "VIDEO" });
    }

    if (shotClip) {
      lastVideoPathByShot.set(shotClip.shot, {
        clip: shotClip.clip,
        path: videoPath,
      });
    }
  }

  return { outputDir, total: targets.length, verified, failed, failedEntries };
}

/**
 * GIỐNG generateVideosForFile (cùng đọc file, lọc entry "VIDEO", cùng quy
 * ước success/onEntryDone/onEntryError/resume/onlyEntryIds/duration, cùng
 * dùng assignStartEndFrames để xác định start/end frame từ VIDEO.ref) nhưng
 * tạo video qua pollo.ai (generateVideo trong pollo.ts) THAY VÌ AIVideo —
 * provider SONG SONG, KHÔNG thay thế hàm trên.
 *
 * SỬA (theo yêu cầu người dùng, khôi phục schema SCENE_SETTING_START/END —
 * xem format_output.txt): VIDEO.ref giờ CHỈ chứa đúng 2 phần tử
 * SCENE_SETTING_START/SCENE_SETTING_END (không còn CHARACTER/LOCATION trực
 * tiếp) — dùng mode "Start/End Frame" pollo.ai (PolloGenerateVideoOptions.
 * startFramePath/endFramePath, xem pollo.ts) THAY VÌ mode "Reference to
 * Video" (referenceImagePaths) đã dùng trước đây. Ảnh SCENE_SETTING_START/END
 * phải đã được tạo trước đó (xem generateSceneImagesForFileViaAIVideo, gọi
 * trong processPolloImageQueue ngay sau bước "Tạo ảnh" CHARACTER/LOCATION —
 * dùng LẠI hàm AIVideo hiện có, không viết bản riêng cho Pollo vì cùng là
 * asset ảnh tĩnh, không phụ thuộc provider nào sẽ dùng nó để gen video).
 */
export async function generateVideosForFilePollo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string, errorMessage: string) => Promise<void>,
  onlyEntryIds?: string[],
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
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      if (onlyEntryIds && !onlyEntryIds.includes(e.id)) return false;
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));

  // Tài khoản pollo.ai cho phép tối đa 8 task gen song song (theo xác nhận
  // của người dùng) — chạy nhiều worker song song (config.polloVideoConcurrency,
  // mặc định 6, chừa biên an toàn cho job ảnh Pollo chạy chung tài khoản) thay
  // vì tuần tự từng video một, tận dụng tối đa số task tài khoản cho phép mà
  // vẫn không vượt quá. Đọc qua config (không hardcode) — QUAN TRỌNG khi 2
  // MÁY KHÁC NHAU cùng dùng CHUNG 1 tài khoản pollo.ai: mỗi máy cấu hình
  // POLLO_VIDEO_CONCURRENCY thành 1 phần cố định của tổng 6 (vd 3+3, xem
  // .env.example) — 2 process độc lập không chia sẻ được biến đếm trong bộ
  // nhớ với nhau nên phải tự chia tĩnh, không thể "mượn" slot rảnh của nhau.
  // Mỗi worker tự lấy entry kế tiếp qua "nextIndex" dùng chung — an toàn dù
  // chạy đồng thời vì JS đơn luồng, "nextIndex++" là 1 statement nguyên tử,
  // không thể xen kẽ giữa các worker.
  const POLLO_VIDEO_CONCURRENCY = config.polloVideoConcurrency;
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (isStopStoryboardRequested(inputPath)) break;
      const index = nextIndex++;
      if (index >= targets.length) break;
      const entry = targets[index];
      if (entry?.success) continue;

      const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
      try {
        const refs = (entry.ref ?? []).filter(
          (r): r is Required<StoryboardRefItem> =>
            Boolean(r.id) &&
            (r.type === "SCENE_SETTING_START" ||
              r.type === "SCENE_SETTING_END"),
        );

        const refPaths: string[] = [];
        for (const ref of refs) {
          refPaths.push(
            await resolveRefImagePath(outputDir, sanitizeId(ref.id)),
          );
        }

        const { startFramePath, endFramePath } = assignStartEndFrames(
          refs.map((r, i) => ({ type: r.type, path: refPaths[i] })),
        );
        if (!startFramePath || !endFramePath) {
          throw new Error(
            `Pollo (Start/End Frame) cần đủ 2 ảnh start/end frame — entry này chỉ resolve được ${refPaths.length} ảnh.`,
          );
        }

        const duration =
          typeof entry.duration === "number" && entry.duration > 0
            ? `${Math.round(entry.duration)}s`
            : undefined;

        if (isStopStoryboardRequested(inputPath)) break;

        console.log(
          `[storyboardPipeline] [VIDEO] ${entry.id} — đang tạo video (pollo)...`,
        );
        const { filePath: tempFilePath, polloResultId } =
          await generateWithContentViolationRetry(entry, jobId, () =>
            withPolloTaskSlot(() =>
              generateVideoPollo(
                entry.prompt!,
                { startFramePath, endFramePath, model: "MiniMax H3", duration },
                jobId,
              ),
            ),
          );
        // Lưu id kết quả pollo.ai (dạng "/v/<id>") NGAY VÀO entry trong file
        // JSON storyboard gốc — theo yêu cầu người dùng, KHÔNG lưu file riêng.
        if (polloResultId) {
          entry.polloResultId = polloResultId;
        }

        const destPath = path.join(outputDir, `${sanitizeId(entry.id)}.mp4`);
        try {
          await fs.promises.rename(tempFilePath, destPath);
        } catch {
          await fs.promises.copyFile(tempFilePath, destPath);
          await fs.promises.unlink(tempFilePath).catch(() => {});
        }

        entry.success = true;
        succeeded++;
        if (onEntryDone) {
          await onEntryDone(destPath).catch((err) => {});
        }
      } catch (err) {
        console.error(
          `[storyboardPipeline] [VIDEO] ${entry.id} — lỗi:`,
          err instanceof Error ? err.message : err,
        );
        if (onEntryError) {
          await onEntryError(
            entry.id,
            err instanceof Error ? err.message : String(err),
          ).catch((err) => {});
          await sleep(1000);
        }
        entry.success = false;
        failed++;
        failedEntries.push({ id: entry.id, type: "VIDEO" });
      }
      await saveEntries(inputPath, entries);
    }
  }

  await Promise.all(
    Array.from({ length: POLLO_VIDEO_CONCURRENCY }, () => runWorker()),
  );

  return { outputDir, succeeded, failed, failedEntries };
}

/** Duration mặc định (giây) cho ComfyUI khi entry.duration thiếu/không hợp lệ — khớp giá trị mặc định trong template workflow (xem node "132" "Float (Duration)" trong comfyuiWorkflows/minimax-h3-reference-to-video.json). */
const COMFYUI_DEFAULT_DURATION_SECONDS = 5;

/**
 * GIỐNG generateVideosForFile (cùng đọc file, lọc entry "VIDEO", cùng quy ước
 * success/onEntryDone/onEntryError/resume/onlyEntryIds) nhưng tạo video qua
 * ComfyUI dùng workflow MiniMax H3 "Reference to Video"
 * (generateVideoComfyMiniMaxH3 trong comfyui.ts) THAY VÌ AIVideo — provider
 * SONG SONG, KHÔNG thay thế 2 hàm generateVideosForFile/
 * generateVideosForFilePollo ở trên.
 *
 * SỬA (theo yêu cầu người dùng, khớp lại đúng schema hiện tại của
 * format_output.txt — VIDEO.ref chỉ chứa CHARACTER/LOCATION trực tiếp, KHÔNG
 * còn SCENE_SETTING_START/END): đổi từ workflow LTX-2 (frame-interpolation,
 * cần ĐÚNG 2 ảnh start/end frame) sang MiniMax H3 (Reference to Video, nhận
 * 1-9 ẢNH THAM CHIẾU tự do — đúng khái niệm CHARACTER/LOCATION ref hiện tại,
 * giống hệt cách generateVideosForFilePollo dùng referenceImagePaths cho
 * pollo.ai).
 *
 * KHÁC BIỆT so với generateVideosForFile:
 * 1. refPaths phải resolve được 1-MAX_MINIMAX_H3_REFERENCE_IMAGES (9) ảnh —
 *    0 ảnh hoặc quá 9 ảnh coi là lỗi rõ ràng cho ĐÚNG entry đó (không chặn cả
 *    file, xử lý entry khác bình thường) thay vì gọi ComfyUI với tham số sai.
 * 2. entry.duration (giây) truyền THẲNG dạng số cho generateVideoComfyMiniMaxH3
 *    (KHÔNG chuẩn hoá thành chuỗi "Ns" như AIVideo/Pollo) — thiếu/không hợp
 *    lệ thì dùng COMFYUI_DEFAULT_DURATION_SECONDS.
 * 3. Lưu lại "comfyPromptId" (prompt_id ComfyUI) vào entry — cùng lý do với
 *    "polloResultId" ở generateVideosForFilePollo.
 */
export async function generateVideosForFileComfyUI(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string, errorMessage: string) => Promise<void>,
  onlyEntryIds?: string[],
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
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      if (onlyEntryIds && !onlyEntryIds.includes(e.id)) return false;
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));

  for (const entry of targets) {
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) && (r.type === "CHARACTER" || r.type === "LOCATION"),
      );

      if (refs.length === 0) {
        throw new Error(
          "ComfyUI (MiniMax H3 Reference to Video) cần ít nhất 1 ảnh tham chiếu — entry này không resolve được ref nào.",
        );
      }
      if (refs.length > MAX_MINIMAX_H3_REFERENCE_IMAGES) {
        throw new Error(
          `ComfyUI (MiniMax H3 Reference to Video) chỉ nhận tối đa ${MAX_MINIMAX_H3_REFERENCE_IMAGES} ảnh tham chiếu — entry này có ${refs.length} ref.`,
        );
      }

      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      const duration =
        typeof entry.duration === "number" && entry.duration > 0
          ? entry.duration
          : COMFYUI_DEFAULT_DURATION_SECONDS;

      // aspectRatio — field mới trong VIDEO entry (xem format_output.txt) —
      // chỉ nhận đúng giá trị hợp lệ, sai/thiếu thì để generateVideoComfyMiniMaxH3
      // tự dùng default (16:9, xem comfyui.ts). frameRate KHÔNG áp dụng cho
      // workflow MiniMax H3 (fps cố định 24 trong chính template).
      const aspectRatio =
        entry.aspectRatio === "9:16" || entry.aspectRatio === "16:9"
          ? entry.aspectRatio
          : undefined;

      if (isStopStoryboardRequested(inputPath)) break;

      console.log(
        `[storyboardPipeline] [VIDEO] ${entry.id} — đang tạo video (ComfyUI)...`,
      );
      const { filePath: tempFilePath, promptId } =
        await generateWithContentViolationRetry(entry, jobId, () =>
          generateVideoComfyMiniMaxH3(
            refPaths,
            entry.prompt!,
            duration,
            jobId,
            aspectRatio,
          ),
        );
      entry.comfyPromptId = promptId;

      const destPath = path.join(outputDir, `${sanitizeId(entry.id)}.mp4`);
      try {
        await fs.promises.rename(tempFilePath, destPath);
      } catch {
        await fs.promises.copyFile(tempFilePath, destPath);
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }

      entry.success = true;
      succeeded++;
      if (onEntryDone) {
        await onEntryDone(destPath).catch((err) => {});
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] [VIDEO] ${entry.id} — lỗi:`,
        err instanceof Error ? err.message : err,
      );
      if (onEntryError) {
        await onEntryError(
          entry.id,
          err instanceof Error ? err.message : String(err),
        ).catch((err) => {});
        await sleep(1000);
      }
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
      if (e.type !== "SCENE_SETTING_START" && e.type !== "SCENE_SETTING_END")
        return false;
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
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;
    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    try {
      // Entry SCENE_SETTING_END luôn ref TỚI 1 entry boundary khác (chính nó
      // là SCENE_SETTING_START của cùng run, hoặc SCENE_SETTING_END của clip
      // liền trước — xem PHẦN 2 hợp đồng JSON/format_output.txt) làm "ảnh mở
      // đầu" trước khi vẽ tiếp — chấp nhận cả 2 type boundary, không chỉ
      // CHARACTER/LOCATION.
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING_START" ||
            r.type === "SCENE_SETTING_END"),
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
 *
 * onVideoEntriesReady (tuỳ chọn): gọi NGAY sau MỖI entry "SCENE_SETTING_END"
 * vừa xong (generate mới hoặc phát hiện đã có sẵn file) VỚI danh sách id các
 * entry VIDEO vừa đủ điều kiện tạo video (xem findVideoEntriesReadyAfterEnd)
 * — cho phép caller (queue.ts) tự đẩy job "storyboardVideo" riêng cho từng
 * clip ngay khi sẵn sàng, không cần chờ hết cả file. Mảng rỗng = chưa có clip
 * nào vừa đủ điều kiện, KHÔNG gọi callback (đỡ 1 lượt gọi thừa).
 */
export async function generateSceneImagesForFileViaAIVideo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string) => Promise<void>,
  onVideoEntriesReady?: (readyEntryIds: string[]) => Promise<void>,
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
      if (e.type !== "SCENE_SETTING_START" && e.type !== "SCENE_SETTING_END")
        return false;
      if (!e.id || typeof e.prompt !== "string" || !e.prompt) {
        return false;
      }
      return true;
    },
  );

  let succeeded = 0;
  let failed = 0;
  const failedEntries: FailedEntry[] = [];
  // const hasEntryWithSuccess = entries.some(
  //   (item) => item?.success !== undefined && item.success !== null,
  // );

  // if (hasEntryWithSuccess) {
  //   return { outputDir, succeeded, failed, failedEntries };
  // }
  const jsonBaseName = path.basename(inputPath, path.extname(inputPath));

  // Gọi onVideoEntriesReady (nếu có) NGAY sau khi 1 entry SCENE_SETTING_END
  // vừa xong — best-effort, lỗi ở callback (vd enqueue job thất bại phía
  // queue.ts) KHÔNG tính là lỗi generate ảnh (ảnh đã lưu thành công thật).
  const notifyVideoEntriesReadyIfEnd = async (
    doneEntry: StoryboardEntry,
  ): Promise<void> => {
    if (doneEntry.type !== "SCENE_SETTING_END" || !onVideoEntriesReady) return;
    if (!doneEntry.id || doneEntry.success !== true) return;
    try {
      const readyEntryIds = await findVideoEntriesReadyAfterEnd(
        entries,
        outputDir,
        doneEntry.id,
      );
      if (readyEntryIds.length > 0) {
        await onVideoEntriesReady(readyEntryIds);
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] onVideoEntriesReady thất bại cho "${doneEntry.id}" (không tính là lỗi generate):`,
        err,
      );
    }
  };

  for (const entry of targets) {
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;

    // Ảnh id này đã tồn tại sẵn trong folder generated/ (vd user tự upload
    // thay thế, hoặc lần chạy trước đã lưu file nhưng saveEntries chưa kịp
    // ghi "success": true) — không gen lại tốn credit, chỉ đánh dấu success.
    const existingImagePath = await findExistingImageById(
      outputDir,
      sanitizeId(entry.id),
    );
    if (existingImagePath) {
      entry.success = true;
      succeeded++;
      await saveEntries(inputPath, entries);
      await notifyVideoEntriesReadyIfEnd(entry);
      continue;
    }

    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh (aiVideo)...`,
    );
    let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING_START" ||
            r.type === "SCENE_SETTING_END"),
      );
      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      const imagePaths = await generateWithContentViolationRetry(
        entry,
        jobId,
        () =>
          generateImage(
            entry.prompt!,
            { referenceImagePaths: refPaths, imageCount: 1 },
            jobId,
          ),
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
        await sleep(1000);
      }
    }
    await saveEntries(inputPath, entries);
    await notifyVideoEntriesReadyIfEnd(entry);
  }

  return { outputDir, succeeded, failed, failedEntries };
}

/**
 * GIỐNG generateSceneImagesForFileViaAIVideo HỆT (cùng lọc SCENE_SETTING_START/
 * SCENE_SETTING_END, cùng quy ước resolve ref CHARACTER/LOCATION/SCENE_SETTING,
 * lưu file/success/onEntryDone/onEntryError/resume, cùng cơ chế
 * onVideoEntriesReady/findVideoEntriesReadyAfterEnd) nhưng tạo ảnh qua
 * pollo.ai (generateImage trong polloImage.ts, cùng cách
 * generateReferenceImagesForFileViaPollo đã làm) THAY VÌ AIVideo — provider
 * SONG SONG, KHÔNG thay thế hàm trên. Hàm RIÊNG, KHÔNG sửa
 * generateSceneImagesForFileViaAIVideo.
 *
 * Ảnh ref (nếu có) truyền qua PolloGenerateImageOptions.referenceImagePaths.
 * generateImage() của polloImage.ts LUÔN trả về mảng ĐÚNG 1 ảnh (không có
 * khái niệm "imageCount" nhiều ảnh/lần như AIVideo) nên đoạn "ảnh đầu + xoá
 * ảnh thừa" bên dưới gần như no-op — giữ nguyên cấu trúc để đồng nhất/dễ so
 * sánh với hàm AIVideo, cùng lý do đã giải thích ở
 * generateReferenceImagesForFileViaPollo.
 *
 * Lưu lại "polloResultId" (id nội bộ pollo.ai) vào entry — cùng lý do với
 * generateReferenceImagesForFileViaPollo/generateVideosForFilePollo.
 */
export async function generateSceneImagesForFileViaPollo(
  inputPath: string,
  onEntryDone?: (filePath: string) => Promise<void>,
  onEntryError?: (filePath: string) => Promise<void>,
  onVideoEntriesReady?: (readyEntryIds: string[]) => Promise<void>,
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
      if (e.type !== "SCENE_SETTING_START" && e.type !== "SCENE_SETTING_END")
        return false;
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

  // Cùng cơ chế/lý do với generateSceneImagesForFileViaAIVideo.
  const notifyVideoEntriesReadyIfEnd = async (
    doneEntry: StoryboardEntry,
  ): Promise<void> => {
    if (doneEntry.type !== "SCENE_SETTING_END" || !onVideoEntriesReady) return;
    if (!doneEntry.id || doneEntry.success !== true) return;
    try {
      const readyEntryIds = await findVideoEntriesReadyAfterEnd(
        entries,
        outputDir,
        doneEntry.id,
      );
      if (readyEntryIds.length > 0) {
        await onVideoEntriesReady(readyEntryIds);
      }
    } catch (err) {
      console.error(
        `[storyboardPipeline] onVideoEntriesReady thất bại cho "${doneEntry.id}" (không tính là lỗi generate):`,
        err,
      );
    }
  };

  // SỬA (theo yêu cầu người dùng): CHẠY TUẦN TỰ, KHÔNG song song — khác
  // generateReferenceImagesForFileViaPollo (CHARACTER/LOCATION độc lập hoàn
  // toàn, an toàn song song). SCENE_SETTING_END của clip N LUÔN ref tới
  // boundary khởi đầu của chính clip N — vật lý chính là SCENE_SETTING_END
  // của clip N-1 CÙNG SHOT (trừ clip 01, ref SCENE_SETTING_START) — xem mục 3
  // format_output.txt. Ảnh của entry sau cần ảnh của entry ngay trước nó
  // (cùng shot) ĐÃ tồn tại trên đĩa — giữ tuần tự đúng thứ tự khai báo trong
  // file (đã đúng thứ tự phụ thuộc theo mục 5 format_output.txt) để tránh
  // race condition, không cố song song hoá.
  for (const entry of targets) {
    if (isStopStoryboardRequested(inputPath)) break;
    if (entry?.success) continue;

    const existingImagePath = await findExistingImageById(
      outputDir,
      sanitizeId(entry.id),
    );
    if (existingImagePath) {
      entry.success = true;
      succeeded++;
      await saveEntries(inputPath, entries);
      await notifyVideoEntriesReadyIfEnd(entry);
      continue;
    }

    const jobId = `${jsonBaseName}_${entry.id}_${new Date().toISOString()}`;
    console.log(
      `[storyboardPipeline] [${entry.type}] ${entry.id} — đang tạo ảnh (pollo)...`,
    );
    let destPath = path.join(outputDir, `${sanitizeId(entry.id)}`);
    try {
      const refs = (entry.ref ?? []).filter(
        (r): r is Required<StoryboardRefItem> =>
          Boolean(r.id) &&
          (r.type === "CHARACTER" ||
            r.type === "LOCATION" ||
            r.type === "SCENE_SETTING_START" ||
            r.type === "SCENE_SETTING_END"),
      );
      const refPaths: string[] = [];
      for (const ref of refs) {
        refPaths.push(await resolveRefImagePath(outputDir, sanitizeId(ref.id)));
      }

      const { filePaths: imagePaths, polloResultId } =
        await generateWithContentViolationRetry(entry, jobId, () =>
          withPolloTaskSlot(() =>
            generateImagePollo(
              entry.prompt!,
              { referenceImagePaths: refPaths },
              jobId,
            ),
          ),
        );
      if (polloResultId) {
        entry.polloResultId = polloResultId;
      }
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
        await sleep(1000);
      }
    }
    await saveEntries(inputPath, entries);
    await notifyVideoEntriesReadyIfEnd(entry);
  }

  return { outputDir, succeeded, failed, failedEntries };
}

// verifyVideos("/Users/linhnt/workspaces/bot/generate_video/storage/generated/ep01_new_art/ep01_new_art.json")
//   .then(console.log)
//   .catch(console.error);
