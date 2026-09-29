import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { config } from "../config";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tải file Telegram LỚN (>20MB, vượt giới hạn getFile của HTTP Bot API) —
 * dùng MTProto (thư viện teleproto/GramJS) đăng nhập LẠI CHÍNH bot đang
 * chạy (qua config.botToken, không cần số điện thoại/OTP nào) để lấy trực
 * tiếp message + media qua giao thức MTProto gốc, không đi qua lớp HTTP Bot
 * API nên không bị chặn ở mốc 20MB (server Telegram thật sự hỗ trợ file lớn
 * hơn nhiều — 20MB chỉ là giới hạn NHÂN TẠO của chính api.telegram.org khi
 * phục vụ getFile cho bot, xem docstring config.telegramApiId).
 *
 * BẮT BUỘC config.telegramApiId/telegramApiHash (lấy tại
 * https://my.telegram.org/apps) — thiếu thì throw rõ ràng ngay từ lần gọi
 * đầu, không âm thầm rơi về lỗi MTProto khó hiểu.
 */

let clientPromise: Promise<TelegramClient> | null = null;

function loadSessionString(): string {
  try {
    return fs.readFileSync(config.telegramMTProtoSessionPath, "utf-8").trim();
  } catch {
    return "";
  }
}

function saveSessionString(session: string): void {
  fs.mkdirSync(path.dirname(config.telegramMTProtoSessionPath), {
    recursive: true,
  });
  fs.writeFileSync(config.telegramMTProtoSessionPath, session, "utf-8");
}

async function createClient(): Promise<TelegramClient> {
  if (!config.telegramApiId || !config.telegramApiHash) {
    throw new Error(
      "Thiếu TELEGRAM_API_ID/TELEGRAM_API_HASH trong .env — lấy tại " +
        "https://my.telegram.org/apps (mục 'API development tools') để bot " +
        "tải được file Telegram >20MB qua MTProto.",
    );
  }

  const session = new StringSession(loadSessionString());
  const client = new TelegramClient(
    session,
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 5 },
  );

  await client.start({ botAuthToken: config.botToken });
  saveSessionString(client.session.save());

  return client;
}

/** Cache 1 client DUY NHẤT dùng chung cho cả process — connect() 1 lần, tái sử dụng cho mọi lượt tải file sau đó. */
async function getClient(): Promise<TelegramClient> {
  if (!clientPromise) {
    clientPromise = createClient().catch((err) => {
      // Cho phép thử kết nối lại ở lượt gọi SAU nếu lần này lỗi (vd session
      // hỏng/mạng chập chờn lúc khởi động) — không lỡ mãi mãi cache 1
      // promise đã reject.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/**
 * Tải media của 1 message Telegram (video/document...) về local qua MTProto
 * — dùng chatId/messageId (KHÔNG dùng file_id của Bot API, vì teleproto tự
 * tra lại message qua chính session MTProto của bot rồi tải trực tiếp từ
 * đó, không cần decode file_id).
 */
/**
 * Retry cho downloadMedia — xác nhận qua lỗi thật (2026-09-29):
 * "TimeoutError: Timeout while fetching data. (caused by upload.GetFile)"
 * kèm `code: 503, errorMessage: 'Timeout'` — đây là lỗi phía SERVER Telegram
 * (DC lưu file phản hồi chậm/quá tải), không phải sai tham số hay session
 * hỏng.
 *
 * QUAN TRỌNG (đọc source thật node_modules/teleproto/client/downloads.js,
 * hàm streamParallel — KHÔNG đoán): file có size xác định được tải bằng
 * NHIỀU request `upload.GetFile` chạy SONG SONG (mỗi phần partSize, scale số
 * lượng theo session/window nội bộ), rồi ghép lại đúng thứ tự. CHỈ CẦN 1
 * trong số các phần đó lỗi (firstError) là toàn bộ downloadMedia() ném lỗi
 * NGAY, dù các phần khác đã tải xong — thư viện KHÔNG tự retry riêng phần bị
 * lỗi. Hệ quả: video càng dài/càng nặng thì càng nhiều phần song song, xác
 * suất ÍT NHẤT 1 phần dính lỗi 503 thoáng qua của Telegram càng cao — video
 * 1 tiếng nhiều khả năng lỗi hơn hẳn video vài phút dù server không có gì
 * bất thường hơn. Không sửa được tận gốc (retry-từng-phần) ở tầng gọi vì đó
 * là logic NỘI BỘ của teleproto (sửa trong node_modules sẽ mất khi npm
 * install lại) — retry NGUYÊN CẢ FILE ở tầng này là cách khả thi duy nhất.
 * Nới attempts lên 5 (từ 3) + backoff tăng dần (thay vì cố định 5s) — cho
 * Telegram server thêm thời gian hồi phục nếu là do quá tải thật, và tăng cơ
 * hội "trúng" 1 lượt mà cả loạt phần song song đều suôn sẻ với file nặng.
 */
const MAX_DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

export async function downloadTelegramMediaViaMTProto(
  chatId: number,
  messageId: number,
  destPath: string,
): Promise<void> {
  const client = await getClient();
  const messages = await client.getMessages(chatId, { ids: messageId });
  const message = messages[0];
  if (!message || !message.media) {
    throw new Error(
      `[MTProto] Không tìm thấy media cho message ${messageId} trong chat ${chatId}.`,
    );
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const result = await client.downloadMedia(message, {
        outputFile: destPath,
      });
      if (!result) {
        throw new Error(
          `[MTProto] Tải media thất bại (message ${messageId}, chat ${chatId}).`,
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        const backoffMs =
          DOWNLOAD_RETRY_BACKOFF_MS[
            Math.min(attempt - 1, DOWNLOAD_RETRY_BACKOFF_MS.length - 1)
          ];
        console.warn(
          `[MTProto] Tải media lỗi (lần ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}, message ${messageId}, chat ${chatId}), thử lại sau ${backoffMs / 1000}s:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(backoffMs);
      }
    }
  }
  throw lastError;
}
