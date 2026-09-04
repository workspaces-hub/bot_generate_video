import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  MAX_OMNI_REFERENCE_ITEMS,
  MAX_VIDEO_REF_IMAGES,
} from "../automation/aiVideo";
import { MAX_REFERENCE_IMAGES } from "../automation/aiVideoImage";
import { SCRIPT_SECTION_MARKER } from "../automation/chatAI";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
import {
  generatedDirFor,
  sanitizeId,
  type StoryboardEntry,
} from "../automation/storyboardPipeline";
import { config } from "../config";
import {
  confirmImageGeneration,
  confirmImageGenerationPollo,
  confirmSceneGeneration,
  confirmVideoGeneration,
  confirmVideoGenerationPollo,
  continueFailedStoryboardImages,
  continueFailedStoryboardVideo,
  continueFailedStoryboardVideoPollo,
  enqueueJob,
  isStoryboardJobQueued,
  stopAll,
} from "../queue";
import {
  CHARACTER_REF_BUTTON_LABEL,
  CHATAI_BUTTON_LABEL,
  CHATAI_CHECK_BUTTON_LABEL,
  CONTINUE_SCENE_FRAME_BUTTON_LABEL,
  CONTINUE_VIDEO_BUTTON_LABEL,
  IMAGE_BUTTON_LABEL,
  OMNI_REF_BUTTON_LABEL,
  PROMPT_BUTTON_LABEL,
  STOP_ALL_BUTTON_LABEL,
  VIDEO_REF_BUTTON_LABEL,
  promptMenu,
} from "./keyboard";

type PendingMode =
  | "video"
  | "image"
  | "videoRef"
  | "characterRef"
  | "omniRef"
  | "chatAI"
  | "chatAICheck"
  | "continueVideo"
  | "continueSceneFrame";
// userId đang chờ nhập prompt, theo chế độ đã chọn (bấm nút Prompt/Image/Video - Image Reference/Video - Character Reference/Video - Omni Reference).
const waitingMode = new Map<number, PendingMode>();

// Gom ảnh tham chiếu gửi liên tiếp từ CÙNG 1 user trong 1 khoảng thời gian
// ngắn (tối đa MAX_REFERENCE_IMAGES ảnh). KHÔNG dựa vào media_group_id của
// Telegram — thực tế đã xác nhận nhiều client gửi nhiều ảnh liền nhau vẫn
// KHÔNG kèm media_group_id (khi xây tính năng Start/End Frame trước đây) —
// nên bot tự gom theo userId + thời gian, đáng tin cậy hơn.
//
// Nếu ảnh gửi lên KHÔNG kèm caption, buffer KHÔNG bị huỷ sau debounce — vẫn
// giữ lại chờ user gửi tiếp 1 tin nhắn text làm caption/prompt (rất phổ biến:
// gửi ảnh trước, gõ mô tả sau). bot.on(message("text")) luôn ưu tiên kiểm
// tra buffer ảnh đang chờ trước khi xử lý theo "mode" thông thường.
const PHOTO_BUFFER_DEBOUNCE_MS = 3000;
interface PendingPhotoBuffer {
  ctx: Context;
  /** "video": chỉ lấy ảnh GẦN NHẤT làm start frame. "image"/"videoRef": lấy HẾT làm ảnh tham chiếu. */
  mode: PendingMode;
  photoArrays: Array<Array<{ file_id: string }>>;
  caption?: string;
  promptMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingPhotoBuffers = new Map<number, PendingPhotoBuffer>();

/** Số ảnh tối đa được gom theo từng mode — "videoRef" giới hạn thấp hơn nhiều so với "image". */
function maxPhotosForMode(mode: PendingMode): number {
  return mode === "videoRef" ? MAX_VIDEO_REF_IMAGES : MAX_REFERENCE_IMAGES;
}

// Buffer riêng cho "omniRef" (ảnh/video/audio tối đa MAX_OMNI_REFERENCE_ITEMS)
// — khác pendingPhotoBuffers vì cần biết LOẠI file (không chỉ ảnh) để tải
// đúng cách và đặt đúng đuôi file khi lưu.
type OmniRefKind = "photo" | "video" | "audio";
interface PendingOmniRefItem {
  kind: OmniRefKind;
  fileId: string;
}
interface PendingOmniRefBuffer {
  ctx: Context;
  items: PendingOmniRefItem[];
  caption?: string;
  promptMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingOmniRefBuffers = new Map<number, PendingOmniRefBuffer>();

/**
 * Bấm lại bất kỳ nút menu nào (kể cả bấm lại đúng nút cũ) TRƯỚC khi gõ prompt
 * nghĩa là user muốn bắt đầu lại — huỷ hết ảnh/video/audio đã gửi dở dang
 * (chưa có prompt nên chưa tải file thật nào về, chỉ đang giữ file_id nên
 * không cần dọn file trên đĩa) để tránh lẫn vào batch tiếp theo. Trả về true
 * nếu có gì đó thực sự bị xoá (để báo cho user biết).
 */
function clearPendingUploads(userId: number): boolean {
  let hadSomething = false;

  const photoBuffer = pendingPhotoBuffers.get(userId);
  if (photoBuffer) {
    clearTimeout(photoBuffer.timer);
    pendingPhotoBuffers.delete(userId);
    hadSomething = true;
  }

  const omniRefBuffer = pendingOmniRefBuffers.get(userId);
  if (omniRefBuffer) {
    clearTimeout(omniRefBuffer.timer);
    pendingOmniRefBuffers.delete(userId);
    hadSomething = true;
  }

  return hadSomething;
}

function omniRefExtension(kind: OmniRefKind): string {
  if (kind === "photo") return ".jpg";
  if (kind === "video") return ".mp4";
  return ".mp3";
}

function isAdmin(userId: number): boolean {
  return config.admins.includes(userId.toString());
}

function isAllowedGroup(chatId: number): boolean {
  return chatId === config.groupChatId || chatId === config.groupChatIdTest;
}

/** Chặn mọi tương tác từ user không có trong ADMINS (xem .env). */
async function checkAdmin(
  ctx: Context,
  next: () => Promise<void>,
): Promise<void> {
  const userId = ctx.from?.id;
  if (userId && isAdmin(userId)) {
    return next();
  }
}

/** Tải ảnh Telegram (độ phân giải cao nhất) về local để upload lên AIVideo. */
async function downloadTelegramPhoto(
  ctx: Context,
  photos: Array<{ file_id: string }>,
): Promise<string> {
  const fileId = photos[photos.length - 1].file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Tải ảnh từ Telegram thất bại: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.mkdir(config.uploadsDir, { recursive: true });
  const imagePath = path.join(config.uploadsDir, `${randomUUID()}.jpg`);
  await fs.writeFile(imagePath, buffer);
  return imagePath;
}

/** Tải 1 file Telegram bất kỳ (ảnh/video/audio, dùng cho "omniRef") về local. */
async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  ext: string,
): Promise<string> {
  const fileUrl = await ctx.telegram.getFileLink(fileId);

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Tải file từ Telegram thất bại: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.mkdir(config.uploadsDir, { recursive: true });
  const filePath = path.join(config.uploadsDir, `${randomUUID()}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Prompt cố định gửi kèm khi user đưa yêu cầu qua file (.txt/.md) thay vì gõ
 * trực tiếp — file được UPLOAD thẳng lên ChatAI (xem askChatAI,
 * downloadTelegramFile + submitChatAIJob), ChatAI tự đọc nội dung file, không cần
 * dán nguyên văn bản file làm prompt text nữa (tránh dán prompt siêu dài).
 */
const CHATAI_FILE_ATTACHMENT_PROMPT = "Hãy thực hiện yêu cầu trong file sau";

/**
 * Tên file dạng "<tên file json>__<tên file ảnh/video>.<đuôi>" — ĐÚNG format
 * bot tự đặt tên khi gửi kết quả cho user (xem queue.ts, dấu "__" phân tách
 * tên file json và tên file ảnh/video). Tách theo dấu "__" ĐẦU TIÊN —
 * jsonBaseName lấy từ sanitizeId (storyboardPipeline.ts) chỉ có gạch dưới
 * ĐƠN, không có "__", nên phần còn lại sau "__" đầu tiên chắc chắn là tên
 * file gốc (kèm đuôi). Dùng cho fileName (tên file THẬT — luôn có đuôi).
 */
const REPLACEMENT_FILENAME_PATTERN = /^(.+?)__([^/\\]+\.[A-Za-z0-9]+)$/;

/**
 * GIỐNG REPLACEMENT_FILENAME_PATTERN nhưng KHÔNG bắt buộc đuôi file — dùng
 * cho caption user tự gõ tay, không cần nhớ gõ kèm đuôi. Đuôi (nếu user có
 * gõ) vẫn nằm nguyên trong nhóm 2; tryReplaceGeneratedFile tự kiểm tra bằng
 * path.extname() và mặc định ".png" khi nhóm 2 không có đuôi nào.
 */
const REPLACEMENT_CAPTION_PATTERN = /^(.+?)__([^/\\]+)$/;

/**
 * Tìm số version kế tiếp cho backup "<name>_vXX<ext>" trong dir — quét các
 * file "<name>_v<số>.<đuôi>" ĐÃ có, lấy số lớn nhất rồi +1 (bắt đầu từ 1 nếu
 * chưa có backup nào) — XX tương ứng SỐ LẦN file này đã bị thay thế, theo
 * yêu cầu người dùng.
 */
async function nextBackupVersion(
  dir: string,
  name: string,
  ext: string,
): Promise<number> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const prefix = `${name}_v`;
  let maxVersion = 0;
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith(ext)) continue;
    const middle = f.slice(prefix.length, f.length - ext.length);
    if (/^\d+$/.test(middle)) {
      maxVersion = Math.max(maxVersion, parseInt(middle, 10));
    }
  }
  return maxVersion + 1;
}

/**
 * Đánh dấu "success": true cho ĐÚNG entry có id khớp targetId (so theo
 * sanitizeId — cùng quy ước đặt tên file <id>.<đuôi> dùng trong
 * storyboardPipeline.ts) trong file JSON storyboard ở jsonPath — dùng khi
 * user tự upload thay thế 1 file (xem tryReplaceGeneratedFile): file đã
 * THAY THẾ THỦ CÔNG coi như thành công, không cần chạy lại generate cho entry
 * đó nữa (các hàm generate*ForFile resume theo field "success", xem
 * storyboardPipeline.ts). Trả về true nếu tìm thấy VÀ đã cập nhật, false nếu
 * không tìm thấy entry khớp (file JSON có thể đã bị xoá/đổi tên) — KHÔNG
 * throw, để lỗi ở bước này không làm mất kết quả file đã thay thế thành công.
 */
async function markStoryboardEntrySuccess(
  jsonPath: string,
  targetId: string,
): Promise<boolean> {
  const raw = await fs.readFile(jsonPath, "utf-8");
  const entries: StoryboardEntry[] = JSON.parse(raw);
  const entry = entries.find((e) => e.id && sanitizeId(e.id) === targetId);
  if (!entry) return false;

  entry.success = true;
  await fs.writeFile(jsonPath, JSON.stringify(entries, null, 2), "utf-8");
  return true;
}

/** type entry → đúng type job/hàng đợi cần đẩy lại (xem tryRegenerateStoryboardItem). */
function storyboardJobTypeForEntryType(
  entryType: string | undefined,
):
  | "storyboardImagesAIVideo"
  | "storyboardSceneImagesAIVideo"
  | "storyboardVideo"
  | null {
  if (entryType === "CHARACTER" || entryType === "LOCATION") {
    return "storyboardImagesAIVideo";
  }
  if (
    entryType === "SCENE_SETTING_START" ||
    entryType === "SCENE_SETTING_END"
  ) {
    return "storyboardSceneImagesAIVideo";
  }
  if (entryType === "VIDEO") {
    return "storyboardVideo";
  }
  return null;
}

/**
 * Xử lý ĐÚNG 1 dòng "<tên file json>__<id>" — tách riêng khỏi
 * tryRegenerateStoryboardItem để dùng lại cho nhiều dòng trong CÙNG 1 tin
 * nhắn (user gõ nhiều dòng, mỗi dòng 1 entry muốn tạo lại). Trả về null nếu
 * dòng này không khớp format/không tìm thấy file/entry (bỏ qua, không phải
 * lỗi); trả về chuỗi mô tả kết quả (để gộp báo cáo 1 lần) nếu đã xử lý.
 *
 * KHÔNG enqueue job mới nếu hàng đợi đã có SẴN 1 job ĐÚNG type + jsonPath
 * này (đang chờ hoặc đang xử lý, xem isStoryboardJobQueued) — job storyboard
 * luôn quét lại TOÀN BỘ entry "success" chưa true trong file mỗi lần chạy
 * (xem storyboardPipeline.ts), nên job đang có sẵn sẽ tự nhặt luôn entry vừa
 * đánh dấu lại ở đây khi tới lượt — thêm job thứ 2 chỉ tổ chạy trùng lặp.
 */
async function regenerateStoryboardItemLine(
  ctx: Context,
  line: string,
  promptMessageId: number,
): Promise<string | null> {
  const match = line.match(REPLACEMENT_CAPTION_PATTERN);
  if (!match) return null;

  const fileBaseName = match[1].trim().replace(/ +/g, "_");
  const targetId = match[2].trim();

  const jsonPath = path.join(
    generatedDirFor(fileBaseName),
    `${fileBaseName}.json`,
  );
  const exists = await fs
    .stat(jsonPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) return null;

  const raw = await fs.readFile(jsonPath, "utf-8");
  let entries: StoryboardEntry[];
  try {
    entries = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = entries.find((e) => e.id === targetId);
  if (!entry) return null;

  entry.success = false;
  await fs.writeFile(jsonPath, JSON.stringify(entries, null, 2), "utf-8");

  // Xoá file kết quả cũ (ảnh/video) của entry này trước khi generate lại —
  // tên file luôn "<id>.<đuôi>" trong CHÍNH folder generated này (xem
  // storyboardPipeline.ts) — không xoá thì file cũ vẫn còn lẫn sau khi
  // generate lại xong.
  const outputDir = path.dirname(jsonPath);
  const filesInDir = await fs.readdir(outputDir).catch(() => [] as string[]);
  const idFilePrefix = `${targetId}.`;
  for (const fileName of filesInDir) {
    if (fileName.startsWith(idFilePrefix)) {
      await fs.unlink(path.join(outputDir, fileName)).catch(() => {});
    }
  }

  const jobType = storyboardJobTypeForEntryType(entry.type);
  if (!jobType) {
    return `⚠️ "${line}": đã đánh dấu cần tạo lại nhưng type "${entry.type}" không xác định được hàng đợi tương ứng.`;
  }

  if (!isStoryboardJobQueued(jobType, jsonPath)) {
    enqueueJob({
      type: jobType,
      chatId: ctx.chat!.id,
      userId: ctx.from!.id,
      prompt: "",
      promptMessageId,
      jsonPath,
    });
  }
  return `✅ "${line}" (${entry.type}): đã đưa vào hàng đợi tạo lại.`;
}

/**
 * User gõ tay (KHÔNG cần bấm nút, KHÔNG cần upload gì) tin nhắn dạng
 * "<tên file json>__<id>" — cùng quy ước "__" với tryReplaceGeneratedFile,
 * nhưng NGƯỢC LẠI: yêu cầu TẠO LẠI đúng 1 entry cụ thể (thay vì thay thế thủ
 * công). Chấp nhận NHIỀU dòng trong CÙNG 1 tin nhắn (mỗi dòng 1 entry) — xử
 * lý TUẦN TỰ từng dòng qua regenerateStoryboardItemLine, gộp kết quả vào 1
 * tin reply duy nhất thay vì spam nhiều tin riêng lẻ.
 *
 * Nếu KHÔNG dòng nào khớp format/tìm thấy file/entry, trả về false — coi như
 * tin nhắn này không liên quan gì (có thể chỉ là 1 prompt bình thường trùng
 * hợp chứa "__"), để caller rơi xuống xử lý luồng text thông thường. Chỉ CẦN
 * ÍT NHẤT 1 dòng xử lý được thì coi cả tin nhắn này đã được xử lý (trả về
 * true), các dòng còn lại không khớp/không tìm thấy sẽ bị bỏ qua âm thầm.
 */
async function tryRegenerateStoryboardItem(
  ctx: Context,
  text: string,
  promptMessageId: number,
): Promise<boolean> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const results: string[] = [];
  for (const line of lines) {
    const result = await regenerateStoryboardItemLine(
      ctx,
      line,
      promptMessageId,
    );
    if (result) results.push(result);
  }

  if (results.length === 0) return false;

  await ctx.reply(results.join("\n"), {
    reply_parameters: { message_id: promptMessageId },
  });
  return true;
}

/**
 * User gửi lại ảnh/video có TÊN FILE ĐÚNG format bot tự đặt tên khi gửi kết
 * quả — ưu tiên tên file thật (document/video: Telegram giữ nguyên tên file
 * gốc, đáng tin cậy hơn), fallback về caption nếu không có tên file khớp
 * (photo: Telegram nén ảnh nên PhotoSize KHÔNG có file_name, chỉ còn cách
 * dựa vào caption user tự gõ) — coi đây là yêu cầu THAY THẾ file đã generate
 * trước đó bằng file mới (sửa tay 1 ảnh/video bị lỗi mà không cần chạy lại cả
 * job ChatAI). Backup file cũ (nếu có) thành "<tên>_vXX.<đuôi>" (XX tăng dần
 * theo số lần thay thế, xem nextBackupVersion) trước khi ghi đè — không mất
 * dữ liệu cũ, file MỚI upload giữ nguyên tên gốc. Sau khi ghi file xong,
 * đánh dấu luôn entry tương ứng trong JSON storyboard là "success": true
 * (xem markStoryboardEntrySuccess) — để lần chạy lại/resume sau (vd bấm
 * "Tiếp tục tạo video") không generate đè lên file vừa thay thế thủ công.
 * Trả về true nếu ĐÃ xử lý (tên file HOẶC caption khớp format) — handler gọi
 * hàm này phải dừng lại ngay, không xử lý tiếp theo luồng ảnh/video tham
 * chiếu thường.
 */
async function tryReplaceGeneratedFile(
  ctx: Context,
  fileId: string,
  fileName: string | undefined,
  caption: string | undefined,
  promptMessageId: number,
): Promise<boolean> {
  const fileNameMatch = fileName?.trim().match(REPLACEMENT_FILENAME_PATTERN);
  const captionMatch = fileNameMatch
    ? null
    : caption?.trim().match(REPLACEMENT_CAPTION_PATTERN);
  const match = fileNameMatch ?? captionMatch;
  if (!match) return false;

  const [, jsonBaseName, rawTargetFileName] = match;
  // Caption không bắt buộc gõ đuôi (REPLACEMENT_CAPTION_PATTERN không bắt
  // buộc "." như REPLACEMENT_FILENAME_PATTERN) — mặc định ".png" nếu thiếu.
  const targetFileName = path.extname(rawTargetFileName)
    ? rawTargetFileName
    : `${rawTargetFileName}.png`;
  const dir = generatedDirFor(jsonBaseName);
  const targetPath = path.join(dir, targetFileName);

  try {
    await fs.mkdir(dir, { recursive: true });

    const targetExists = await fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (targetExists) {
      const { name, ext } = path.parse(targetFileName);
      const version = await nextBackupVersion(dir, name, ext);
      const backupFileName = `${name}_v${String(version).padStart(2, "0")}${ext}`;
      await fs.copyFile(targetPath, path.join(dir, backupFileName));
    }

    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Tải file từ Telegram thất bại: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, buffer);

    const targetId = path.parse(targetFileName).name;
    const jsonPath = path.join(dir, `${jsonBaseName}.json`);
    await markStoryboardEntrySuccess(jsonPath, targetId).catch((err) => {
      console.error(
        `[bot] Cập nhật success cho entry "${targetId}" trong "${jsonPath}" thất bại:`,
        err,
      );
      return false;
    });

    await ctx.reply(
      `✅ Đã thay thế "${targetFileName}" trong "${jsonBaseName}".`,
      { reply_parameters: { message_id: promptMessageId } },
    );
  } catch (err) {
    console.error("[bot] Thay thế file thất bại:", err);
    await ctx.telegram.sendMessage(
      config.adminsNotify,
      `❌ Không thay thế được file "${targetFileName}" trong "${jsonBaseName}": ${err instanceof Error ? err.message : err}`,
    );
  }

  return true;
}

/**
 * Copy field "success" từ entry CŨ sang entry MỚI có CÙNG id (so theo
 * sanitizeId — cùng quy ước với markStoryboardEntrySuccess) — dùng khi user
 * upload lại JSON storyboard đè lên file đã có (xem
 * tryHandleReferenceJsonUpload): user có thể chỉ sửa vài prompt rồi upload
 * lại NGUYÊN file, các entry KHÔNG đổi id mà đã generate xong ở file cũ
 * không nên bị coi như "chưa chạy" chỉ vì đây là 1 lần upload mới — mutate
 * trực tiếp từng phần tử trong newEntries, trả về số entry đã copy được.
 */
function mergeStoryboardSuccess(
  oldEntries: StoryboardEntry[],
  newEntries: StoryboardEntry[],
): number {
  const oldSuccessById = new Map<string, boolean>();
  for (const e of oldEntries) {
    if (e.id && e.success !== undefined) {
      oldSuccessById.set(sanitizeId(e.id), e.success);
    }
  }

  let mergedCount = 0;
  for (const e of newEntries) {
    if (!e.id) continue;
    const oldSuccess = oldSuccessById.get(sanitizeId(e.id));
    if (oldSuccess !== undefined) {
      e.success = oldSuccess;
      mergedCount++;
    }
  }
  return mergedCount;
}

/**
 * User upload TRỰC TIẾP 1 file .json (KHÔNG cần caption đặc biệt như
 * tryReplaceGeneratedFile) — coi đây là kịch bản storyboard cho folder
 * generated/<tên file json>/ (cùng quy ước tên với
 * generatedDirFor). Nếu folder CHƯA có (lần đầu upload json này): tạo
 * folder + copy file vào làm kịch bản chính. Nếu folder đã có SẴN 1 file json
 * chính rồi: backup file cũ thành "<tên>_vXX.json" (XX tăng dần, xem
 * nextBackupVersion), rồi COPY "success" từ các entry cũ sang entry mới
 * khớp id (xem mergeStoryboardSuccess) trước khi ghi file MỚI vào thay thế
 * (giữ nguyên tên gốc) — GIỐNG cơ chế tryReplaceGeneratedFile, dùng chung
 * nextBackupVersion. Trả về true nếu ĐÃ xử lý (đuôi .json) — handler gọi hàm
 * này phải dừng lại ngay, không rơi xuống luồng upload prompt file (.txt/.md)
 * hay ảnh/video tham chiếu thường.
 */
async function tryHandleReferenceJsonUpload(
  ctx: Context,
  fileId: string,
  fileName: string | undefined,
  promptMessageId: number,
): Promise<boolean> {
  if (!fileName || path.extname(fileName).toLowerCase() !== ".json") {
    return false;
  }
  // Gộp nhiều khoảng trắng liên tiếp thành 1, rồi thay bằng "_" — cùng quy
  // ước với originalFileName ở luồng upload prompt file (.txt/.md) bên dưới.
  const normalizedFileName = fileName.replace(/ +/g, "_");
  const dir = generatedDirFor(normalizedFileName);
  const targetPath = path.join(dir, normalizedFileName);

  try {
    await fs.mkdir(dir, { recursive: true });

    let backupNote = "";
    let mergedCount = 0;
    const targetExists = await fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);

    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Tải file từ Telegram thất bại: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    if (targetExists) {
      const { name, ext } = path.parse(normalizedFileName);
      const version = await nextBackupVersion(dir, name, ext);
      const backupFileName = `${name}_v${String(version).padStart(2, "0")}${ext}`;
      await fs.copyFile(targetPath, path.join(dir, backupFileName));
      backupNote = ` (đã sao lưu bản cũ thành "${backupFileName}")`;

      try {
        const oldEntries: StoryboardEntry[] = JSON.parse(
          await fs.readFile(targetPath, "utf-8"),
        );
        const newEntries: StoryboardEntry[] = JSON.parse(
          buffer.toString("utf-8"),
        );
        mergedCount = mergeStoryboardSuccess(oldEntries, newEntries);
        await fs.writeFile(
          targetPath,
          JSON.stringify(newEntries, null, 2),
          "utf-8",
        );
      } catch (err) {
        console.error(
          `[bot] Copy success từ JSON cũ sang JSON mới thất bại (ghi nguyên file mới upload, không merge):`,
          err,
        );
        await fs.writeFile(targetPath, buffer);
      }
    } else {
      await fs.writeFile(targetPath, buffer);
    }

    await ctx.reply(`✅ Đã lưu kịch bản "${normalizedFileName}".`, {
      reply_parameters: { message_id: promptMessageId },
    });
  } catch (err) {
    console.error("[bot] Lưu file json tham chiếu thất bại:", err);
    await ctx.telegram.sendMessage(
      config.adminsNotify,
      `❌ Không lưu được file json "${normalizedFileName}": ${err instanceof Error ? err.message : err}`,
    );
  }

  return true;
}

interface SubmitVideoParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
  startFramePath?: string;
  referenceImagePaths?: string[];
  characterImagePath?: string;
  omniReferencePaths?: string[];
}

async function submitVideoJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  rawText,
  startFramePath,
  referenceImagePaths,
  characterImagePath,
  omniReferencePaths,
}: SubmitVideoParams): Promise<void> {
  const {
    text: prompt,
    resolution,
    model,
    duration,
  } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    if (startFramePath) await fs.unlink(startFramePath).catch(() => {});
    if (characterImagePath) await fs.unlink(characterImagePath).catch(() => {});
    for (const p of referenceImagePaths ?? [])
      await fs.unlink(p).catch(() => {});
    for (const p of omniReferencePaths ?? [])
      await fs.unlink(p).catch(() => {});
    return;
  }

  const startFrameNote = startFramePath ? " (kèm ảnh start frame)" : "";
  const refImageNote =
    referenceImagePaths && referenceImagePaths.length > 0
      ? ` (kèm ${referenceImagePaths.length} ảnh tham chiếu)`
      : "";
  const characterNote = characterImagePath ? " (kèm ảnh nhân vật)" : "";
  const omniNote =
    omniReferencePaths && omniReferencePaths.length > 0
      ? ` (kèm ${omniReferencePaths.length} file tham chiếu)`
      : "";
  const statusMessage = await ctx.reply(
    `⏳ Đang tạo video cho prompt:\n"${prompt.split(" ").slice(0, 20).join(" ")}"${startFrameNote}${refImageNote}${characterNote}${omniNote}`,
    {
      reply_parameters: { message_id: promptMessageId },
    },
  );

  // Chỉ dữ liệu thuần (không callback/ctx) — enqueueJob tự ghi ra file để
  // sống sót qua restart/crash, xem src/queue.ts.
  enqueueJob({
    type: "video",
    chatId: groupChatId,
    userId,
    prompt,
    resolution,
    model: isAdmin(userId) ? model : DEFAULT_MODEL,
    duration,
    startFramePath,
    referenceImagePaths,
    characterImagePath,
    omniReferencePaths,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
  });
}

interface SubmitImageParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
  referenceImagePaths: string[];
}

async function submitImageJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  rawText,
  referenceImagePaths,
}: SubmitImageParams): Promise<void> {
  const { text: prompt, model } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    for (const p of referenceImagePaths) await fs.unlink(p).catch(() => {});
    return;
  }

  const refNote =
    referenceImagePaths.length > 0
      ? ` (kèm ${referenceImagePaths.length} ảnh tham chiếu)`
      : "";
  const statusMessage = await ctx.reply(
    `⏳ Đang tạo ảnh cho prompt:\n"${prompt.split(" ").slice(0, 20).join(" ")}"${refNote}`,
    {
      reply_parameters: { message_id: promptMessageId },
    },
  );

  enqueueJob({
    type: "image",
    chatId: groupChatId,
    userId,
    prompt,
    model: isAdmin(userId) ? model : DEFAULT_MODEL,
    referenceImagePaths,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
  });
}

interface SubmitChatAIParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
  /** Tên file .txt user upload làm prompt (nếu gửi qua file thay vì gõ text) — dùng đặt tên lại file JSON ChatAI trả về, xem queue.ts. */
  promptFileName?: string;
  /** Path local file prompt (nếu gửi qua upload file) — UPLOAD file này lên ChatAI thay vì dán nội dung làm prompt text, xem CHATAI_FILE_ATTACHMENT_PROMPT. */
  promptAttachmentPath?: string;
}

/** Chế độ "ChatAI" chỉ nhận text thuần, không có ảnh/model/resolution nào — dùng thẳng rawText làm prompt, không qua parsePromptMessage. */
async function submitChatAIJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  rawText,
  promptFileName,
  promptAttachmentPath,
}: SubmitChatAIParams): Promise<void> {
  const prompt = rawText.trim();

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    return;
  }

  const statusMessage = await ctx.reply("⏳ Đang xử lý", {
    reply_parameters: { message_id: promptMessageId },
  });

  enqueueJob({
    type: "chatAI",
    chatId: groupChatId,
    userId,
    prompt,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
    promptFileName,
    promptAttachmentPath,
  });
}

/**
 * Nếu buffer đã có caption thì xử lý luôn; nếu chưa, GIỮ NGUYÊN buffer
 * (không xoá, không báo lỗi) — chờ user gửi tiếp 1 tin nhắn text làm prompt
 * (xem nhánh kiểm tra buffer trong bot.on(message("text"))).
 */
function finalizeIfHasCaption(userId: number): void {
  const current = pendingPhotoBuffers.get(userId);
  if (!current) return;
  if ((current.caption ?? "").trim()) {
    pendingPhotoBuffers.delete(userId);
    void handlePhotoBuffer(current, current.caption ?? "");
  }
}

/** Reset debounce timer sau mỗi ảnh mới nhận được. */
function scheduleFinalize(userId: number): void {
  const buffer = pendingPhotoBuffers.get(userId);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(
    () => finalizeIfHasCaption(userId),
    PHOTO_BUFFER_DEBOUNCE_MS,
  );
}

async function handlePhotoBuffer(
  buffer: PendingPhotoBuffer,
  rawText: string,
): Promise<void> {
  const { ctx, mode, photoArrays, promptMessageId } = buffer;
  if (!ctx.chat || !ctx.from) return;

  if (mode === "video") {
    // Chỉ cần ảnh GẦN NHẤT làm start frame — các ảnh gửi trước đó (nếu có)
    // bị bỏ qua, không cần tải về.
    let startFramePath: string;
    try {
      startFramePath = await downloadTelegramPhoto(
        ctx,
        photoArrays[photoArrays.length - 1],
      );
    } catch (err) {
      console.error("[bot] Tải ảnh Telegram thất bại:", err);
      await ctx.reply("Không tải được ảnh từ Telegram, đã huỷ.", promptMenu);
      return;
    }

    await submitVideoJob({
      ctx,
      groupChatId: ctx.chat.id,
      promptMessageId,
      userId: ctx.from.id,
      rawText,
      startFramePath,
    });
    return;
  }

  if (mode === "characterRef") {
    // Bắt buộc đúng 1 ảnh nhân vật — chỉ lấy ảnh GẦN NHẤT nếu gửi nhiều.
    let characterImagePath: string;
    try {
      characterImagePath = await downloadTelegramPhoto(
        ctx,
        photoArrays[photoArrays.length - 1],
      );
    } catch (err) {
      console.error("[bot] Tải ảnh Telegram thất bại:", err);
      await ctx.reply("Không tải được ảnh từ Telegram, đã huỷ.", promptMenu);
      return;
    }

    await submitVideoJob({
      ctx,
      groupChatId: ctx.chat.id,
      promptMessageId,
      userId: ctx.from.id,
      rawText,
      characterImagePath,
    });
    return;
  }

  // "videoRef": lấy HẾT ảnh đã gom (tối đa MAX_VIDEO_REF_IMAGES) làm ảnh
  // tham chiếu cho video — khác "image" chỉ ở chỗ dùng submitVideoJob thay
  // vì submitImageJob.
  const referenceImagePaths: string[] = [];
  try {
    for (const photos of photoArrays) {
      referenceImagePaths.push(await downloadTelegramPhoto(ctx, photos));
    }
  } catch (err) {
    console.error("[bot] Tải ảnh Telegram thất bại:", err);
    await ctx.reply("Không tải được ảnh từ Telegram, đã huỷ.", promptMenu);
    for (const p of referenceImagePaths) await fs.unlink(p).catch(() => {});
    return;
  }

  if (mode === "videoRef") {
    await submitVideoJob({
      ctx,
      groupChatId: ctx.chat.id,
      promptMessageId,
      userId: ctx.from.id,
      rawText,
      referenceImagePaths,
    });
    return;
  }

  await submitImageJob({
    ctx,
    groupChatId: ctx.chat.id,
    promptMessageId,
    userId: ctx.from.id,
    rawText,
    referenceImagePaths,
  });
}

/** Cùng logic finalizeIfHasCaption nhưng cho buffer "omniRef". */
function finalizeOmniRefIfHasCaption(userId: number): void {
  const current = pendingOmniRefBuffers.get(userId);
  if (!current) return;
  if ((current.caption ?? "").trim()) {
    pendingOmniRefBuffers.delete(userId);
    void handleOmniRefBuffer(current, current.caption ?? "");
  }
}

/** Cùng logic scheduleFinalize nhưng cho buffer "omniRef". */
function scheduleOmniRefFinalize(userId: number): void {
  const buffer = pendingOmniRefBuffers.get(userId);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(
    () => finalizeOmniRefIfHasCaption(userId),
    PHOTO_BUFFER_DEBOUNCE_MS,
  );
}

/** Thêm 1 item (ảnh/video/audio) vào buffer "omniRef", tạo buffer mới nếu chưa có. */
function addOmniRefItem(
  userId: number,
  ctx: Context,
  kind: OmniRefKind,
  fileId: string,
  caption: string | undefined,
  promptMessageId: number,
): void {
  const existing = pendingOmniRefBuffers.get(userId);
  if (existing) {
    if (existing.items.length < MAX_OMNI_REFERENCE_ITEMS) {
      existing.items.push({ kind, fileId });
    }
    if (caption) existing.caption = caption;
    scheduleOmniRefFinalize(userId);
  } else {
    pendingOmniRefBuffers.set(userId, {
      ctx,
      items: [{ kind, fileId }],
      caption,
      promptMessageId,
      timer: setTimeout(
        () => finalizeOmniRefIfHasCaption(userId),
        PHOTO_BUFFER_DEBOUNCE_MS,
      ),
    });
  }
}

async function handleOmniRefBuffer(
  buffer: PendingOmniRefBuffer,
  rawText: string,
): Promise<void> {
  const { ctx, items, promptMessageId } = buffer;
  if (!ctx.chat || !ctx.from) return;

  const omniReferencePaths: string[] = [];
  try {
    for (const item of items) {
      omniReferencePaths.push(
        await downloadTelegramFile(
          ctx,
          item.fileId,
          omniRefExtension(item.kind),
        ),
      );
    }
  } catch (err) {
    console.error("[bot] Tải file Telegram thất bại:", err);
    await ctx.reply("Không tải được file từ Telegram, đã huỷ.", promptMenu);
    for (const p of omniReferencePaths) await fs.unlink(p).catch(() => {});
    return;
  }

  await submitVideoJob({
    ctx,
    groupChatId: ctx.chat.id,
    promptMessageId,
    userId: ctx.from.id,
    rawText,
    omniReferencePaths,
  });
}

export function registerHandlers(bot: Telegraf): void {
  // bot.use(checkAdmin);

  bot.command(["start", "menu"], async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    await ctx.reply("Menu:", promptMenu);
  });

  bot.hears(PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "video");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm 1 ảnh làm start frame trước (nếu gửi nhiều ảnh, ảnh gửi gần nhất sẽ được dùng), ` +
        `rồi gõ prompt ở tin nhắn tiếp theo.`,
    );
  });

  bot.hears(IMAGE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "image");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi prompt tạo ảnh (chỉ cần gõ text), ` +
        `hoặc gửi kèm tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.hears(VIDEO_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "videoRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_VIDEO_REF_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.hears(CHARACTER_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "characterRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 ảnh nhân vật (bắt buộc — nếu gửi nhiều ảnh, ảnh gửi gần nhất sẽ được dùng), ` +
        `rồi gõ prompt ở tin nhắn tiếp theo.`,
    );
  });

  bot.hears(OMNI_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "omniRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_OMNI_REFERENCE_ITEMS} file tham chiếu (ảnh/video/audio, gửi trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.hears(CHATAI_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "chatAI");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi file .txt kịch bản kèm prompt`,
    );
  });

  bot.hears(CHATAI_CHECK_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "chatAICheck");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, Gửi file .txt kịch bản kèm prompt`,
    );
  });

  bot.hears(STOP_ALL_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    stopAll(ctx.from.id);
    await ctx.reply(`🛑 Đã dừng job của bạn`);
  });

  bot.hears(CONTINUE_VIDEO_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "continueVideo");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn tiếp tục tạo video.`,
    );
  });

  bot.hears(CONTINUE_SCENE_FRAME_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "continueSceneFrame");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn tiếp tục gen scene frame.`,
    );
  });

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();
    if (
      ctx.message.text.startsWith("/") ||
      ctx.message.text === PROMPT_BUTTON_LABEL ||
      ctx.message.text === IMAGE_BUTTON_LABEL ||
      ctx.message.text === VIDEO_REF_BUTTON_LABEL ||
      ctx.message.text === CHARACTER_REF_BUTTON_LABEL ||
      ctx.message.text === OMNI_REF_BUTTON_LABEL ||
      ctx.message.text === CHATAI_BUTTON_LABEL ||
      ctx.message.text === CHATAI_CHECK_BUTTON_LABEL ||
      ctx.message.text === CONTINUE_VIDEO_BUTTON_LABEL ||
      ctx.message.text === CONTINUE_SCENE_FRAME_BUTTON_LABEL
    ) {
      return next();
    }

    const userId = ctx.from.id;

    // Gõ tay "<tên file json>__<id>" để yêu cầu tạo lại 1 entry cụ thể — kiểm
    // tra TRƯỚC mọi luồng theo waitingMode khác, vì đây là lệnh độc lập,
    // không cần bấm nút nào trước. Không khớp định dạng/không tìm thấy file
    // hay entry khớp thì tự bỏ qua (rơi xuống xử lý bình thường bên dưới).
    if (
      await tryRegenerateStoryboardItem(
        ctx,
        ctx.message.text,
        ctx.message.message_id,
      )
    ) {
      return;
    }

    // Có ảnh tham chiếu đang chờ (chưa có caption) — dùng tin nhắn text này
    // làm prompt cho batch ảnh đó, ưu tiên hơn "mode" thông thường.
    const photoBuffer = pendingPhotoBuffers.get(userId);
    if (photoBuffer) {
      clearTimeout(photoBuffer.timer);
      pendingPhotoBuffers.delete(userId);
      waitingMode.delete(userId);
      await handlePhotoBuffer(photoBuffer, ctx.message.text);
      return;
    }

    const omniRefBuffer = pendingOmniRefBuffers.get(userId);
    if (omniRefBuffer) {
      clearTimeout(omniRefBuffer.timer);
      pendingOmniRefBuffers.delete(userId);
      waitingMode.delete(userId);
      await handleOmniRefBuffer(omniRefBuffer, ctx.message.text);
      return;
    }

    const mode = waitingMode.get(userId);
    if (!mode) return next();

    waitingMode.delete(userId);

    if (mode === "characterRef") {
      // Bắt buộc phải có ảnh nhân vật — khác "video"/"videoRef" (ảnh tuỳ
      // chọn), gõ text không kèm ảnh nào thì từ chối luôn.
      await ctx.reply(
        "Chế độ Video - Character Reference bắt buộc phải gửi kèm 1 ảnh nhân vật trước khi gõ prompt.",
        promptMenu,
      );
    } else if (mode === "video" || mode === "videoRef" || mode === "omniRef") {
      // "videoRef"/"omniRef" không gửi file nào, chỉ gõ text — hoạt động y hệt "Prompt" thường.
      await submitVideoJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        userId,
        rawText: ctx.message.text,
      });
    } else if (mode === "chatAI" || mode === "chatAICheck") {
      await submitChatAIJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        userId,
        rawText: ctx.message.text,
      });
    } else if (mode === "continueVideo" || mode === "continueSceneFrame") {
      // Cùng quy ước gộp khoảng trắng → "_" với các luồng upload file khác
      // (xem originalFileName/tryHandleReferenceJsonUpload) — user gõ tay tên
      // file dễ lẫn khoảng trắng so với tên thư mục thật (đã normalize sẵn).
      const jsonFileName = ctx.message.text.trim().replace(/ +/g, "_");
      const isVideo = mode === "continueVideo";
      // Job video lỗi có thể thuộc AIVideo (storyboardVideo) HOẶC Pollo
      // (storyboardVideoPollo, mảng failedStoryboardJobsPollo RIÊNG, xem
      // continueFailedStoryboardVideoPollo trong queue.ts) — user gõ tên file,
      // không biết/không cần biết job lỗi thuộc provider nào, nên thử AIVideo
      // trước rồi mới thử Pollo. Nhánh "gen scene frame" KHÔNG có bản Pollo
      // tương ứng (pipeline Pollo bỏ hẳn bước scene, xem storyboardPipeline.ts)
      // nên giữ nguyên chỉ AIVideo.
      const ok = isVideo
        ? continueFailedStoryboardVideo(jsonFileName) ||
          continueFailedStoryboardVideoPollo(jsonFileName)
        : continueFailedStoryboardImages(jsonFileName);
      const actionLabel = isVideo ? "tạo video" : "gen scene frame";
      if (ok) {
        await ctx.reply(
          `✅ Đã đưa "${jsonFileName}" vào hàng đợi ${actionLabel}, đợi xử lý.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply(
          `❌ File "${jsonFileName}" chưa được xử lý (chưa có trong generated/ hoặc không có job nào lỗi khớp tên). Không thể tiếp tục.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
    } else {
      await submitImageJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        userId,
        rawText: ctx.message.text,
        referenceImagePaths: [],
      });
    }
  });

  // Ảnh cho chế độ tạo ảnh (tham chiếu), chế độ tạo video (start frame, chỉ
  // ảnh gần nhất được dùng), chế độ "Video - Image Reference" (ảnh tham
  // chiếu cho video, tối đa MAX_VIDEO_REF_IMAGES), hoặc chế độ "Video -
  // Character Reference" (bắt buộc đúng 1 ảnh nhân vật, chỉ ảnh gần nhất
  // được dùng) — chỉ nhận khi đang ở mode tương ứng hoặc đã có buffer đang
  // chờ (giữ nguyên mode đã chọn từ ảnh đầu tiên). Số ảnh tối đa gom được
  // tuỳ theo mode, xem maxPhotosForMode().
  bot.on(message("photo"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    // Ảnh gửi kiểu "photo" bị Telegram nén nên PhotoSize KHÔNG có file_name —
    // chỉ còn dựa vào caption (nếu user gõ đúng format) để nhận ra yêu cầu
    // thay thế file, xem tryReplaceGeneratedFile.
    if (
      await tryReplaceGeneratedFile(
        ctx,
        ctx.message.photo[ctx.message.photo.length - 1].file_id,
        undefined,
        ctx.message.caption,
        ctx.message.message_id,
      )
    ) {
      return;
    }

    const userId = ctx.from.id;

    // "omniRef" chấp nhận ảnh/video/audio làm file tham chiếu — buffer riêng
    // (pendingOmniRefBuffers) vì cần biết loại file, khác pendingPhotoBuffers.
    if (
      pendingOmniRefBuffers.has(userId) ||
      waitingMode.get(userId) === "omniRef"
    ) {
      waitingMode.delete(userId);
      addOmniRefItem(
        userId,
        ctx,
        "photo",
        ctx.message.photo[ctx.message.photo.length - 1].file_id,
        ctx.message.caption,
        ctx.message.message_id,
      );
      return;
    }

    const existing = pendingPhotoBuffers.get(userId);
    const mode = existing?.mode ?? waitingMode.get(userId);
    if (
      mode !== "image" &&
      mode !== "video" &&
      mode !== "videoRef" &&
      mode !== "characterRef"
    )
      return next();

    waitingMode.delete(userId);

    if (existing) {
      if (existing.photoArrays.length < maxPhotosForMode(existing.mode)) {
        existing.photoArrays.push(ctx.message.photo);
      }
      if (ctx.message.caption) existing.caption = ctx.message.caption;
      scheduleFinalize(userId);
    } else {
      pendingPhotoBuffers.set(userId, {
        ctx,
        mode,
        photoArrays: [ctx.message.photo],
        caption: ctx.message.caption,
        promptMessageId: ctx.message.message_id,
        timer: setTimeout(
          () => finalizeIfHasCaption(userId),
          PHOTO_BUFFER_DEBOUNCE_MS,
        ),
      });
    }
  });

  // Video làm file tham chiếu cho "Video - Omni Reference" — chỉ nhận khi
  // đang ở mode "omniRef" hoặc đã có buffer omniRef đang chờ.
  bot.on(message("video"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    // if (
    //   await tryReplaceGeneratedFile(
    //     ctx,
    //     ctx.message.video.file_id,
    //     ctx.message.video.file_name,
    //     ctx.message.caption,
    //     ctx.message.message_id,
    //   )
    // ) {
    //   return;
    // }

    const userId = ctx.from.id;
    if (
      !pendingOmniRefBuffers.has(userId) &&
      waitingMode.get(userId) !== "omniRef"
    ) {
      return next();
    }

    waitingMode.delete(userId);
    addOmniRefItem(
      userId,
      ctx,
      "video",
      ctx.message.video.file_id,
      ctx.message.caption,
      ctx.message.message_id,
    );
  });

  // Audio làm file tham chiếu cho "Video - Omni Reference" — chỉ nhận khi
  // đang ở mode "omniRef" hoặc đã có buffer omniRef đang chờ.
  bot.on(message("audio"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    const userId = ctx.from.id;
    if (
      !pendingOmniRefBuffers.has(userId) &&
      waitingMode.get(userId) !== "omniRef"
    ) {
      return next();
    }

    waitingMode.delete(userId);
    addOmniRefItem(
      userId,
      ctx,
      "audio",
      ctx.message.audio.file_id,
      ctx.message.caption,
      ctx.message.message_id,
    );
  });

  // File gửi qua nút đính kèm (📎, KHÔNG qua trình quay/chọn video-audio nén
  // sẵn của Telegram) được Telegram gửi dưới dạng "document" — thực tế xác
  // nhận: video gửi kiểu này KHÔNG khớp message("video") ở trên, rơi mất
  // âm thầm nếu không xử lý riêng. Suy ra loại file (ảnh/video/audio) từ
  // mime_type; bỏ qua (báo lại cho user) nếu không phải 1 trong 3 loại này.
  bot.on(message("document"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    if (
      await tryReplaceGeneratedFile(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_name,
        ctx.message.caption,
        ctx.message.message_id,
      )
    ) {
      return;
    }

    // File .json upload — coi là kịch bản storyboard cho generated/,
    // ưu tiên xử lý TRƯỚC luồng upload prompt file (.txt/.md) bên dưới, cùng
    // cơ chế "hoạt động độc lập" với tryReplaceGeneratedFile ở trên.
    if (
      await tryHandleReferenceJsonUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_name,
        ctx.message.message_id,
      )
    ) {
      return;
    }

    const userId = ctx.from.id;

    // Chế độ "ChatAI"/"Check prompt kịch bản": user gửi yêu cầu qua file (.txt/.md)
    // thay vì gõ trực tiếp (dùng khi prompt quá dài) — tải file về đĩa rồi
    // UPLOAD thẳng lên ChatAI (xem askChatAI), prompt chỉ là 1 câu ngắn
    // yêu cầu ChatAI đọc file (CHATAI_FILE_ATTACHMENT_PROMPT), không dán nguyên nội
    // dung file làm prompt text nữa.
    const chatAIMode = waitingMode.get(userId);
    if (chatAIMode === "chatAI" || chatAIMode === "chatAICheck") {
      waitingMode.delete(userId);
      // Gộp nhiều khoảng trắng liên tiếp thành 1, rồi thay bằng "_" — tên file
      // Telegram user gửi lên có thể chứa khoảng trắng (kể cả 2+ liên tiếp),
      // gây rối khi tên này sau đó dùng làm promptFileName/đặt tên file kết
      // quả gửi lại (xem submitChatAIJob).
      const originalFileName = (
        ctx.message.document.file_name ?? "prompt.txt"
      ).replace(/ +/g, "_");
      const ext = path.extname(originalFileName) || ".txt";
      let promptFilePath: string;
      try {
        promptFilePath = await downloadTelegramFile(
          ctx,
          ctx.message.document.file_id,
          ext,
        );
        // Nối thêm nội dung format hướng dẫn xử lý (config.formatOuput) vào
        // cuối file TRƯỚC KHI upload lên ChatAI, theo yêu cầu người dùng —
        // đọc lỗi/file không tồn tại thì bỏ qua bước này (không chặn cả job
        // ChatAI chỉ vì thiếu file phụ trợ này).
        const promptFileContent = await fs.readFile(promptFilePath, "utf-8");
        const formatOutputContent = await fs
          .readFile(config.formatOuput, "utf-8")
          .catch((err) => {
            console.error(
              `[bot] Không đọc được file format output (${config.formatOuput}), bỏ qua:`,
              err,
            );
            return "";
          });
        if (formatOutputContent) {
          // Dùng SCRIPT_SECTION_MARKER (regex, xem chatAI.ts) thay vì so
          // khớp chuỗi cố định — chấp nhận biến thể khoảng trắng/hoa thường
          // sau "#" (vd "#ĐÂY LÀ KỊCH BẢN", "# Đây là kịch bản") thay vì chỉ
          // khớp đúng y hệt "# ĐÂY LÀ KỊCH BẢN". Escape "$" trong
          // formatOutputContent trước khi đưa vào chuỗi thay thế — String.replace
          // với regex coi "$&"/"$1"/"$$"... trong chuỗi thay thế là cú pháp đặc
          // biệt, "$$" mới ra đúng 1 ký tự "$" — nếu formatOutputContent tình cờ
          // chứa "$" (vd giá tiền) sẽ bị thay sai mà không báo lỗi.
          const escapedFormatOutput = formatOutputContent.replace(
            /\$/g,
            "$$$$",
          );
          await fs.writeFile(
            promptFilePath,
            promptFileContent.replace(
              SCRIPT_SECTION_MARKER,
              `${escapedFormatOutput}\n# ĐÂY LÀ KỊCH BẢN`,
            ),
            "utf-8",
          );
        }
      } catch (err) {
        console.error("[bot] Tải file prompt ChatAI thất bại:", err);
        await ctx.reply(
          "Không tải được file prompt từ Telegram, đã huỷ.",
          promptMenu,
        );
        return;
      }
      await submitChatAIJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        userId,
        rawText: CHATAI_FILE_ATTACHMENT_PROMPT,
        promptFileName: originalFileName,
        promptAttachmentPath: promptFilePath,
      });
      return;
    }

    if (
      !pendingOmniRefBuffers.has(userId) &&
      waitingMode.get(userId) !== "omniRef"
    ) {
      return next();
    }

    const mimeType = ctx.message.document.mime_type ?? "";
    const kind: OmniRefKind | null = mimeType.startsWith("image/")
      ? "photo"
      : mimeType.startsWith("video/")
        ? "video"
        : mimeType.startsWith("audio/")
          ? "audio"
          : null;

    if (!kind) {
      await ctx.reply(
        "File này không phải ảnh/video/audio nên bot đã bỏ qua. Gửi đúng loại file tham chiếu hoặc gõ prompt để tiếp tục.",
      );
      return;
    }

    waitingMode.delete(userId);
    addOmniRefItem(
      userId,
      ctx,
      kind,
      ctx.message.document.file_id,
      ctx.message.caption,
      ctx.message.message_id,
    );
  });

  // Nút "Tạo ảnh" trong tin nhắn xác nhận sau khi ChatAI trả JSON storyboard
  // (xem runStoryboardPipeline/createImageConfirmation trong queue.ts) —
  // callback_data dạng "confirmImages:<id>", tra lại jsonPath tương ứng rồi
  // đẩy job tạo ảnh CHARACTER/LOCATION vào hàng đợi AIVideo.
  bot.action(/^confirmImages:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmImageGeneration(confirmId);
    if (!ok) {
      await ctx.answerCbQuery("Lượt xác nhận này đã hết hạn hoặc đã dùng.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery("Đã thêm vào hàng đợi tạo ảnh.");
    await ctx
      .editMessageText("✅ Đã xác nhận — đang chờ tạo ảnh.")
      .catch(() => {});
  });

  // GIỐNG confirmImages HỆT nhưng đẩy job dùng pollo.ai (xem
  // confirmImageGenerationPollo/StoryboardImagesPolloJob trong queue.ts) —
  // nút song song "Tạo ảnh" gửi cùng lúc với "Tạo ảnh (AIVideo)".
  bot.action(/^confirmImagesPollo:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmImageGenerationPollo(confirmId);
    if (!ok) {
      await ctx.answerCbQuery("Lượt xác nhận này đã hết hạn hoặc đã dùng.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery("Đã thêm vào hàng đợi tạo ảnh.");
    await ctx
      .editMessageText("✅ Đã xác nhận — đang chờ tạo ảnh.")
      .catch(() => {});
  });

  // Nút "Tạo ảnh scene" trong tin nhắn xác nhận sau khi ảnh CHARACTER/LOCATION
  // đã tạo xong (xem notifyStoryboardImagesAIVideoResult/createSceneConfirmation
  // trong queue.ts) — callback_data dạng "confirmScene:<id>", tra lại
  // jsonPath tương ứng rồi đẩy job tạo ảnh SCENE_SETTING vào hàng đợi AIVideo.
  bot.action(/^confirmScene:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmSceneGeneration(confirmId);
    if (!ok) {
      await ctx.answerCbQuery("Lượt xác nhận này đã hết hạn hoặc đã dùng.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery("Đã thêm vào hàng đợi tạo ảnh scene.");
    await ctx
      .editMessageText("✅ Đã xác nhận — đang chờ tạo ảnh scene.")
      .catch(() => {});
  });

  // Nút "Tạo video" trong tin nhắn xác nhận sau khi ảnh SCENE_SETTING đã tạo
  // xong (xem notifyStoryboardImagesAIVideoResult/createVideoConfirmation
  // trong queue.ts) — callback_data dạng "confirmVideo:<id>", tra lại
  // jsonPath tương ứng rồi đẩy job tạo video vào hàng đợi AIVideo.
  bot.action(/^confirmVideo:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmVideoGeneration(confirmId);
    if (!ok) {
      await ctx.answerCbQuery("Lượt xác nhận này đã hết hạn hoặc đã dùng.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery("Đã thêm vào hàng đợi tạo video.");
    await ctx
      .editMessageText("✅ Đã xác nhận — đang chờ tạo video.")
      .catch(() => {});
  });

  // GIỐNG confirmVideo HỆT nhưng đẩy job dùng pollo.ai (xem
  // confirmVideoGenerationPollo/StoryboardVideoPolloJob trong queue.ts) — nút
  // "Tạo video (Pollo)" được gửi NGAY sau khi ảnh CHARACTER/LOCATION xong
  // (processPolloImageQueue) — pipeline Pollo BỎ HẲN bước "Tạo ảnh scene",
  // khác với AIVideo (video thường tạo qua auto-push per-clip sau bước scene).
  bot.action(/^confirmVideoPollo:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmVideoGenerationPollo(confirmId);
    if (!ok) {
      await ctx.answerCbQuery("Lượt xác nhận này đã hết hạn hoặc đã dùng.", {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery("Đã thêm vào hàng đợi tạo video.");
    await ctx
      .editMessageText("✅ Đã xác nhận — đang chờ tạo video.")
      .catch(() => {});
  });
}

