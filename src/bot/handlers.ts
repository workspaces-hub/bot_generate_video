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
import { downloadTelegramMediaViaMTProto } from "../automation/telegramMTProto";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
import {
  buildVideoTimeline,
  findVideoEntriesInTimeRange,
  generatedDirFor,
  generatedImageDirFor,
  resolveNextRemakeVersion,
  sanitizeId,
  type StoryboardEntry,
} from "../automation/storyboardPipeline";
import { config } from "../config";
import {
  confirmImageGeneration,
  confirmImageGenerationPollo,
  confirmSceneGeneration,
  confirmSceneGenerationPollo,
  confirmVideoGeneration,
  confirmVideoGenerationComfy,
  confirmVideoGenerationPollo,
  enqueueComfyRegenerateWithMerge,
  enqueueJob,
  isStoryboardJobQueued,
  createReferenceVideoBatch,
  mergeVideosAndPublish,
  recordReferenceVideoBatchResult,
  stopAll,
} from "../queue";
import {
  CHARACTER_REF_BUTTON_LABEL,
  CHATAI_BUTTON_LABEL,
  CHATAI_CHECK_BUTTON_LABEL,
  CONTINUE_IMAGE_BUTTON_LABEL,
  CONTINUE_SCENE_FRAME_BUTTON_LABEL,
  CONTINUE_VIDEO_BUTTON_LABEL,
  GENERATE_SCRIPT_BUTTON_LABEL,
  GENERATE_SCRIPT_EPISODE_BUTTON_LABEL,
  IMAGE_BUTTON_LABEL,
  MERGE_VIDEO_BUTTON_LABEL,
  OMNI_REF_BUTTON_LABEL,
  PROMPT_BUTTON_LABEL,
  REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL,
  SCRIPT_REFERENCE_BUTTON_LABEL,
  STOP_ALL_BUTTON_LABEL,
  TEST_VIDEO_REFERENCE_BUTTON_LABEL,
  UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL,
  UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL,
  UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL,
  VIDEO_REF_BUTTON_LABEL,
  VIDEO_REFERENCE_BUTTON_LABEL,
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
  | "scriptReference"
  | "videoReference"
  | "videoReferenceTest"
  | "generateScript"
  | "generateScriptEpisode"
  | "continueVideo"
  | "continueSceneFrame"
  | "continueImage"
  | "mergeVideo"
  | "regenerateVideoByTime"
  | "updateGenerateScriptPrompt"
  | "updateVideoReferencePrompt"
  | "updateTestVideoReferencePrompt";
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

// Theo yêu cầu người dùng: "Tham chiếu video" cho phép gửi NHIỀU video — gom
// mọi video user gửi sau khi bấm nút (mỗi video Telegram là 1 tin nhắn riêng,
// kể cả album), CHỈ bắt đầu phân tích khi user gõ "xong"/"done" (xem
// REFERENCE_VIDEO_DONE_PATTERN trong bot.on(message("text"))) — KHÔNG chốt lô
// theo thời gian ngắn nữa: video dài upload lâu, gửi rời cách nhau vài chục
// giây sẽ bị tách lô/bỏ sót. Không tự chốt lô theo thời gian; chưa gõ "xong"
// mà bấm chức năng khác thì huỷ lô (clearPendingUploads).
const REFERENCE_VIDEO_DONE_PATTERN = /^\s*(xong|done)\s*[.!]*\s*$/i;
/** Gom tin "đã nhận N video" — album nhiều video chỉ báo 1 lần. */
const REFERENCE_VIDEO_ACK_DEBOUNCE_MS = 2000;
interface PendingReferenceVideo {
  fileId: string;
  videoFileName: string;
  caption?: string;
  messageId: number;
}
interface PendingReferenceVideoBuffer {
  ctx: Context;
  chatId: number;
  items: PendingReferenceVideo[];
  /** Hẹn giờ gửi tin "đã nhận N video". */
  ackTimer?: ReturnType<typeof setTimeout>;
}
const pendingReferenceVideoBuffers = new Map<number, PendingReferenceVideoBuffer>();

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

  // Theo yêu cầu người dùng: đã gửi video "Tham chiếu video" nhưng chưa gõ
  // "xong" mà bấm chức năng khác → huỷ lô, báo cho user biết.
  const referenceVideoBuffer = pendingReferenceVideoBuffers.get(userId);
  if (referenceVideoBuffer) {
    clearTimeout(referenceVideoBuffer.ackTimer);
    pendingReferenceVideoBuffers.delete(userId);
    if (waitingMode.get(userId) === "videoReference") waitingMode.delete(userId);
    void referenceVideoBuffer.ctx.telegram
      .sendMessage(
        referenceVideoBuffer.chatId,
        `❌ Đã huỷ tham chiếu ${referenceVideoBuffer.items.length} video (chưa gõ "xong"/"done").`,
      )
      .catch(() => {});
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

/**
 * Telegram Bot API (api.telegram.org) CHỈ cho bot TẢI file <= 20MB qua
 * getFile/getFileLink — giới hạn CỐ ĐỊNH của chính Bot API (khác hẳn giới
 * hạn UPLOAD, có thể tới 2GB), không phải lỗi mạng tạm thời nên retry vô
 * ích. Dùng để nhận diện lỗi này rồi fallback sang MTProto (xem
 * downloadTelegramVideoRobust) thay vì báo lỗi chung chung.
 */
function isTelegramFileTooBigError(err: unknown): boolean {
  return err instanceof Error && /file is too big/i.test(err.message);
}

const TELEGRAM_FILE_TOO_BIG_REPLY =
  "❌ File vượt quá 20MB — giới hạn CỐ ĐỊNH của Telegram Bot API khi bot tải file (khác giới hạn upload, không do bot lỗi). Nén/cắt nhỏ file xuống dưới 20MB rồi gửi lại.";

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
 * Dùng cho video "Tham chiếu kịch bản" (SCRIPT_REFERENCE_BUTTON_LABEL) —
 * video này thường vượt 20MB (giới hạn getFile của Bot API, xem
 * isTelegramFileTooBigError), khác các luồng ảnh/omniRef khác thường nhỏ.
 * Thử downloadTelegramFile (Bot API) TRƯỚC — nhanh/đơn giản, đủ dùng cho
 * file <20MB; CHỈ khi dính đúng lỗi "file is too big" mới fallback sang
 * MTProto (downloadTelegramMediaViaMTProto, xem telegramMTProto.ts) — tải
 * trực tiếp qua giao thức gốc, không bị chặn ở mốc 20MB.
 */
async function downloadTelegramVideoRobust(
  ctx: Context,
  fileId: string,
  chatId: number,
  messageId: number,
  ext: string,
): Promise<string> {
  try {
    return await downloadTelegramFile(ctx, fileId, ext);
  } catch (err) {
    if (!isTelegramFileTooBigError(err)) throw err;
    console.warn(
      `[bot] Video vượt 20MB (Bot API) — fallback tải qua MTProto (chat ${chatId}, message ${messageId}).`,
    );
    await fs.mkdir(config.uploadsDir, { recursive: true });
    const filePath = path.join(config.uploadsDir, `${randomUUID()}${ext}`);
    await downloadTelegramMediaViaMTProto(chatId, messageId, filePath);
    return filePath;
  }
}

/**
 * Dùng chung cho cả 4 nơi nhận video "Tham chiếu kịch bản"/"Tham chiếu
 * video" (qua message("video") lẫn message("document")) — tải video rồi
 * enqueue job "scriptReferenceVideo" (xem submitScriptReferenceVideoJob).
 *
 * QUAN TRỌNG: tải video KHÔNG await trong handler nữa — chạy ở NỀN (IIFE
 * "void (async () => {...})()"). Xác nhận qua lỗi thật (2026-09-29):
 * "TimeoutError: Promise timed out after 90000 milliseconds" — handlerTimeout
 * của Telegraf (đã nới lên 10 phút ở index.ts, xem đó) là 1 giá trị CỐ ĐỊNH,
 * trong khi video "Tham chiếu kịch bản" có thể dài tới hàng chục phút/1
 * tiếng — không có con số cố định nào chắc chắn đủ cho MỌI video, kể cả 10
 * phút. Tải ở nền loại bỏ hẳn việc phải đoán 1 con số timeout "đủ lớn": thời
 * gian tải KHÔNG còn tính vào handlerTimeout nữa (handler trả lời NGAY rồi
 * kết thúc), chỉ còn bị giới hạn bởi timeout nội bộ của chính MTProto/retry
 * (xem telegramMTProto.ts), vốn nên là nơi kiểm soát việc này thay vì
 * Telegraf. Trả lời ngay 1 tin nhắn trạng thái "Đang tải" để user biết đã
 * nhận — xoá đi khi xong (thành công thì submitScriptReferenceVideoJob tự
 * gửi trạng thái "Đang xử lý" riêng, thất bại thì báo lỗi thay vào đó).
 */
async function handleScriptReferenceVideoUpload(
  ctx: Context,
  fileId: string,
  chatId: number,
  messageId: number,
  videoFileName: string,
  extraInstruction: string | undefined,
  options?: {
    masterPromptPath?: string;
    skipImageConfirmation?: boolean;
    verifyPromptTest?: boolean;
  },
): Promise<void> {
  const userId = ctx.from!.id;
  const ext = path.extname(videoFileName) || ".mp4";

  const downloadingMessage = await ctx.reply("⏳ Đang tải video từ Telegram...", {
    reply_parameters: { message_id: messageId },
    ...promptMenu,
  });

  void (async () => {
    let videoPath: string;
    try {
      videoPath = await downloadTelegramVideoRobust(
        ctx,
        fileId,
        chatId,
        messageId,
        ext,
      );
    } catch (err) {
      console.error("[bot] Tải video Telegram thất bại:", err);
      await ctx.telegram
        .deleteMessage(chatId, downloadingMessage.message_id)
        .catch(() => {});
      await ctx.reply(
        isTelegramFileTooBigError(err)
          ? TELEGRAM_FILE_TOO_BIG_REPLY
          : `Không tải được video từ Telegram, đã huỷ.${err instanceof Error ? ` (${err.message})` : ""}`,
        promptMenu,
      );
      return;
    }

    await ctx.telegram
      .deleteMessage(chatId, downloadingMessage.message_id)
      .catch(() => {});
    await submitScriptReferenceVideoJob({
      ctx,
      groupChatId: chatId,
      promptMessageId: messageId,
      userId,
      videoPath,
      videoFileName,
      extraInstruction,
      masterPromptPath: options?.masterPromptPath,
      skipImageConfirmation: options?.skipImageConfirmation,
      verifyPromptTest: options?.verifyPromptTest,
    });
  })().catch((err) => {
    console.error(
      "[bot] Lỗi không mong đợi khi tải/enqueue video tham chiếu (nền):",
      err,
    );
  });
}

/**
 * Prompt cố định gửi kèm khi user đưa yêu cầu qua file (.txt/.md) thay vì gõ
 * trực tiếp — file được UPLOAD thẳng lên ChatAI (xem askChatAI,
 * downloadTelegramFile + submitChatAIJob), ChatAI tự đọc nội dung file, không cần
 * dán nguyên văn bản file làm prompt text nữa (tránh dán prompt siêu dài).
 */
/**
 * Thêm 1 video vào lô "Tham chiếu video" đang gom của user, báo "đã nhận N
 * video" (gom theo REFERENCE_VIDEO_ACK_DEBOUNCE_MS).
 */
function addReferenceVideo(
  ctx: Context,
  userId: number,
  chatId: number,
  item: PendingReferenceVideo,
): void {
  const existing = pendingReferenceVideoBuffers.get(userId);
  if (existing) clearTimeout(existing.ackTimer);
  const buffer: PendingReferenceVideoBuffer = existing ?? {
    ctx,
    chatId,
    items: [],
  };
  buffer.items.push(item);

  buffer.ackTimer = setTimeout(() => {
    void ctx.telegram
      .sendMessage(
        chatId,
        `📥 Đã nhận ${buffer.items.length} video. Gửi thêm video, hoặc gõ "xong"/"done" để bắt đầu phân tích.`,
        { reply_parameters: { message_id: item.messageId } },
      )
      .catch(() => {});
  }, REFERENCE_VIDEO_ACK_DEBOUNCE_MS);
  pendingReferenceVideoBuffers.set(userId, buffer);
}

/**
 * Chốt lô "Tham chiếu video": 1 video → giữ nguyên luồng cũ
 * (handleScriptReferenceVideoUpload, gửi JSON ngay khi xong). Nhiều video →
 * tạo 1 lô (createReferenceVideoBatch), tải TUẦN TỰ từng video rồi đẩy mỗi
 * video 1 job "scriptReferenceVideo" mang batchId — phân tích lần lượt, JSON
 * gom lại gửi 1 lượt kèm thống kê khi cả lô xong
 * (recordReferenceVideoBatchResult, queue.ts). Video không có caption dùng
 * caption đầu tiên trong lô (album Telegram chỉ gắn caption vào video đầu).
 */
async function flushReferenceVideoBuffer(userId: number): Promise<void> {
  const buffer = pendingReferenceVideoBuffers.get(userId);
  if (!buffer) return;
  clearTimeout(buffer.ackTimer);
  pendingReferenceVideoBuffers.delete(userId);
  if (waitingMode.get(userId) === "videoReference") waitingMode.delete(userId);

  const { ctx, chatId, items } = buffer;
  const sharedCaption = items.find((i) => i.caption)?.caption;
  const options = {
    masterPromptPath: config.promptVideoReference,
    skipImageConfirmation: true,
  };

  if (items.length === 1) {
    const [item] = items;
    await handleScriptReferenceVideoUpload(
      ctx,
      item.fileId,
      chatId,
      item.messageId,
      item.videoFileName,
      item.caption,
      options,
    );
    return;
  }

  const firstMessageId = items[0].messageId;
  const statusMessage = await ctx.telegram.sendMessage(
    chatId,
    `⏳ Đã nhận ${items.length} video — đang tải từ Telegram rồi phân tích lần lượt, xong hết sẽ gửi kết quả cùng lúc.`,
    { reply_parameters: { message_id: firstMessageId } },
  );
  const batchId = createReferenceVideoBatch(
    chatId,
    firstMessageId,
    items.map((i) => i.videoFileName),
    statusMessage.message_id,
  );

  for (const [index, item] of items.entries()) {
    const ext = path.extname(item.videoFileName) || ".mp4";
    let videoPath: string;
    try {
      videoPath = await downloadTelegramVideoRobust(
        ctx,
        item.fileId,
        chatId,
        item.messageId,
        ext,
      );
    } catch (err) {
      console.error(`[bot] Tải video "${item.videoFileName}" (lô) thất bại:`, err);
      await recordReferenceVideoBatchResult(batchId, index, {
        error: isTelegramFileTooBigError(err)
          ? "video quá lớn, không tải được từ Telegram"
          : `không tải được video từ Telegram${err instanceof Error ? ` (${err.message})` : ""}`,
      });
      continue;
    }
    enqueueJob({
      type: "scriptReferenceVideo",
      chatId,
      userId,
      prompt: "",
      promptMessageId: item.messageId,
      videoPath,
      videoFileName: item.videoFileName,
      extraInstruction: item.caption ?? sharedCaption,
      ...options,
      batchId,
      batchIndex: index,
    });
  }
}

const CHATAI_FILE_ATTACHMENT_PROMPT = "Hãy thực hiện yêu cầu trong file sau";

/** Cùng vai trò với CHATAI_FILE_ATTACHMENT_PROMPT nhưng dùng cho nút "Tạo kịch bản mới" (GENERATE_SCRIPT_BUTTON_LABEL) — file đính kèm lúc này gồm CẢ master prompt (prompt_generate_script.txt) LẪN nội dung (các) file JSON tham chiếu, xem handleGenerateScriptRequest. */
const GENERATE_SCRIPT_ATTACHMENT_PROMPT =
  "Hãy đọc kỹ và thực hiện đúng yêu cầu trong file đính kèm sau (bao gồm cả các file JSON tham chiếu được ghép kèm theo trong đó)";

/**
 * Tên file dạng "<tên file json>__<tên file ảnh/video>.<đuôi>" — ĐÚNG format
 * bot tự đặt tên khi gửi kết quả cho user (xem queue.ts, dấu "__" phân tách
 * tên file json và tên file ảnh/video). Tách theo dấu "__" ĐẦU TIÊN —
 * jsonBaseName lấy từ sanitizeId (storyboardPipeline.ts) chỉ có gạch dưới
 * ĐƠN, không có "__", nên phần còn lại sau "__" đầu tiên chắc chắn là tên
 * file gốc (kèm đuôi). Dùng cho fileName (tên file THẬT — luôn có đuôi).
 */
// SỬA (xác nhận qua lỗi thật: caption
// "2.0-tập_2-_nghĩa_trang_only_test_-___CHAR_PROP_ADRIAN_LUXURY_SEDAN" — tên
// file gốc "2.0-tập_2-_nghĩa_trang_only_test_-_" (đúng ra phải giữ nguyên
// dấu "_" cuối) TỰ NHIÊN kết thúc bằng "_" ngay sát dấu phân cách "__", tạo
// thành 1 dải 3 dấu "_" liên tiếp ("_" cuối tên file + "__" phân cách). Nhóm
// 1 dùng "(.+?)" (LAZY — khớp ÍT ký tự nhất có thể) nên bắt luôn "__" ĐẦU
// TIÊN tìm thấy trong dải 3 dấu "_" đó — cắt tên file THIẾU mất đúng 1 dấu
// "_" cuối (nhóm 1 ra "...test_-" thay vì "...test_-_"), phần dư 1 dấu "_"
// bị dính NHẦM vào đầu nhóm 2 (id). Đổi "(.+?)" (lazy) thành "(.+)" (GREEDY)
// — greedy bắt "__" CUỐI CÙNG tìm được trong chuỗi (khớp nhiều ký tự nhất có
// thể trước khi phải lùi lại) — đúng ý muốn vì id (CHAR_XXX/LOC_XXX...) theo
// quy ước KHÔNG BAO GIỜ chứa "__" (chỉ có "_" đơn), nên "__" cuối cùng trong
// toàn chuỗi luôn chính là dấu phân cách thật, dù tên file có tận cùng bằng
// bao nhiêu dấu "_" đi nữa.
const REPLACEMENT_FILENAME_PATTERN = /^(.+)__([^/\\]+\.[A-Za-z0-9]+)$/;

/**
 * GIỐNG REPLACEMENT_FILENAME_PATTERN nhưng KHÔNG bắt buộc đuôi file — dùng
 * cho caption user tự gõ tay, không cần nhớ gõ kèm đuôi. Đuôi (nếu user có
 * gõ) vẫn nằm nguyên trong nhóm 2; tryReplaceGeneratedFile tự kiểm tra bằng
 * path.extname() và mặc định ".png" khi nhóm 2 không có đuôi nào.
 */
const REPLACEMENT_CAPTION_PATTERN = /^(.+)__([^/\\]+)$/;

/**
 * Parse 1 mốc thời gian dùng cho REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL — chấp
 * nhận giây ("12", "12.5"), "mm:ss" ("1:05") hoặc "hh:mm:ss" ("1:02:05"), tự
 * nhận diện qua số dấu ":" (0/1/2) thay vì bắt buộc 1 format cố định. Trả về
 * null nếu không khớp bất kỳ format nào (không phải toàn số, sai số nhóm).
 */
function parseTimeRangeMark(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}

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
 * DÙNG CHUNG cho MỌI nút "Cập nhật prompt ..." (UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL,
 * UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL, ...) — CHỈ khác nhau ở
 * targetPath (đường dẫn master prompt cần ghi đè), không phải khác PROVIDER/
 * business logic nên tham số hoá thay vì clone (quy ước clone-theo-provider
 * dành cho khác API/job/hàng đợi, không áp dụng cho thao tác thuần "tải +
 * sao lưu + ghi đè 1 file text" giống nhau tuyệt đối ở đây). THEO YÊU CẦU
 * NGƯỜI DÙNG: KHÔNG giới hạn admin — bất kỳ ai trong nhóm được phép dùng bot
 * (isAllowedGroup, đã check ở bot.hears) đều cập nhật được. Bản CŨ (nếu có)
 * được sao lưu thành "<targetPath không đuôi>_vXX.<đuôi>" (XX tăng dần, xem
 * nextBackupVersion) TRƯỚC khi ghi đè — không mất bản trước nếu cần khôi
 * phục lại.
 */
async function handleUpdateMasterPromptUpload(
  ctx: Context,
  fileId: string,
  fileName: string | undefined,
  promptMessageId: number,
  targetPath: string,
): Promise<void> {
  if (path.extname(fileName ?? "").toLowerCase() !== ".txt") {
    await ctx.reply(
      "Chỉ nhận file .txt cho master prompt. Đã huỷ.",
      promptMenu,
    );
    return;
  }
  try {
    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Tải file từ Telegram thất bại: HTTP ${response.status}`);
    }
    const newContent = await response.text();
    if (!newContent.trim()) {
      await ctx.reply("File rỗng, đã huỷ (không ghi đè).", promptMenu);
      return;
    }

    const parsed = path.parse(targetPath);
    const dir = parsed.dir || ".";

    let backupNote = "";
    const targetExists = await fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (targetExists) {
      const version = await nextBackupVersion(dir, parsed.name, parsed.ext);
      const backupFileName = `${parsed.name}_v${String(version).padStart(2, "0")}${parsed.ext}`;
      await fs.copyFile(targetPath, path.join(dir, backupFileName));
      backupNote = ` (đã sao lưu bản cũ thành "${backupFileName}")`;
    }

    await fs.writeFile(targetPath, newContent, "utf-8");
    await ctx.reply(
      `✅ Đã cập nhật "${targetPath}"`,
      {
        reply_parameters: { message_id: promptMessageId },
        ...promptMenu,
      },
    );
  } catch (err) {
    console.error(`[bot] Cập nhật "${targetPath}" thất bại:`, err);
    await ctx.reply(
      `❌ Cập nhật thất bại: ${err instanceof Error ? err.message : String(err)}`,
      promptMenu,
    );
  }
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
  | "storyboardImagesPollo"
  | "storyboardSceneImagesAIVideo"
  | "storyboardVideoPollo"
  | "storyboardVideoComfy"
  | null {
  if (entryType === "CHARACTER" || entryType === "LOCATION") {
    return "storyboardImagesPollo";
  }
  if (
    entryType === "SCENE_SETTING_START" ||
    entryType === "SCENE_SETTING_END"
  ) {
    return "storyboardSceneImagesAIVideo";
  }
  if (entryType === "VIDEO") {
    // return "storyboardVideoPollo";
    return "storyboardVideoComfy";
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

/**
 * Chuẩn hoá tên file json user gõ tay: trim, gộp khoảng trắng → "_" (cùng
 * quy ước với tên thư mục thật trong generated/, xem originalFileName/
 * tryHandleReferenceJsonUpload), và bỏ đuôi ".json" nếu user lỡ gõ kèm (vd
 * gõ cả "abc.json" thay vì chỉ "abc") — generatedDirFor/đường dẫn file thật
 * đều tự thêm lại ".json" nên gõ kèm đuôi sẽ tạo sai path.
 */
function normalizeTypedJsonFileName(text: string): string {
  return text
    .trim()
    .replace(/ +/g, "_")
    .replace(/\.json$/i, "");
}

/**
 * Chuyển caption tự do (user gõ kèm video) thành 1 slug an toàn để đặt tên
 * file — bỏ ký tự không an toàn cho tên file/thư mục (vd "/" dễ bị hiểu
 * nhầm thành phân cách đường dẫn), gộp khoảng trắng thành "_", giới hạn độ
 * dài (tránh vượt giới hạn tên file của OS nếu caption quá dài). Trả về
 * chuỗi RỖNG nếu sau khi làm sạch không còn ký tự nào hữu ích (vd caption
 * toàn ký tự đặc biệt/emoji) — caller tự fallback sang tên khác.
 */
function sanitizeCaptionForFileName(caption: string): string {
  return caption
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80)
    .replace(/^_+|_+$/g, "");
}

/**
 * Theo yêu cầu người dùng: tên file JSON (kết quả ChatAI trả về, xem
 * downloadAttachedFiles trong chatAI.ts) cho "Tham chiếu kịch bản"/"Tham
 * chiếu video" ưu tiên lấy theo TÊN FILE VIDEO gốc — nhưng Telegram thường
 * KHÔNG kèm "file_name" cho video gửi qua nút camera/thư viện (chỉ có khi
 * gửi qua nút đính kèm 📎 dạng document), khiến tên rơi về fallback generic
 * "video-<messageId>.mp4" không có ý nghĩa gì. Ưu tiên: (1) tên file video
 * thật (nếu Telegram có gửi kèm); (2) nếu không, dùng CAPTION user gõ kèm
 * video (nếu có và làm sạch được, xem sanitizeCaptionForFileName) — thường
 * là tên/mô tả ngắn user tự đặt, ý nghĩa hơn hẳn tên generic; (3) cuối cùng
 * mới rơi về "video-<messageId>.mp4".
 */
function resolveVideoFileName(
  telegramFileName: string | undefined,
  caption: string | undefined,
  messageId: number,
): string {
  const captionSlug = caption ? sanitizeCaptionForFileName(caption) : "";
  const fileName =
    telegramFileName ||
    (captionSlug ? `${captionSlug}.mp4` : "") ||
    `video-${messageId}.mp4`;
  return fileName.replace(/ +/g, "_");
}

async function regenerateStoryboardItemLine(
  ctx: Context,
  line: string,
  promptMessageId: number,
): Promise<string | null> {
  const match = line.match(REPLACEMENT_CAPTION_PATTERN);
  if (!match) return null;

  const fileBaseName = normalizeTypedJsonFileName(match[1]);
  const targetId = match[2].trim();

  // Theo yêu cầu người dùng: file JSON này có thể đang nằm theo 1 trong 2
  // layout storage/generated/ khác nhau (xem docstring
  // resolveExistingGeneratedJsonPath) — dò đúng rule đang thực sự chứa file
  // thay vì luôn giả định layout "storage/generated/<file>/<file>.json".
  const jsonPath = await resolveExistingGeneratedJsonPath(
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
  // tên file luôn "<id>.<đuôi>" trong folder generated tương ứng (xem
  // storyboardPipeline.ts) — không xoá thì file cũ vẫn còn lẫn sau khi
  // generate lại xong. Entry ẢNH (CHARACTER/LOCATION/SCENE_SETTING_START/
  // SCENE_SETTING_END) và entry VIDEO có thể nằm ở 2 folder KHÁC nhau khi
  // nhiều tập dùng CHUNG 1 folder theo tên phim (xem
  // generatedImageDirFor/generatedDirFor trong storyboardPipeline.ts) — phải
  // chọn đúng theo entry.type, không được luôn dùng path.dirname(jsonPath).
  const outputDir =
    entry.type === "VIDEO"
      ? generatedDirFor(jsonPath)
      : generatedImageDirFor(jsonPath);
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
    ...promptMenu
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
  // Dùng lại resolveExistingGeneratedJsonPath (đã có sẵn, dùng cho
  // "continueVideo"/"continueSceneFrame") thay vì generatedDirFor thô —
  // jsonBaseName gõ tay có thể thuộc layout "nhiều tập chung 1 phim"
  // (storage/generated/<tên phim>/<jsonBaseName>/<jsonBaseName>.json), không
  // chỉ layout phẳng (storage/generated/<jsonBaseName>/<jsonBaseName>.json) —
  // xem docstring hàm đó.
  const jsonPath = await resolveExistingGeneratedJsonPath(
    `${jsonBaseName}.json`,
  );
  const dir = path.dirname(jsonPath);
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
    await markStoryboardEntrySuccess(jsonPath, targetId).catch((err) => {
      console.error(
        `[bot] Cập nhật success cho entry "${targetId}" trong "${jsonPath}" thất bại:`,
        err,
      );
      return false;
    });

    await ctx.reply(
      `✅ Đã thay thế "${targetFileName}" trong "${jsonBaseName}".`,
      {  
        reply_parameters: { message_id: promptMessageId },
        ...promptMenu
      },
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
 * Theo yêu cầu người dùng: 1 file JSON storyboard (nhận diện qua tên file,
 * vd "duke_of_shadows_tap1_full.json") có thể đang nằm ở 1 trong 2 layout
 * storage/generated/ khác nhau (xem docstring generatedImageDirFor trong
 * storyboardPipeline.ts) — PHẢI dò ra ĐÚNG layout đang thực sự chứa file đó
 * trước khi thao tác, không được mặc định luôn theo 1 rule cố định:
 * 1. storage/generated/<file>/<file>.json — job "chatAI" (không chia sẻ
 *    phim với tập khác).
 * 2. storage/generated/<tên phim>/<file>/<file>.json — job
 *    "scriptReferenceVideo"/"generateScript" (nhiều tập CHUNG 1 folder phim).
 *
 * Dò rule 1 TRƯỚC (khớp trực tiếp, không cần quét thư mục); KHÔNG thấy mới
 * quét các folder con CẤP 1 của storage/generated/ tìm rule 2 (folder phim
 * BẤT KỲ có chứa đúng "<file>/<file>.json"). KHÔNG thấy ở CẢ HAI (file JSON
 * này chưa từng tồn tại trong generated/) thì mặc định dùng đường dẫn rule 1
 * — đây cũng chính là đường dẫn SẼ được tạo mới.
 */
async function resolveExistingGeneratedJsonPath(
  normalizedFileName: string,
): Promise<string> {
  const directPath = path.join(
    generatedDirFor(normalizedFileName),
    normalizedFileName,
  );
  const directExists = await fs
    .access(directPath)
    .then(() => true)
    .catch(() => false);
  if (directExists) return directPath;

  const generatedRoot = path.resolve("./storage/generated");
  const topLevelDirs = await fs
    .readdir(generatedRoot, { withFileTypes: true })
    .then((entries) =>
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    )
    .catch(() => [] as string[]);
  const fileBaseName = path.basename(
    normalizedFileName,
    path.extname(normalizedFileName),
  );
  for (const filmDirName of topLevelDirs) {
    const nestedPath = path.join(
      generatedRoot,
      filmDirName,
      fileBaseName,
      normalizedFileName,
    );
    const nestedExists = await fs
      .access(nestedPath)
      .then(() => true)
      .catch(() => false);
    if (nestedExists) return nestedPath;
  }

  return directPath;
}

/**
 * User upload TRỰC TIẾP 1 file .json (KHÔNG cần caption đặc biệt như
 * tryReplaceGeneratedFile) — coi đây là kịch bản storyboard cho folder
 * generated/<tên file json>/ ĐANG THỰC SỰ chứa file này (xem
 * resolveExistingGeneratedJsonPath — có thể là folder riêng, hoặc folder con
 * bên trong 1 folder phim, tuỳ layout đang dùng). Nếu file CHƯA từng có (lần
 * đầu upload json này): tạo folder + copy file vào làm kịch bản chính. Nếu
 * đã có SẴN 1 file json chính rồi: backup file cũ thành "<tên>_vXX.json" (XX
 * tăng dần, xem nextBackupVersion), rồi COPY "success" từ các entry cũ sang
 * entry mới khớp id (xem mergeStoryboardSuccess) trước khi ghi file MỚI vào
 * thay thế (giữ nguyên tên gốc) — GIỐNG cơ chế tryReplaceGeneratedFile, dùng
 * chung nextBackupVersion. Trả về true nếu ĐÃ xử lý (đuôi .json) — handler
 * gọi hàm này phải dừng lại ngay, không rơi xuống luồng upload prompt file
 * (.txt/.md) hay ảnh/video tham chiếu thường.
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
  const targetPath = await resolveExistingGeneratedJsonPath(normalizedFileName);
  const dir = path.dirname(targetPath);

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
      ...promptMenu,
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
      ...promptMenu,
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
      ...promptMenu
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
      ...promptMenu, 
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

interface SubmitScriptReferenceVideoParams {
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  videoPath: string;
  videoFileName: string;
  /** Caption user gõ kèm khi gửi video — TRANSFORM_MODE mặc định ON (xem master prompt), caption dùng để TẮT (vd "giữ nguyên như video gốc") hoặc tuỳ chỉnh thêm. Nối thêm vào master prompt trước khi gửi ChatAI, xem askChatAIAboutReferenceVideo. */
  extraInstruction?: string;
  /** Path master prompt (mặc định config.promptSplitVideo nếu không truyền) — VIDEO_REFERENCE_BUTTON_LABEL truyền config.promptVideoReference. */
  masterPromptPath?: string;
  /** true = job CHỈ gửi lại JSON rồi dừng, không gửi nút xác nhận "Tạo ảnh" — VIDEO_REFERENCE_BUTTON_LABEL truyền true (theo yêu cầu người dùng). */
  skipImageConfirmation?: boolean;
  /** true = SAU KHI có JSON, đối chiếu lại với video gốc qua verifyReferenceVideoJson — TEST_VIDEO_REFERENCE_BUTTON_LABEL truyền true (xem ScriptReferenceVideoJob trong queue.ts). */
  verifyPromptTest?: boolean;
  ctx: Context;
}

/** Dùng chung cho cả nút "Tham chiếu kịch bản" (SCRIPT_REFERENCE_BUTTON_LABEL) và "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL) — user upload 1 video, đẩy job "scriptReferenceVideo" (xem processChatAIQueue trong queue.ts): hỏi ChatAI, gửi lại JSON — kèm nút xác nhận "Tạo ảnh (Pollo)" trừ khi skipImageConfirmation=true. Master prompt dùng khác nhau theo masterPromptPath. */
async function submitScriptReferenceVideoJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  videoPath,
  videoFileName,
  extraInstruction,
  masterPromptPath,
  skipImageConfirmation,
  verifyPromptTest,
}: SubmitScriptReferenceVideoParams): Promise<void> {
  const statusMessage = await ctx.reply(
    "⏳ Đang xử lý...",
    { 
      reply_parameters: { message_id: promptMessageId }, 
      ...promptMenu, 
    },
  );

  enqueueJob({
    type: "scriptReferenceVideo",
    chatId: groupChatId,
    userId,
    prompt: "",
    promptMessageId,
    statusMessageId: statusMessage.message_id,
    videoPath,
    videoFileName,
    extraInstruction,
    masterPromptPath,
    skipImageConfirmation,
    verifyPromptTest,
  });
}

/**
 * Nút "Tạo kịch bản mới" (GENERATE_SCRIPT_BUTTON_LABEL) — user gõ tên (hoặc 1
 * phần tên) file JSON kịch bản ĐÃ CÓ SẴN trong config.chatAIResultsDir (thư
 * mục ChatAI lưu kết quả các lần chạy trước, xem downloadAttachedFiles trong
 * chatAI.ts). Tìm TẤT CẢ file .json có tên CHỨA chuỗi đã gõ (không phân biệt
 * hoa/thường) — có thể khớp nhiều file, mỗi file coi là 1 TẬP PHIM. Ghép nội
 * dung các file đó + master prompt config.promptGenerateScript thành 1 file
 * .txt tạm DUY NHẤT, upload lên ChatAI làm attachment — đẩy job type
 * "generateScript" vào CHUNG hàng đợi với ChatAIJob (xem enqueueJob,
 * processChatAIQueue trong queue.ts) — cùng cơ chế "1 file đính kèm chứa cả
 * instruction lẫn nội dung" như submitChatAIJob (CHATAI_BUTTON_LABEL).
 */
async function handleGenerateScriptRequest(
  ctx: Context,
  typedText: string,
  promptMessageId: number,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.chat) return;

  const searchTerm = normalizeTypedJsonFileName(typedText);
  if (!searchTerm) {
    await ctx.reply("Tên file trống, đã huỷ.", promptMenu);
    return;
  }

  const allFiles = await fs
    .readdir(config.chatAIResultsDir)
    .catch(() => [] as string[]);
  const matches = allFiles
    .filter(
      (f) =>
        f.toLowerCase().endsWith(".json") &&
        f.toLowerCase().includes(searchTerm.toLowerCase()),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (matches.length === 0) {
    await ctx.reply(
      `❌ Không tìm thấy file JSON nào có tên chứa "${searchTerm}" trong storage/chatai-results. Không thể tiếp tục.`,
      { 
        reply_parameters: { message_id: promptMessageId },
        ...promptMenu
      },
    );
    return;
  }

  const masterPrompt = await fs
    .readFile(config.promptGenerateScript, "utf-8")
    .catch((err) => {
      console.error(
        `[bot] Không đọc được master prompt "${config.promptGenerateScript}":`,
        err,
      );
      return null;
    });
  if (masterPrompt === null) {
    await ctx.reply(
      "❌ Không đọc được master prompt cho tính năng này, đã huỷ.",
      { 
        reply_parameters: { message_id: promptMessageId },
        ...promptMenu
      },
    );
    return;
  }

  // SỬA (theo yêu cầu người dùng): mỗi lần remake CÙNG 1 tên phim gốc phải
  // ra 1 folder generated/ MỚI, không ghi đè/archive lần remake trước — tính
  // SẴN tên đã version hoá ("phim_a_remake_1", "phim_a_remake_2"...) TRƯỚC
  // khi enqueue, xem
  // resolveNextRemakeVersion (storyboardPipeline.ts) + docstring
  // GenerateScriptJob.remakeBaseName (queue.ts). Dùng luôn tên này làm gợi ý
  // OUTPUT_BASENAME_GOI_Y — không bắt buộc model tuân theo (processChatAIQueue
  // sẽ tự đổi tên lại file JSON theo remakeBaseName dù model đặt tên gì),
  // nhưng khớp sẵn giúp model đặt tên nhất quán ngay từ đầu.
  const remakeVersion = await resolveNextRemakeVersion(searchTerm);
  const remakeBaseName = `${searchTerm}_remake_${remakeVersion}`;

  const sections: string[] = [
    masterPrompt,
    `\n\n## OUTPUT_BASENAME_GOI_Y\n${remakeBaseName}`,
    `\n\n## DANH SÁCH FILE JSON THAM CHIẾU (${matches.length} tập)`,
  ];
  for (let i = 0; i < matches.length; i++) {
    const fileName = matches[i];
    const content = await fs
      .readFile(path.join(config.chatAIResultsDir, fileName), "utf-8")
      .catch((err) => {
        console.error(
          `[bot] Không đọc được file tham chiếu "${fileName}":`,
          err,
        );
        return null;
      });
    if (content === null) {
      await ctx.reply(
        `❌ Không đọc được file "${fileName}", đã huỷ.`,
        { 
          reply_parameters: { message_id: promptMessageId },
          ...promptMenu
        },
      );
      return;
    }
    sections.push(`\n\n### TẬP ${i + 1}: ${fileName}\n\`\`\`json\n${content}\n\`\`\``);
  }

  await fs.mkdir(config.uploadsDir, { recursive: true });
  const combinedAttachmentPath = path.join(
    config.uploadsDir,
    `${randomUUID()}-generate-script.txt`,
  );
  await fs.writeFile(combinedAttachmentPath, sections.join(""), "utf-8");

  const statusMessage = await ctx.reply(
    `⏳ Đang xử lý (${matches.length} tập tham chiếu: ${matches.join(", ")})...`,
    { 
      reply_parameters: { message_id: promptMessageId }, 
      ...promptMenu, 
     },
  );

  enqueueJob({
    type: "generateScript",
    chatId: ctx.chat.id,
    userId,
    prompt: GENERATE_SCRIPT_ATTACHMENT_PROMPT,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
    referenceFileNames: matches,
    promptAttachmentPath: combinedAttachmentPath,
    remakeBaseName,
  });
}

/**
 * Tìm ĐÚNG 1 file JSON trong config.chatAIResultsDir có tên CHỨA searchTerm
 * (không phân biệt hoa/thường) — dùng cho handleGenerateScriptEpisodeRequest,
 * nơi mỗi dòng input PHẢI trỏ tới ĐÚNG 1 file (khác handleGenerateScriptRequest
 * ở trên, nơi 1 chuỗi được phép khớp NHIỀU file = nhiều tập cùng lúc). Trả về
 * null kèm thông báo lỗi đã gửi sẵn cho user nếu khớp 0 hoặc >1 file (liệt kê
 * rõ các file khớp để user gõ lại chính xác hơn).
 */
async function findSingleGeneratedScriptFile(
  ctx: Context,
  searchTerm: string,
  promptMessageId: number,
  /** Nhãn mô tả dùng trong thông báo lỗi (vd "TẬP GỐC", "TẬP MỚI TRƯỚC ĐÓ"). */
  label: string,
): Promise<string | null> {
  const allFiles = await fs
    .readdir(config.chatAIResultsDir)
    .catch(() => [] as string[]);
  const matches = allFiles.filter(
    (f) =>
      f.toLowerCase().endsWith(".json") &&
      f.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  if (matches.length === 0) {
    await ctx.reply(
      `❌ Không tìm thấy file JSON nào có tên chứa "${searchTerm}" (${label}) trong storage/chatai-results. Không thể tiếp tục.`,
      { reply_parameters: { message_id: promptMessageId },
        ...promptMenu
      },
    );
    return null;
  }
  if (matches.length > 1) {
    await ctx.reply(
      `❌ "${searchTerm}" (${label}) khớp ${matches.length} file, cần khớp ĐÚNG 1 file: ${matches.join(", ")}. Gõ lại tên cụ thể hơn.`,
      { reply_parameters: { message_id: promptMessageId },
        ...promptMenu
      },
    );
    return null;
  }
  return matches[0];
}

/**
 * Nút "Tạo kịch bản theo từng tập" (GENERATE_SCRIPT_EPISODE_BUTTON_LABEL) —
 * KHÁC handleGenerateScriptRequest ở trên: sinh ĐÚNG 1 TẬP/lần thay vì cả
 * phim cùng lúc. User gõ 1-2 dòng:
 * - Dòng 1 (bắt buộc): tên/1 phần tên file JSON TẬP GỐC — dùng làm khung kỹ
 *   thuật (số shot/clip, duration, aspectRatio, frameRate).
 * - Dòng 2 (tuỳ chọn): tên/1 phần tên file JSON TẬP MỚI ngay trước đó (của
 *   CHÍNH phim mới đang viết, không phải phim gốc) — dùng làm nguồn giữ nhất
 *   quán nhân vật/bối cảnh/đạo cụ (Asset Ledger) và tiếp nối mạch truyện.
 *
 * Xác định remakeBaseName/tapNumber:
 * - KHÔNG có dòng 2 (tập đầu tiên): dùng resolveNextRemakeVersion (CÙNG cơ
 *   chế với handleGenerateScriptRequest) để mỗi phim mới tham chiếu CÙNG 1
 *   tên phim gốc luôn ra 1 folder generated/ MỚI — tapNumber = 1.
 * - CÓ dòng 2 (tập tiếp nối): rút tên phim + số tập từ CHÍNH tên file dòng 2
 *   (dạng "<tên_phim>_tapN_full.json", khớp đúng quy ước đặt tên của job
 *   "generateScript"/"generateScriptEpisode" — xem processChatAIQueue) —
 *   tapNumber = N + 1, DÙNG LẠI đúng "<tên_phim>" làm generatedFolderNameOverride
 *   để tập mới chia sẻ CHUNG 1 folder generated/ với (các) tập trước, không
 *   tách folder riêng. Nếu tên file dòng 2 KHÔNG khớp đúng quy ước này (file
 *   do user tự đổi tên, hoặc sinh từ nguồn khác) — coi cả basename đó là tên
 *   phim, tapNumber mặc định = 2 (giả định file đó là tập 1).
 *
 * Output LUÔN đúng 1 file JSON (schema prompt_generate_script_episode.txt) —
 * dùng CHUNG job type "generateScript"/processChatAIQueue với
 * handleGenerateScriptRequest (chỉ set generatedFolderNameOverride để tách
 * folder khỏi remakeBaseName, xem docstring field đó trong queue.ts).
 */
async function handleGenerateScriptEpisodeRequest(
  ctx: Context,
  typedText: string,
  promptMessageId: number,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.chat) return;

  const lines = typedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    await ctx.reply("Chưa gõ tên file nào, đã huỷ.", promptMenu);
    return;
  }

  const originalSearchTerm = normalizeTypedJsonFileName(lines[0]);
  const continuitySearchTerm = lines[1]
    ? normalizeTypedJsonFileName(lines[1])
    : null;

  const originalFileName = await findSingleGeneratedScriptFile(
    ctx,
    originalSearchTerm,
    promptMessageId,
    "TẬP GỐC",
  );
  if (!originalFileName) return;

  const continuityFileName = continuitySearchTerm
    ? await findSingleGeneratedScriptFile(
        ctx,
        continuitySearchTerm,
        promptMessageId,
        "TẬP MỚI TRƯỚC ĐÓ",
      )
    : null;
  if (continuitySearchTerm && !continuityFileName) return;

  const masterPrompt = await fs
    .readFile(config.promptGenerateScriptEpisode, "utf-8")
    .catch((err) => {
      console.error(
        `[bot] Không đọc được master prompt "${config.promptGenerateScriptEpisode}":`,
        err,
      );
      return null;
    });
  if (masterPrompt === null) {
    await ctx.reply(
      "❌ Không đọc được master prompt cho tính năng này, đã huỷ.",
      { reply_parameters: { message_id: promptMessageId }, ...promptMenu },
    );
    return;
  }

  const originalContent = await fs
    .readFile(path.join(config.chatAIResultsDir, originalFileName), "utf-8")
    .catch((err) => {
      console.error(
        `[bot] Không đọc được file "${originalFileName}":`,
        err,
      );
      return null;
    });
  if (originalContent === null) {
    await ctx.reply(`❌ Không đọc được file "${originalFileName}", đã huỷ.`, {
      reply_parameters: { message_id: promptMessageId },
      ...promptMenu
    });
    return;
  }

  let continuityContent: string | null = null;
  if (continuityFileName) {
    continuityContent = await fs
      .readFile(
        path.join(config.chatAIResultsDir, continuityFileName),
        "utf-8",
      )
      .catch((err) => {
        console.error(
          `[bot] Không đọc được file "${continuityFileName}":`,
          err,
        );
        return null;
      });
    if (continuityContent === null) {
      await ctx.reply(
        `❌ Không đọc được file "${continuityFileName}", đã huỷ.`,
        { reply_parameters: { message_id: promptMessageId }, ...promptMenu },
      );
      return;
    }
  }

  // Quy ước đặt tên CỐ ĐỊNH của job "generateScript"/"generateScriptEpisode":
  // "<tên_phim>_tap<N>_full.json" — rút lại tên phim + số tập từ CHÍNH file
  // dòng 2 (nếu có) để tiếp tục ĐÚNG phim đó, không tạo remake mới.
  let filmBaseName: string;
  let tapNumber: number;
  if (continuityFileName) {
    const continuityBaseName = path.basename(continuityFileName, ".json");
    const tapMatch = continuityBaseName.match(/^(.*?)_tap(\d+)(?:_full)?$/i);
    if (tapMatch) {
      filmBaseName = tapMatch[1];
      tapNumber = Number(tapMatch[2]) + 1;
    } else {
      filmBaseName = continuityBaseName;
      tapNumber = 2;
    }
  } else {
    const remakeVersion = await resolveNextRemakeVersion(originalSearchTerm);
    filmBaseName = `${originalSearchTerm}_remake_${remakeVersion}`;
    tapNumber = 1;
  }
  const finalFileBaseName = `${filmBaseName}_tap${tapNumber}_full`;

  const sections: string[] = [
    masterPrompt,
    `\n\n## TẬP GỐC (khung kỹ thuật): ${originalFileName}\n\`\`\`json\n${originalContent}\n\`\`\``,
  ];
  if (continuityFileName && continuityContent !== null) {
    sections.push(
      `\n\n## TẬP MỚI TRƯỚC ĐÓ (tiếp nối/ledger): ${continuityFileName}\n\`\`\`json\n${continuityContent}\n\`\`\``,
    );
  }

  await fs.mkdir(config.uploadsDir, { recursive: true });
  const combinedAttachmentPath = path.join(
    config.uploadsDir,
    `${randomUUID()}-generate-script-episode.txt`,
  );
  await fs.writeFile(combinedAttachmentPath, sections.join(""), "utf-8");

  const statusMessage = await ctx.reply(
    `⏳ Đang xử lý (tập gốc: ${originalFileName}${continuityFileName ? `, tiếp nối: ${continuityFileName}` : " — tập đầu tiên"})...`,
    {
      reply_parameters: { message_id: promptMessageId },
      ...promptMenu,
    },
  );

  enqueueJob({
    type: "generateScript",
    chatId: ctx.chat.id,
    userId,
    prompt: GENERATE_SCRIPT_ATTACHMENT_PROMPT,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
    referenceFileNames: continuityFileName
      ? [originalFileName, continuityFileName]
      : [originalFileName],
    promptAttachmentPath: combinedAttachmentPath,
    remakeBaseName: finalFileBaseName,
    generatedFolderNameOverride: filmBaseName,
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
    await ctx.reply(
      isTelegramFileTooBigError(err)
        ? TELEGRAM_FILE_TOO_BIG_REPLY
        : "Không tải được file từ Telegram, đã huỷ.",
      promptMenu,
    );
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
    if (ctx.from) clearPendingUploads(ctx.from.id);
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
      promptMenu
    );
  });

  bot.hears(IMAGE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "image");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi prompt tạo ảnh (chỉ cần gõ text), ` +
        `hoặc gửi kèm tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
      promptMenu
    );
  });

  bot.hears(VIDEO_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "videoRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_VIDEO_REF_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
      promptMenu
    );
  });

  bot.hears(CHARACTER_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "characterRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 ảnh nhân vật (bắt buộc — nếu gửi nhiều ảnh, ảnh gửi gần nhất sẽ được dùng), ` +
        `rồi gõ prompt ở tin nhắn tiếp theo.`,
      promptMenu
    );
  });

  bot.hears(OMNI_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "omniRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_OMNI_REFERENCE_ITEMS} file tham chiếu (ảnh/video/audio, gửi trước rồi gõ prompt ở tin nhắn tiếp theo).`,
      promptMenu
    );
  });

  bot.hears(CHATAI_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "chatAI");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi file .txt kịch bản kèm prompt`,
      promptMenu
    );
  });

  bot.hears(CHATAI_CHECK_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "chatAICheck");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, Gửi file .txt kịch bản kèm prompt`,
      promptMenu
    );
  });

  bot.hears(SCRIPT_REFERENCE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "scriptReference");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 video tham chiếu`,
      promptMenu
    );
  });

  bot.hears(VIDEO_REFERENCE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "videoReference");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 hoặc nhiều video tham chiếu, gửi xong gõ "xong" hoặc "done" để bắt đầu phân tích (nhiều video thì bot phân tích lần lượt rồi trả kết quả cùng lúc kèm thống kê) — bot sẽ phân tích nhân vật/bối cảnh/đạo cụ rồi trả về JSON gồm các đoạn video ngắn nối tiếp (mỗi đoạn tối đa 15s, ranh giới cắt theo lời thoại hợp lý) dùng để gen lại toàn bộ video.`,
      promptMenu
    );
  });

  bot.hears(TEST_VIDEO_REFERENCE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "videoReferenceTest");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 video tham chiếu — bot sẽ dùng prompt.txt tạo JSON (CHARACTER/LOCATION/PROP/OBJECT + VIDEO), sau đó tự đối chiếu lại JSON với CHÍNH video gốc và gửi báo cáo cho bạn xem prompt.txt có mô tả đúng video không.`,
      promptMenu
    );
  });

  bot.hears(GENERATE_SCRIPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "generateScript");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên (hoặc 1 phần tên) file JSON kịch bản đã có trong storage/chatai-results — bot sẽ tìm mọi file JSON có tên chứa chuỗi đó (nhiều file = nhiều tập phim) rồi tạo 1 bộ phim mới tương tự.`,
      promptMenu
    );
  });

  bot.hears(GENERATE_SCRIPT_EPISODE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "generateScriptEpisode");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ 1-2 dòng:\nDòng 1 (bắt buộc): tên/1 phần tên file JSON TẬP GỐC (khung kỹ thuật) trong storage/chatai-results.\nDòng 2 (tuỳ chọn, để trống nếu đây là TẬP ĐẦU TIÊN): tên/1 phần tên file JSON TẬP MỚI ngay trước đó (để tiếp nối nhân vật/bối cảnh/mạch truyện).`,
      promptMenu,
    );
  });

  bot.hears(UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "updateGenerateScriptPrompt");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi file .txt nội dung mới cho "${config.promptGenerateScript}"`,
      promptMenu
    );
  });

  bot.hears(UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "updateVideoReferencePrompt");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi file .txt nội dung mới cho "${config.promptVideoReference}"`,
      promptMenu
    );
  });

  bot.hears(UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "updateTestVideoReferencePrompt");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi file .txt nội dung mới cho "${config.promptVideoReferenceTest}"`,
      promptMenu
    );
  });

  bot.hears(STOP_ALL_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    stopAll(ctx.from.id);
    await ctx.reply(`🛑 Đã dừng job của bạn`, promptMenu);
  });

  bot.hears(CONTINUE_VIDEO_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "continueVideo");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn tiếp tục tạo video.`,
      promptMenu
    );
  });

  bot.hears(MERGE_VIDEO_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "mergeVideo");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn nối video (ghép các video theo thứ tự shot/clip).`,
      promptMenu
    );
  });

  bot.hears(REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "regenerateVideoByTime");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ dòng đầu là tên file json, mỗi dòng tiếp theo là 1 đoạn thời gian lỗi TRÊN VIDEO ĐÃ GHÉP (nút "Nối video"), dạng "mốc1-mốc2" (giây, "mm:ss" hoặc "hh:mm:ss"). Ví dụ:\nphim_a\n0:05-0:12\n1:20-1:25`,
      promptMenu
    );
  });

  bot.hears(CONTINUE_SCENE_FRAME_BUTTON_LABEL, async (ctx) => {
    return
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "continueSceneFrame");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn tiếp tục gen scene frame.`,
      promptMenu
    );
  });

  bot.hears(CONTINUE_IMAGE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    clearPendingUploads(ctx.from.id);
    waitingMode.set(ctx.from.id, "continueImage");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gõ tên file json muốn tiếp tục gen ảnh (CHARACTER/LOCATION).`,
      promptMenu
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
      ctx.message.text === SCRIPT_REFERENCE_BUTTON_LABEL ||
      ctx.message.text === VIDEO_REFERENCE_BUTTON_LABEL ||
      ctx.message.text === TEST_VIDEO_REFERENCE_BUTTON_LABEL ||
      ctx.message.text === GENERATE_SCRIPT_BUTTON_LABEL ||
      ctx.message.text === GENERATE_SCRIPT_EPISODE_BUTTON_LABEL ||
      ctx.message.text === CONTINUE_VIDEO_BUTTON_LABEL ||
      ctx.message.text === CONTINUE_SCENE_FRAME_BUTTON_LABEL ||
      ctx.message.text === CONTINUE_IMAGE_BUTTON_LABEL ||
      ctx.message.text === MERGE_VIDEO_BUTTON_LABEL ||
      ctx.message.text === REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL ||
      ctx.message.text === UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL ||
      ctx.message.text === UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL ||
      ctx.message.text === UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL
    ) {
      return next();
    }

    const userId = ctx.from.id;

    // "Tham chiếu video" nhiều video: gõ "xong"/"done" mới bắt đầu phân tích
    // (xem REFERENCE_VIDEO_DONE_PATTERN). Đang gom video mà gõ text khác thì
    // nhắc lại, giữ nguyên lô.
    const referenceVideoBuffer = pendingReferenceVideoBuffers.get(userId);
    const isReferenceVideoDone = REFERENCE_VIDEO_DONE_PATTERN.test(ctx.message.text);
    if (referenceVideoBuffer) {
      if (isReferenceVideoDone) {
        await flushReferenceVideoBuffer(userId);
      } else {
        await ctx.reply(
          `Đang gom ${referenceVideoBuffer.items.length} video tham chiếu — gửi thêm video, hoặc gõ "xong"/"done" để bắt đầu phân tích (bấm nút khác để huỷ).`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
      return;
    }
    if (isReferenceVideoDone && waitingMode.get(userId) === "videoReference") {
      await ctx.reply(
        'Chưa nhận được video nào — gửi video trước rồi gõ "xong"/"done".',
        { reply_parameters: { message_id: ctx.message.message_id } },
      );
      return;
    }

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
    } else if (mode === "scriptReference") {
      // Bắt buộc phải gửi video — gõ text không kèm video nào thì từ chối,
      // giữ nguyên mode để user thử gửi lại video (khác các mode khác vốn
      // chấp nhận text đơn thuần).
      await ctx.reply(
        "Chế độ Tham chiếu kịch bản bắt buộc phải gửi 1 video, không nhận text.",
      );
    } else if (mode === "videoReference") {
      // Cùng lý do với "scriptReference" ở trên — bắt buộc gửi video.
      await ctx.reply(
        "Chế độ Tham chiếu video bắt buộc phải gửi 1 video, không nhận text.",
      );
    } else if (mode === "videoReferenceTest") {
      // Cùng lý do với "videoReference" ở trên — bắt buộc gửi video.
      await ctx.reply(
        "Chế độ Test prompt tham chiếu video bắt buộc phải gửi 1 video, không nhận text.",
      );
    } else if (mode === "generateScript") {
      await handleGenerateScriptRequest(
        ctx,
        ctx.message.text,
        ctx.message.message_id,
      );
    } else if (mode === "generateScriptEpisode") {
      await handleGenerateScriptEpisodeRequest(
        ctx,
        ctx.message.text,
        ctx.message.message_id,
      );
    } else if (mode === "continueVideo") {
      // Cùng quy ước gộp khoảng trắng → "_" với các luồng upload file khác
      // (xem originalFileName/tryHandleReferenceJsonUpload) — user gõ tay tên
      // file dễ lẫn khoảng trắng so với tên thư mục thật (đã normalize sẵn).
      const jsonFileName = normalizeTypedJsonFileName(ctx.message.text);
      // SỬA theo yêu cầu user: KHÔNG còn tra failedStoryboardJobs/
      // failedStoryboardJobsPollo/failedStoryboardJobsComfy (bắt buộc phải
      // TỪNG lỗi mới cho tiếp tục — chặn cả trường hợp file chưa từng gen
      // video lần nào, hoặc job cũ đã bị dọn khỏi danh sách lỗi vì lý do
      // khác). Giờ chỉ cần file JSON khớp tên tồn tại trong generated/ là đẩy
      // thẳng 1 job "storyboardVideoComfy" MỚI vào hàng đợi — không kèm
      // entryIds nghĩa là generateVideosForFileComfyUI tự xử lý hết entry
      // VIDEO chưa "success", giống hệt luồng xác nhận bình thường (xem
      // confirmVideoGenerationComfy). Đổi từ "storyboardVideoPollo" sang
      // "storyboardVideoComfy" theo yêu cầu người dùng.
      //
      // SỬA (theo yêu cầu người dùng): dùng resolveExistingGeneratedJsonPath
      // (rule path JSON mới, xem docstring) thay vì chỉ generatedDirFor —
      // file JSON có thể nằm ở rule-2 (nested, phim nhiều tập) chứ không chỉ
      // rule-1 (flat) như trước, tránh báo "không tìm thấy" oan cho job
      // thuộc rule-2.
      const jsonPath = await resolveExistingGeneratedJsonPath(
        `${jsonFileName}.json`,
      );
      const fileExists = await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false);
      if (fileExists) {
        enqueueJob({
          type: "storyboardVideoComfy",
          chatId: ctx.chat.id,
          userId,
          prompt: "",
          promptMessageId: ctx.message.message_id,
          jsonPath,
        });
        await ctx.reply(
          `✅ Đã đưa "${jsonFileName}" vào hàng đợi tạo video, đợi xử lý.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply(
          `❌ Không tìm thấy file "${jsonFileName}" trong generated/. Không thể tiếp tục.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
    } else if (mode === "mergeVideo") {
      // Nút "Nối video" (MERGE_VIDEO_BUTTON_LABEL) — cùng cách tra file JSON
      // với "continueVideo" ở trên (normalizeTypedJsonFileName +
      // resolveExistingGeneratedJsonPath). Ghép TẤT CẢ entry VIDEO theo đúng
      // thứ tự shot/clip (mergeVideosForFile, storyboardPipeline.ts) rồi lưu
      // video kết quả CÙNG TÊN với file JSON (chỉ khác đuôi .mp4) vào ĐÚNG
      // outputDir chứa JSON đó, gửi lại cho user.
      //
      // Việc ghép chạy Ở NỀN (KHÔNG await trong handler) — cùng lý do đã áp
      // dụng cho handleScriptReferenceVideoUpload (xem chú thích ở đó): video
      // nhiều/nặng có thể mất một lúc, không nên giữ handler chờ đồng bộ.
      const jsonFileName = normalizeTypedJsonFileName(ctx.message.text);
      const jsonPath = await resolveExistingGeneratedJsonPath(
        `${jsonFileName}.json`,
      );
      const fileExists = await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        await ctx.reply(
          `❌ Không tìm thấy file "${jsonFileName}" trong generated/. Không thể nối video.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        const chatId = ctx.chat.id;
        const promptMessageId = ctx.message.message_id;
        const statusMessage = await ctx.reply(
          `⏳ Đang ghép video "${jsonFileName}"...`,
          { reply_parameters: { message_id: promptMessageId } },
        );

        void (async () => {
          // SỬA (theo yêu cầu người dùng): KHÔNG lưu video ghép vào folder
          // generated/ chứa JSON đó nữa — ghép thẳng vào 1 file TẠM (ngoài
          // generated/, trong config.debugDir, tên random để không đụng
          // job/file nào khác đang chạy), publish CHÍNH file tạm đó ra
          // QWEN_PUBLIC_BASE_URL rồi xoá file tạm ngay sau — nơi lưu trữ
          // DUY NHẤT của video ghép là config.qwenFileServeDir (qua
          // publishFileTemporarily), không còn bản nào trong generated/.
          try {
            // Gửi LINK xem trực tiếp thay vì gửi nguyên file qua Telegram —
            // publish video vừa ghép ra QWEN_PUBLIC_BASE_URL (qwenFileServer.ts,
            // CÙNG static file server đang dùng để OpenRouter/Qwen tải video,
            // xem qwenAI.ts). KHÁC MỌI nơi gọi publishFileTemporarily khác
            // trong dự án: ở đó luôn cleanup() NGAY sau khi dùng xong (server
            // bên thứ 3 tải xong là xoá) — ở ĐÂY thì KHÔNG gọi cleanup, vì
            // mục đích chính là để user (hoặc ai có link) xem lại được BẤT
            // KỲ LÚC NÀO sau này, không phải chỉ đủ thời gian cho 1 lượt tải
            // tức thời. File publish trong config.qwenFileServeDir sẽ tồn
            // tại vĩnh viễn (tới khi bị dọn tay) — đây là nơi lưu trữ DUY
            // NHẤT của video ghép (không còn bản nào trong generated/).
            // (ghép + publish dùng chung mergeVideosAndPublish, queue.ts).
            const { url, videoCount } = await mergeVideosAndPublish(
              jsonPath,
              jsonFileName,
            );

            await ctx.telegram
              .deleteMessage(chatId, statusMessage.message_id)
              .catch(() => {});

            await ctx.telegram.sendMessage(
              chatId,
              `✅ Đã nối ${videoCount} video từ "${jsonFileName}", theo đúng thứ tự shot/clip.\n\n🔗 Xem tại: ${url}`,
              {
                reply_parameters: { message_id: promptMessageId },
                ...promptMenu,
              },
            );
          } catch (err) {
            console.error(`[bot] Nối video "${jsonFileName}" thất bại:`, err);
            await ctx.telegram
              .deleteMessage(chatId, statusMessage.message_id)
              .catch(() => {});
            await ctx.telegram
              .sendMessage(
                chatId,
                `⚠️ Nối video "${jsonFileName}" thất bại: ${err instanceof Error ? err.message : String(err)}`,
                {
                  reply_parameters: { message_id: promptMessageId },
                  ...promptMenu,
                },
              )
              .catch(() => {});
          }
        })();
      }
    } else if (mode === "regenerateVideoByTime") {
      // Nút "Gen lại video lỗi" (REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL) —
      // dòng đầu là tên file json (cùng cách tra file với "mergeVideo"/
      // "continueVideo"), các dòng sau là đoạn thời gian lỗi TRÊN VIDEO ĐÃ
      // GHÉP dạng "mốc1-mốc2". Tính timeline [start,end) của TỪNG clip bằng
      // buildVideoTimeline (cộng dồn VIDEO.duration theo đúng thứ tự shot/
      // clip — CÙNG thứ tự mergeVideosForFile dùng để ghép, nên mốc thời
      // gian user báo trên video đã ghép khớp ĐÚNG timeline này), rồi đối
      // chiếu ra clip nào chồng lấn (findVideoEntriesInTimeRange) — CÙNG
      // side-effect với regenerateStoryboardItemLine (đánh dấu success=false,
      // xoá file .mp4 cũ) nhưng áp dụng cho NHIỀU clip cùng lúc, gộp lại
      // CHỈ 1 job "storyboardVideoComfy" duy nhất cho cả file thay vì đẩy
      // riêng từng clip (job tự bỏ qua entry còn success=true).
      const lines = ctx.message.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length < 2) {
        await ctx.reply(
          `❌ Cần dòng đầu là tên file json và ít nhất 1 dòng thời gian lỗi dạng "mốc1-mốc2".`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
        return;
      }

      const jsonFileName = normalizeTypedJsonFileName(lines[0]);
      const jsonPath = await resolveExistingGeneratedJsonPath(
        `${jsonFileName}.json`,
      );
      const fileExists = await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        await ctx.reply(
          `❌ Không tìm thấy file "${jsonFileName}" trong generated/. Không thể gen lại.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
        return;
      }

      const raw = await fs.readFile(jsonPath, "utf-8");
      let entries: StoryboardEntry[];
      try {
        entries = JSON.parse(raw);
      } catch {
        await ctx.reply(`❌ File "${jsonFileName}" không phải JSON hợp lệ.`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }
      if (!Array.isArray(entries)) {
        await ctx.reply(`❌ File "${jsonFileName}" không phải JSON array.`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }

      let timeline;
      try {
        timeline = buildVideoTimeline(entries);
      } catch (err) {
        await ctx.reply(
          `❌ Không tính được timeline của "${jsonFileName}": ${err instanceof Error ? err.message : String(err)}`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
        return;
      }
      const totalDuration =
        timeline.length > 0 ? timeline[timeline.length - 1].endSec : 0;

      const reportLines: string[] = [];
      const matchedIds = new Set<string>();
      for (const rangeLine of lines.slice(1)) {
        const parts = rangeLine.split("-");
        const startSec =
          parts.length === 2 ? parseTimeRangeMark(parts[0]) : null;
        const endSec =
          parts.length === 2 ? parseTimeRangeMark(parts[1]) : null;
        if (
          parts.length !== 2 ||
          startSec === null ||
          endSec === null ||
          !(endSec > startSec)
        ) {
          reportLines.push(
            `⚠️ "${rangeLine}": sai định dạng, bỏ qua (cần "mốc1-mốc2", mốc2 > mốc1, mốc là giây/mm:ss/hh:mm:ss).`,
          );
          continue;
        }
        const matches = findVideoEntriesInTimeRange(timeline, startSec, endSec);
        if (matches.length === 0) {
          reportLines.push(
            `⚠️ "${rangeLine}": không khớp clip nào (video đã ghép dài ${totalDuration.toFixed(1)}s).`,
          );
          continue;
        }
        for (const m of matches) matchedIds.add(m.id);
        reportLines.push(
          `🔁 "${rangeLine}" → ${matches
            .map(
              (m) =>
                `${m.id} (shot ${m.shot} clip ${m.clip}, ${m.startSec.toFixed(1)}s-${m.endSec.toFixed(1)}s)`,
            )
            .join(", ")}`,
        );
      }

      if (matchedIds.size === 0) {
        await ctx.reply(
          [`❌ Không có clip nào khớp để gen lại "${jsonFileName}":`, ...reportLines].join(
            "\n",
          ),
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
        return;
      }

      for (const entry of entries) {
        if (entry.type === "VIDEO" && entry.id && matchedIds.has(entry.id)) {
          entry.success = false;
        }
      }
      await fs.writeFile(jsonPath, JSON.stringify(entries, null, 2), "utf-8");

      const outputDir = generatedDirFor(jsonPath);
      const filesInDir = await fs.readdir(outputDir).catch(() => [] as string[]);
      for (const id of matchedIds) {
        const idFilePrefix = `${sanitizeId(id)}.`;
        for (const fileName of filesInDir) {
          if (fileName.startsWith(idFilePrefix)) {
            await fs.unlink(path.join(outputDir, fileName)).catch(() => {});
          }
        }
      }

      // Theo yêu cầu người dùng: gen xong không lỗi thì tự nối video của
      // file JSON và gửi link (giống nút "Nối video") — xem
      // mergeAfterSuccess/notifyStoryboardVideoResultComfy trong queue.ts.
      enqueueComfyRegenerateWithMerge({
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        promptMessageId: ctx.message.message_id,
        jsonPath,
      });

      await ctx.reply(
        [
          `✅ Đã đánh dấu gen lại ${matchedIds.size} clip trong "${jsonFileName}" (gen xong không lỗi sẽ tự nối video và gửi link):`,
          ...reportLines,
        ].join("\n"),
        {
          reply_parameters: { message_id: ctx.message.message_id },
          ...promptMenu,
        },
      );
    } else if (mode === "continueSceneFrame") {
      // SỬA (theo yêu cầu người dùng): đẩy job "storyboardScenePollo"
      // (pollo.ai) THAY VÌ "storyboardImagesAIVideo" — cùng cách đơn giản
      // hoá đã áp dụng cho "continueVideo" (xem comment ở đó): KHÔNG cần tra
      // failedStoryboardJobsPollo (bắt buộc phải TỪNG lỗi mới cho tiếp tục),
      // chỉ cần file JSON khớp tên tồn tại trong generated/ là đẩy thẳng 1
      // job "storyboardScenePollo" MỚI vào hàng đợi ảnh Pollo.
      //
      // Cùng quy ước gộp khoảng trắng → "_" với các luồng upload file khác
      // (xem originalFileName/tryHandleReferenceJsonUpload) — user gõ tay tên
      // file dễ lẫn khoảng trắng so với tên thư mục thật (đã normalize sẵn).
      const jsonFileName = normalizeTypedJsonFileName(ctx.message.text);
      // SỬA (theo yêu cầu người dùng, cùng lý do với "continueVideo" ở
      // trên): dùng resolveExistingGeneratedJsonPath thay vì chỉ
      // generatedDirFor — file JSON có thể nằm ở rule-2 (nested, phim nhiều
      // tập).
      const jsonPath = await resolveExistingGeneratedJsonPath(
        `${jsonFileName}.json`,
      );
      const fileExists = await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false);
      if (fileExists) {
        enqueueJob({
          type: "storyboardScenePollo",
          chatId: ctx.chat.id,
          userId,
          prompt: "",
          promptMessageId: ctx.message.message_id,
          jsonPath,
        });
        await ctx.reply(
          `✅ Đã đưa "${jsonFileName}" vào hàng đợi gen scene frame, đợi xử lý.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply(
          `❌ Không tìm thấy file "${jsonFileName}" trong generated. Không thể tiếp tục.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
    } else if (mode === "continueImage") {
      // GIỐNG "continueSceneFrame" HỆT (không tra failedStoryboardJobsPollo,
      // chỉ cần file JSON khớp tên tồn tại trong generated/ là đẩy thẳng job
      // mới) nhưng đẩy job "storyboardImagesPollo" (gen ảnh CHARACTER/
      // LOCATION) THAY VÌ "storyboardScenePollo" (gen ảnh SCENE_SETTING_START/
      // END) — xem docstring CONTINUE_IMAGE_BUTTON_LABEL trong keyboard.ts.
      const jsonFileName = normalizeTypedJsonFileName(ctx.message.text);
      const jsonPath = await resolveExistingGeneratedJsonPath(
        `${jsonFileName}.json`,
      );
      const fileExists = await fs
        .access(jsonPath)
        .then(() => true)
        .catch(() => false);
      if (fileExists) {
        enqueueJob({
          type: "storyboardImagesPollo",
          chatId: ctx.chat.id,
          userId,
          prompt: "",
          promptMessageId: ctx.message.message_id,
          jsonPath,
        });
        await ctx.reply(
          `✅ Đã đưa "${jsonFileName}" vào hàng đợi gen ảnh, đợi xử lý.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply(
          `❌ Không tìm thấy file "${jsonFileName}" trong generated. Không thể tiếp tục.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
    } else if (
      mode === "updateGenerateScriptPrompt" ||
      mode === "updateVideoReferencePrompt" ||
      mode === "updateTestVideoReferencePrompt"
    ) {
      // Bắt buộc phải gửi file .txt (xem nhánh xử lý trong
      // bot.on(message("document"))) — gõ text không kèm file thì từ chối,
      // cùng cách với "scriptReference"/"videoReference" ở trên.
      await ctx.reply(
        "Chế độ cập nhật prompt bắt buộc phải gửi 1 file .txt, không nhận text.",
      );
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

    // Chế độ "Tham chiếu kịch bản" (SCRIPT_REFERENCE_BUTTON_LABEL) — video
    // Telegram nén sẵn (không qua nút đính kèm 📎, khác nhánh document bên
    // dưới) được nhận diện qua message("video") này. Tải về rồi đẩy job
    // "scriptReferenceVideo" NGAY, không cần chờ prompt nào thêm (khác mode
    // "video"/"videoRef" — video ở đây là input chính, không phải ảnh tham
    // chiếu phụ). TRANSFORM_MODE mặc định ON (xem prompt_split_video.txt) —
    // caption (nếu có, vd "giữ nguyên như video gốc") dùng để TẮT hoặc tuỳ
    // chỉnh thêm, nối vào master prompt — xem extraInstruction trong
    // submitScriptReferenceVideoJob.
    if (waitingMode.get(userId) === "scriptReference") {
      waitingMode.delete(userId);
      const videoFileName = resolveVideoFileName(
        ctx.message.video.file_name,
        ctx.message.caption,
        ctx.message.message_id,
      );
      await handleScriptReferenceVideoUpload(
        ctx,
        ctx.message.video.file_id,
        ctx.chat.id,
        ctx.message.message_id,
        videoFileName,
        ctx.message.caption?.trim() || undefined,
      );
      return;
    }

    // Chế độ "Tham chiếu video" (VIDEO_REFERENCE_BUTTON_LABEL) — GIỐNG HỆT
    // nhánh "scriptReference" ở trên, chỉ khác masterPromptPath truyền cho
    // submitScriptReferenceVideoJob (config.promptVideoReference thay vì mặc
    // định config.promptSplitVideo) — JSON trả về chia thành các đoạn VIDEO
    // ngắn nối tiếp (tối đa 15s/đoạn, ranh giới theo lời thoại — xem mục 3B
    // trong prompt_video_reference.txt) thay vì chia theo diễn biến/cảnh
    // như prompt_split_video.txt.
    // Cho phép gửi nhiều video cùng lúc — gom lô (addReferenceVideo), giữ
    // waitingMode tới khi chốt lô để video tiếp theo vẫn vào đúng lô.
    if (waitingMode.get(userId) === "videoReference") {
      addReferenceVideo(ctx, userId, ctx.chat.id, {
        fileId: ctx.message.video.file_id,
        videoFileName: resolveVideoFileName(
          ctx.message.video.file_name,
          ctx.message.caption,
          ctx.message.message_id,
        ),
        caption: ctx.message.caption?.trim() || undefined,
        messageId: ctx.message.message_id,
      });
      return;
    }

    // Chế độ "Test prompt tham chiếu video" (TEST_VIDEO_REFERENCE_BUTTON_LABEL)
    // — GIỐNG HỆT nhánh "videoReference" ở trên, chỉ khác masterPromptPath
    // (config.promptVideoReferenceTest, file prompt.txt) và verifyPromptTest=
    // true — SAU KHI có JSON, đối chiếu lại với CHÍNH video gốc (xem
    // verifyReferenceVideoJson/processChatAIQueue).
    if (waitingMode.get(userId) === "videoReferenceTest") {
      waitingMode.delete(userId);
      const videoFileName = resolveVideoFileName(
        ctx.message.video.file_name,
        ctx.message.caption,
        ctx.message.message_id,
      );
      await handleScriptReferenceVideoUpload(
        ctx,
        ctx.message.video.file_id,
        ctx.chat.id,
        ctx.message.message_id,
        videoFileName,
        ctx.message.caption?.trim() || undefined,
        {
          masterPromptPath: config.promptVideoReferenceTest,
          skipImageConfirmation: true,
          verifyPromptTest: true,
        },
      );
      return;
    }

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

    // Chế độ "Cập nhật prompt ..." (UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL/
    // UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL) — user upload 1 file .txt
    // để GHI ĐÈ đúng master prompt tương ứng, xem
    // handleUpdateMasterPromptUpload (tự sao lưu bản cũ trước).
    if (waitingMode.get(userId) === "updateGenerateScriptPrompt") {
      waitingMode.delete(userId);
      await handleUpdateMasterPromptUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_name,
        ctx.message.message_id,
        config.promptGenerateScript,
      );
      return;
    }
    if (waitingMode.get(userId) === "updateVideoReferencePrompt") {
      waitingMode.delete(userId);
      await handleUpdateMasterPromptUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_name,
        ctx.message.message_id,
        config.promptVideoReference,
      );
      return;
    }
    if (waitingMode.get(userId) === "updateTestVideoReferencePrompt") {
      waitingMode.delete(userId);
      await handleUpdateMasterPromptUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_name,
        ctx.message.message_id,
        config.promptVideoReferenceTest,
      );
      return;
    }

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
          isTelegramFileTooBigError(err)
            ? TELEGRAM_FILE_TOO_BIG_REPLY
            : "Không tải được file prompt từ Telegram, đã huỷ.",
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

    // Chế độ "Tham chiếu kịch bản" — video gửi qua nút đính kèm 📎 (Telegram
    // xếp vào "document", KHÔNG khớp message("video") ở trên) nhận diện qua
    // mime_type. Cùng cách xử lý với nhánh message("video") — tải về rồi đẩy
    // job "scriptReferenceVideo" ngay, không chờ prompt gì thêm. Caption (nếu
    // có) dùng làm yêu cầu bổ sung, cùng cách với nhánh message("video").
    if (waitingMode.get(userId) === "scriptReference") {
      const documentMimeType = ctx.message.document.mime_type ?? "";
      if (!documentMimeType.startsWith("video/")) {
        await ctx.reply(
          "Chế độ Tham chiếu kịch bản chỉ nhận file video. Gửi đúng 1 video.",
        );
        return;
      }
      waitingMode.delete(userId);
      const videoFileName = resolveVideoFileName(
        ctx.message.document.file_name,
        ctx.message.caption,
        ctx.message.message_id,
      );
      await handleScriptReferenceVideoUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.chat.id,
        ctx.message.message_id,
        videoFileName,
        ctx.message.caption?.trim() || undefined,
      );
      return;
    }

    // Chế độ "Tham chiếu video" — video gửi qua nút đính kèm 📎, cùng cách
    // xử lý với nhánh "scriptReference" ở trên, chỉ khác masterPromptPath.
    if (waitingMode.get(userId) === "videoReference") {
      const documentMimeType = ctx.message.document.mime_type ?? "";
      if (!documentMimeType.startsWith("video/")) {
        await ctx.reply("Chế độ Tham chiếu video chỉ nhận file video.");
        return;
      }
      addReferenceVideo(ctx, userId, ctx.chat.id, {
        fileId: ctx.message.document.file_id,
        videoFileName: resolveVideoFileName(
          ctx.message.document.file_name,
          ctx.message.caption,
          ctx.message.message_id,
        ),
        caption: ctx.message.caption?.trim() || undefined,
        messageId: ctx.message.message_id,
      });
      return;
    }

    // Chế độ "Test prompt tham chiếu video" — video gửi qua nút đính kèm 📎,
    // cùng cách xử lý với nhánh "videoReference" ở trên, chỉ khác
    // masterPromptPath + verifyPromptTest=true.
    if (waitingMode.get(userId) === "videoReferenceTest") {
      const documentMimeType = ctx.message.document.mime_type ?? "";
      if (!documentMimeType.startsWith("video/")) {
        await ctx.reply(
          "Chế độ Test prompt tham chiếu video chỉ nhận file video. Gửi đúng 1 video.",
        );
        return;
      }
      waitingMode.delete(userId);
      const videoFileName = resolveVideoFileName(
        ctx.message.document.file_name,
        ctx.message.caption,
        ctx.message.message_id,
      );
      await handleScriptReferenceVideoUpload(
        ctx,
        ctx.message.document.file_id,
        ctx.chat.id,
        ctx.message.message_id,
        videoFileName,
        ctx.message.caption?.trim() || undefined,
        {
          masterPromptPath: config.promptVideoReferenceTest,
          skipImageConfirmation: true,
          verifyPromptTest: true,
        },
      );
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

  // GIỐNG confirmScene HỆT nhưng đẩy job dùng pollo.ai (xem
  // confirmSceneGenerationPollo/StoryboardSceneImagesPolloJob trong queue.ts)
  // — nút "Tạo ảnh scene" được gửi ngay sau khi ảnh CHARACTER/LOCATION (Pollo)
  // xong (xem processPolloImageQueue).
  bot.action(/^confirmScenePollo:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmSceneGenerationPollo(confirmId);
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

  // GIỐNG confirmVideoPollo HỆT nhưng đẩy job dùng ComfyUI (xem
  // confirmVideoGenerationComfy/StoryboardVideoComfyJob trong queue.ts) — nút
  // "Tạo video (Comfy)" gửi CÙNG LÚC với "Tạo video (Pollo)" ngay sau khi ảnh
  // CHARACTER/LOCATION xong (processPolloImageQueue) — ComfyUI KHÔNG có bước
  // "Tạo ảnh" riêng, dùng LẠI CHÍNH ảnh đó.
  bot.action(/^confirmVideoComfy:(.+)$/, async (ctx) => {
    if (!ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    const confirmId = ctx.match[1];
    const ok = confirmVideoGenerationComfy(confirmId);
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

