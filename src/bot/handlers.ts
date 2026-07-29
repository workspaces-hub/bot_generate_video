import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { MAX_REFERENCE_VIDEOS } from "../automation/hailuo";
import { MAX_REFERENCE_IMAGES } from "../automation/hailuoImage";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
import { config } from "../config";
import { enqueueJob } from "../queue";
import {
  IMAGE_BUTTON_LABEL,
  PROMPT_BUTTON_LABEL,
  VIDEO_REF_BUTTON_LABEL,
  promptMenu,
} from "./keyboard";

type PendingMode = "video" | "image" | "videoRef";
// userId đang chờ nhập prompt, theo chế độ đã chọn (bấm nút Prompt/Image/Video - Image Reference).
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
  /** "video": chỉ lấy ảnh GẦN NHẤT làm start frame. "image": lấy HẾT làm ảnh tham chiếu. */
  mode: PendingMode;
  photoArrays: Array<Array<{ file_id: string }>>;
  caption?: string;
  promptMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingPhotoBuffers = new Map<number, PendingPhotoBuffer>();

// Gom VIDEO tham chiếu gửi liên tiếp (tối đa MAX_REFERENCE_VIDEOS) — cùng cơ
// chế debounce + "chờ caption" như ảnh, nhưng buffer riêng vì nội dung khác
// hẳn (file_id video đơn, không phải mảng size-variant như ảnh Telegram).
interface PendingVideoRefBuffer {
  ctx: Context;
  videoFileIds: string[];
  caption?: string;
  promptMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingVideoRefBuffers = new Map<number, PendingVideoRefBuffer>();

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

/** Tải ảnh Telegram (độ phân giải cao nhất) về local để upload lên hailuoai.video. */
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

/** Tải video Telegram (video tham chiếu) về local để upload lên hailuoai.video. */
async function downloadTelegramVideo(ctx: Context, fileId: string): Promise<string> {
  const fileUrl = await ctx.telegram.getFileLink(fileId);

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Tải video từ Telegram thất bại: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.mkdir(config.uploadsDir, { recursive: true });
  const videoPath = path.join(config.uploadsDir, `${randomUUID()}.mp4`);
  await fs.writeFile(videoPath, buffer);
  return videoPath;
}

interface SubmitVideoParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
  startFramePath?: string;
  referenceVideoPaths?: string[];
}

async function submitVideoJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  rawText,
  startFramePath,
  referenceVideoPaths,
}: SubmitVideoParams): Promise<void> {
  const { text: prompt, resolution, model } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    if (startFramePath) await fs.unlink(startFramePath).catch(() => {});
    for (const p of referenceVideoPaths ?? []) await fs.unlink(p).catch(() => {});
    return;
  }

  const startFrameNote = startFramePath ? " (kèm ảnh start frame)" : "";
  const refVideoNote =
    referenceVideoPaths && referenceVideoPaths.length > 0
      ? ` (kèm ${referenceVideoPaths.length} video tham chiếu)`
      : "";
  const statusMessage = await ctx.reply(
    `⏳ Đang tạo video cho prompt:\n"${prompt.split(" ").slice(0,20).join(" ")}"${startFrameNote}${refVideoNote}`,
    {
      reply_parameters: { message_id: promptMessageId },
    },
  );

  // Chỉ dữ liệu thuần (không callback/ctx) — enqueueJob tự ghi ra file để
  // sống sót qua restart/crash, xem src/queue.ts.
  enqueueJob({
    type: "video",
    chatId: groupChatId,
    prompt,
    resolution,
    model: isAdmin(userId) ? model : DEFAULT_MODEL,
    startFramePath,
    referenceVideoPaths,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
  });
}

interface SubmitImageParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  rawText: string;
  referenceImagePaths: string[];
}

async function submitImageJob({
  ctx,
  groupChatId,
  promptMessageId,
  rawText,
  referenceImagePaths,
}: SubmitImageParams): Promise<void> {
  const { text: prompt } = parsePromptMessage(rawText);

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
    `⏳ Đang tạo ảnh cho prompt:\n"${prompt.split(" ").slice(0,20).join(" ")}"${refNote}`,
    {
      reply_parameters: { message_id: promptMessageId },
    },
  );

  enqueueJob({
    type: "image",
    chatId: groupChatId,
    prompt,
    referenceImagePaths,
    promptMessageId,
    statusMessageId: statusMessage.message_id,
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
      startFramePath = await downloadTelegramPhoto(ctx, photoArrays[photoArrays.length - 1]);
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

  await submitImageJob({
    ctx,
    groupChatId: ctx.chat.id,
    promptMessageId,
    rawText,
    referenceImagePaths,
  });
}

/** Cùng logic finalizeIfHasCaption nhưng cho buffer video tham chiếu. */
function finalizeVideoRefIfHasCaption(userId: number): void {
  const current = pendingVideoRefBuffers.get(userId);
  if (!current) return;
  if ((current.caption ?? "").trim()) {
    pendingVideoRefBuffers.delete(userId);
    void handleVideoRefBuffer(current, current.caption ?? "");
  }
}

/** Cùng logic scheduleFinalize nhưng cho buffer video tham chiếu. */
function scheduleVideoRefFinalize(userId: number): void {
  const buffer = pendingVideoRefBuffers.get(userId);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(
    () => finalizeVideoRefIfHasCaption(userId),
    PHOTO_BUFFER_DEBOUNCE_MS,
  );
}

async function handleVideoRefBuffer(
  buffer: PendingVideoRefBuffer,
  rawText: string,
): Promise<void> {
  const { ctx, videoFileIds, promptMessageId } = buffer;
  if (!ctx.chat || !ctx.from) return;

  const referenceVideoPaths: string[] = [];
  try {
    for (const fileId of videoFileIds) {
      referenceVideoPaths.push(await downloadTelegramVideo(ctx, fileId));
    }
  } catch (err) {
    console.error("[bot] Tải video Telegram thất bại:", err);
    await ctx.reply("Không tải được video từ Telegram, đã huỷ.", promptMenu);
    for (const p of referenceVideoPaths) await fs.unlink(p).catch(() => {});
    return;
  }

  await submitVideoJob({
    ctx,
    groupChatId: ctx.chat.id,
    promptMessageId,
    userId: ctx.from.id,
    rawText,
    referenceVideoPaths,
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
    waitingMode.set(ctx.from.id, "video");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm 1 ảnh làm start frame trước (nếu gửi nhiều ảnh, ảnh gửi gần nhất sẽ được dùng), ` +
        `rồi gõ prompt ở tin nhắn tiếp theo.`,
    );
  });

  bot.hears(IMAGE_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    waitingMode.set(ctx.from.id, "image");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi prompt tạo ảnh (chỉ cần gõ text), ` +
        `hoặc gửi kèm tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.hears(VIDEO_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    waitingMode.set(ctx.from.id, "videoRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_REFERENCE_VIDEOS} video tham chiếu (gửi video trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();
    if (
      ctx.message.text.startsWith("/") ||
      ctx.message.text === PROMPT_BUTTON_LABEL ||
      ctx.message.text === IMAGE_BUTTON_LABEL ||
      ctx.message.text === VIDEO_REF_BUTTON_LABEL
    ) {
      return next();
    }

    const userId = ctx.from.id;

    // Có ảnh/video tham chiếu đang chờ (chưa có caption) — dùng tin nhắn
    // text này làm prompt cho batch đó, ưu tiên hơn "mode" thông thường.
    const photoBuffer = pendingPhotoBuffers.get(userId);
    if (photoBuffer) {
      clearTimeout(photoBuffer.timer);
      pendingPhotoBuffers.delete(userId);
      waitingMode.delete(userId);
      await handlePhotoBuffer(photoBuffer, ctx.message.text);
      return;
    }

    const videoRefBuffer = pendingVideoRefBuffers.get(userId);
    if (videoRefBuffer) {
      clearTimeout(videoRefBuffer.timer);
      pendingVideoRefBuffers.delete(userId);
      waitingMode.delete(userId);
      await handleVideoRefBuffer(videoRefBuffer, ctx.message.text);
      return;
    }

    const mode = waitingMode.get(userId);
    if (!mode) return next();

    waitingMode.delete(userId);

    if (mode === "video" || mode === "videoRef") {
      // "videoRef" không gửi video nào, chỉ gõ text — hoạt động y hệt "Prompt" thường.
      await submitVideoJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        userId,
        rawText: ctx.message.text,
      });
    } else {
      await submitImageJob({
        ctx,
        groupChatId: ctx.chat.id,
        promptMessageId: ctx.message.message_id,
        rawText: ctx.message.text,
        referenceImagePaths: [],
      });
    }
  });

  // Ảnh cho chế độ tạo ảnh (tham chiếu, tối đa MAX_REFERENCE_IMAGES) hoặc
  // chế độ tạo video (start frame, chỉ ảnh gần nhất được dùng) — chỉ nhận
  // khi đang ở mode tương ứng hoặc đã có buffer đang chờ (đang gom thêm ảnh
  // tiếp theo, giữ nguyên mode đã chọn từ ảnh đầu tiên).
  bot.on(message("photo"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    const userId = ctx.from.id;
    const existing = pendingPhotoBuffers.get(userId);
    const mode = existing?.mode ?? waitingMode.get(userId);
    if (mode !== "image" && mode !== "video") return next();

    waitingMode.delete(userId);

    if (existing) {
      if (existing.photoArrays.length < MAX_REFERENCE_IMAGES) {
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

  // Video tham chiếu cho chế độ "Video - Image Reference" (tối đa
  // MAX_REFERENCE_VIDEOS) — chỉ nhận khi đang ở mode "videoRef" hoặc đã có
  // buffer đang chờ (đang gom thêm video tiếp theo).
  bot.on(message("video"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    const userId = ctx.from.id;
    const existing = pendingVideoRefBuffers.get(userId);
    if (!existing && waitingMode.get(userId) !== "videoRef") return next();

    waitingMode.delete(userId);

    if (existing) {
      if (existing.videoFileIds.length < MAX_REFERENCE_VIDEOS) {
        existing.videoFileIds.push(ctx.message.video.file_id);
      }
      if (ctx.message.caption) existing.caption = ctx.message.caption;
      scheduleVideoRefFinalize(userId);
    } else {
      pendingVideoRefBuffers.set(userId, {
        ctx,
        videoFileIds: [ctx.message.video.file_id],
        caption: ctx.message.caption,
        promptMessageId: ctx.message.message_id,
        timer: setTimeout(
          () => finalizeVideoRefIfHasCaption(userId),
          PHOTO_BUFFER_DEBOUNCE_MS,
        ),
      });
    }
  });
}
