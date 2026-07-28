import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { MAX_REFERENCE_IMAGES } from "../automation/hailuoImage";
import { DEFAULT_MODEL, parsePromptMessage } from "../automation/promptParser";
import { config } from "../config";
import { enqueueJob } from "../queue";
import {
  IMAGE_BUTTON_LABEL,
  PROMPT_BUTTON_LABEL,
  promptMenu,
} from "./keyboard";

type PendingMode = "video" | "image";
// userId đang chờ nhập prompt, theo chế độ đã chọn (bấm nút Prompt hoặc Image).
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
  photoArrays: Array<Array<{ file_id: string }>>;
  caption?: string;
  promptMessageId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingPhotoBuffers = new Map<number, PendingPhotoBuffer>();

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

interface SubmitVideoParams {
  ctx: Context;
  groupChatId: number;
  promptMessageId: number;
  userId: number;
  rawText: string;
}

async function submitVideoJob({
  ctx,
  groupChatId,
  promptMessageId,
  userId,
  rawText,
}: SubmitVideoParams): Promise<void> {
  const { text: prompt, resolution, model } = parsePromptMessage(rawText);

  if (!prompt) {
    await ctx.reply("Prompt trống, đã huỷ.", promptMenu);
    return;
  }

  const statusMessage = await ctx.reply(
    `⏳ Đang tạo video cho prompt:\n"${prompt}"`,
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
    `⏳ Đang tạo ảnh cho prompt:\n"${prompt}"${refNote}`,
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
    void handleImageBuffer(current, current.caption ?? "");
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

async function handleImageBuffer(
  buffer: PendingPhotoBuffer,
  rawText: string,
): Promise<void> {
  const { ctx, photoArrays, promptMessageId } = buffer;
  if (!ctx.chat) return;

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
      `${ctx.from.first_name ?? "Bạn"}, gửi nội dung prompt bạn muốn tạo video ở tin nhắn tiếp theo:`,
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

  bot.on(message("text"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();
    if (
      ctx.message.text.startsWith("/") ||
      ctx.message.text === PROMPT_BUTTON_LABEL ||
      ctx.message.text === IMAGE_BUTTON_LABEL
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
      await handleImageBuffer(photoBuffer, ctx.message.text);
      return;
    }

    const mode = waitingMode.get(userId);
    if (!mode) return next();

    waitingMode.delete(userId);

    if (mode === "video") {
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

  // Ảnh tham chiếu cho chế độ tạo ảnh — chỉ nhận khi đang ở mode "image"
  // hoặc đã có buffer đang chờ (đang gom thêm ảnh tiếp theo).
  bot.on(message("photo"), async (ctx, next) => {
    if (!ctx.from || !isAllowedGroup(ctx.chat.id)) return next();

    const userId = ctx.from.id;
    const alreadyBuffering = pendingPhotoBuffers.has(userId);
    if (waitingMode.get(userId) !== "image" && !alreadyBuffering) return next();

    waitingMode.delete(userId);

    const existing = pendingPhotoBuffers.get(userId);
    if (existing) {
      if (existing.photoArrays.length < MAX_REFERENCE_IMAGES) {
        existing.photoArrays.push(ctx.message.photo);
      }
      if (ctx.message.caption) existing.caption = ctx.message.caption;
      scheduleFinalize(userId);
    } else {
      pendingPhotoBuffers.set(userId, {
        ctx,
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
}
