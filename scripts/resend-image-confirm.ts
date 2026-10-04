/**
 * Gửi lại tin nhắn "Xác nhận tạo ảnh" (nút "Tạo ảnh", Pollo) cho 1 hoặc nhiều
 * file JSON đã có trong storage/generated/ — dùng khi tin xác nhận gửi thất
 * bại giữa chừng (vd Telegram 429 ở runStoryboardPipelinePollo) hoặc lỡ mất.
 *
 * Cách dùng (chạy trong thư mục bot, cùng .env với bot):
 *   npx tsx scripts/resend-image-confirm.ts <chatId> <tên...> --reply <messageId> [--user <userId>]
 *   (bản build: node dist/scripts/resend-image-confirm.js ...)
 *
 * --reply BẮT BUỘC: id 1 tin nhắn có thật trong chat (vd tin yêu cầu gốc) —
 * job tạo ảnh dùng làm promptMessageId, mọi ảnh/thông báo sau đó đều reply
 * vào tin này (id 0/không tồn tại thì Telegram từ chối gửi).
 *
 * <tên> có thể là:
 * - tên file JSON (có/không đuôi .json), vd "genie_remake_1_tap10_full" —
 *   dò cả storage/generated/<file>/<file>.json lẫn
 *   storage/generated/<phim>/<file>/<file>.json (giống resolveExistingGeneratedJsonPath).
 * - tên folder phim, vd "genie_remake_1" — gửi lại cho MỌI tập trong đó.
 *
 * Lượt xác nhận được ghi vào storage/pending-image-confirmations-pollo.json —
 * bot đang chạy tự đọc lại file này khi bấm nút (xem confirmImageGenerationPollo),
 * không cần restart.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Telegram } from "telegraf";
import { config } from "../src/config";
import { loadPersistedPendingImageConfirmationsPollo } from "../src/queue";

const GENERATED_ROOT = path.resolve("./storage/generated");
const PENDING_FILE = path.resolve(
  "./storage/pending-image-confirmations-pollo.json",
);

interface PendingImageConfirmation {
  jsonPath: string;
  chatId: number;
  userId: number;
  promptMessageId: number;
}

function usage(): never {
  console.error(
    "Cách dùng: npx tsx scripts/resend-image-confirm.ts <chatId> <tên file json hoặc folder phim...> --reply <messageId> [--user <userId>]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const names: string[] = [];
  let replyTo = 0;
  let userId = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reply") replyTo = Number(argv[++i]);
    else if (arg === "--user") userId = Number(argv[++i]);
    else names.push(arg);
  }
  const chatId = Number(names.shift());
  if (!Number.isFinite(chatId) || names.length === 0) usage();
  if (!Number.isInteger(replyTo) || replyTo <= 0 || !Number.isFinite(userId))
    usage();
  return { chatId, names, replyTo, userId };
}

function isFile(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

/** Trả về danh sách path JSON khớp <tên> (rỗng nếu không thấy). */
function resolveJsonPaths(rawName: string): string[] {
  const name = rawName
    .trim()
    .replace(/ +/g, "_")
    .replace(/\.json$/i, "");

  // Rule 1: storage/generated/<file>/<file>.json
  const direct = path.join(GENERATED_ROOT, name, `${name}.json`);
  if (isFile(direct)) return [direct];

  // Rule 2: storage/generated/<phim>/<file>/<file>.json
  const filmDirs = fs.existsSync(GENERATED_ROOT)
    ? fs
        .readdirSync(GENERATED_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  for (const film of filmDirs) {
    const nested = path.join(GENERATED_ROOT, film, name, `${name}.json`);
    if (isFile(nested)) return [nested];
  }

  // Folder phim: mọi <file>/<file>.json bên trong.
  const filmDir = path.join(GENERATED_ROOT, name);
  if (fs.existsSync(filmDir) && fs.statSync(filmDir).isDirectory()) {
    return fs
      .readdirSync(filmDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(filmDir, e.name, `${e.name}.json`))
      .filter(isFile)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  return [];
}

function readPending(): [string, PendingImageConfirmation][] {
  if (!fs.existsSync(PENDING_FILE)) return [];
  return JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8"));
}

function writePending(entries: [string, PendingImageConfirmation][]): void {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

async function main(): Promise<void> {
  loadPersistedPendingImageConfirmationsPollo();

  const telegram = new Telegram(config.botToken);
  let sent = 0;
  const confirmId = "43598954-34d8-44a3-adbc-767250e1c927";
  // Ghi lượt xác nhận TRƯỚC khi gửi — gửi xong mới ghi thì user có thể bấm
  // nút trước khi file kịp có id.
  try {
    await telegram.sendMessage(
      -1004356603432,
      `Xác nhận tạo ảnh (matewithdragonlord_remake_1_tap10_full.json)`,
      {
        reply_parameters: { message_id: 3626 },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Tạo ảnh",
                callback_data: `confirmImagesPollo:${confirmId}`,
              },
            ],
          ],
        },
      },
    );
    sent++;
  } catch (err) {
    writePending(readPending().filter(([id]) => id !== confirmId));
    console.error(
      `❌ Gửi thất bại:  —`,
      err instanceof Error ? err.message : err,
    );
  }
  // Giãn cách tránh Telegram 429 khi gửi nhiều tập liên tiếp vào cùng chat.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
