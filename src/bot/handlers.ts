import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { MAX_OMNI_REFERENCE_ITEMS, MAX_VIDEO_REF_IMAGES } from "../automation/hailuo";
import { MAX_REFERENCE_IMAGES } from "../automation/hailuoImage";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
import { config } from "../config";
import { enqueueJob } from "../queue";
import {
  CHARACTER_REF_BUTTON_LABEL,
  IMAGE_BUTTON_LABEL,
  OMNI_REF_BUTTON_LABEL,
  PROMPT_BUTTON_LABEL,
  VIDEO_REF_BUTTON_LABEL,
  promptMenu,
} from "./keyboard";

type PendingMode = "video" | "image" | "videoRef" | "characterRef" | "omniRef";
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
  const { text: prompt, resolution, model } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    if (startFramePath) await fs.unlink(startFramePath).catch(() => {});
    if (characterImagePath) await fs.unlink(characterImagePath).catch(() => {});
    for (const p of referenceImagePaths ?? []) await fs.unlink(p).catch(() => {});
    for (const p of omniReferencePaths ?? []) await fs.unlink(p).catch(() => {});
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
    `⏳ Đang tạo video cho prompt:\n"${prompt.split(" ").slice(0,20).join(" ")}"${startFrameNote}${refImageNote}${characterNote}${omniNote}`,
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
    `⏳ Đang tạo ảnh cho prompt:\n"${prompt.split(" ").slice(0,20).join(" ")}"${refNote}`,
    {
      reply_parameters: { message_id: promptMessageId },
    },
  );

  enqueueJob({
    type: "image",
    chatId: groupChatId,
    prompt,
    model: isAdmin(userId) ? model : DEFAULT_MODEL,
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

  if (mode === "characterRef") {
    // Bắt buộc đúng 1 ảnh nhân vật — chỉ lấy ảnh GẦN NHẤT nếu gửi nhiều.
    let characterImagePath: string;
    try {
      characterImagePath = await downloadTelegramPhoto(ctx, photoArrays[photoArrays.length - 1]);
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
        await downloadTelegramFile(ctx, item.fileId, omniRefExtension(item.kind)),
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
        `hoặc gửi kèm tối đa ${MAX_VIDEO_REF_IMAGES} ảnh tham chiếu (gửi ảnh trước rồi gõ prompt ở tin nhắn tiếp theo).`,
    );
  });

  bot.hears(CHARACTER_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    waitingMode.set(ctx.from.id, "characterRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi 1 ảnh nhân vật (bắt buộc — nếu gửi nhiều ảnh, ảnh gửi gần nhất sẽ được dùng), ` +
        `rồi gõ prompt ở tin nhắn tiếp theo.`,
    );
  });

  bot.hears(OMNI_REF_BUTTON_LABEL, async (ctx) => {
    if (!ctx.from || !ctx.chat || !isAllowedGroup(ctx.chat.id)) return;
    waitingMode.set(ctx.from.id, "omniRef");
    await ctx.reply(
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo, ` +
        `hoặc gửi kèm tối đa ${MAX_OMNI_REFERENCE_ITEMS} file tham chiếu (ảnh/video/audio, gửi trước rồi gõ prompt ở tin nhắn tiếp theo).`,
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
      ctx.message.text === OMNI_REF_BUTTON_LABEL
    ) {
      return next();
    }

    const userId = ctx.from.id;

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
    if (mode !== "image" && mode !== "video" && mode !== "videoRef" && mode !== "characterRef") return next();

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

    const userId = ctx.from.id;
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
}
