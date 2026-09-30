import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config";

/**
 * SỬA (xác nhận qua lỗi thật: OpenRouter trả 413 Request Entity Too Large
 * khi nhúng video base64 inline vào request — xem docstring qwenPublicBaseUrl
 * trong config.ts): OpenRouter cần TẢI video từ 1 URL công khai thay vì nhận
 * base64 trực tiếp. Dựng 1 static file server TỐI GIẢN ngay trong process bot
 * (không thêm dependency ngoài — chỉ dùng module "http" có sẵn của Node),
 * phục vụ ĐÚNG các file được publishFileTemporarily() copy vào
 * config.qwenFileServeDir, xoá ngay sau khi OpenRouter đã tải xong (gọi
 * cleanup() ở nơi gọi, xem qwenAI.ts).
 *
 * Bảo mật: server này KHÔNG có xác thực — bất kỳ ai biết đúng URL (tên file
 * là jobId, khó đoán) trong lúc file còn tồn tại đều tải được. Cửa sổ lộ rất
 * ngắn (chỉ tồn tại từ lúc publish tới lúc OpenRouter tải xong + cleanup), và
 * chỉ phục vụ ĐÚNG file trong config.qwenFileServeDir (chặn path traversal
 * qua path.relative — xem isPathInsideServeDir), không lộ thư mục khác.
 */

const SERVE_DIR = config.qwenFileServeDir;

let serverReadyPromise: Promise<http.Server> | null = null;

const EXTENSION_TO_CONTENT_TYPE: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function isPathInsideServeDir(filePath: string): boolean {
  const relative = path.relative(SERVE_DIR, filePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function ensureServer(): Promise<http.Server> {
  if (serverReadyPromise) return serverReadyPromise;
  serverReadyPromise = new Promise((resolve, reject) => {
    fs.mkdirSync(SERVE_DIR, { recursive: true });
    const server = http.createServer((req, res) => {
      const requestedName = path.basename(
        decodeURIComponent((req.url ?? "").split("?")[0] ?? ""),
      );
      const filePath = path.join(SERVE_DIR, requestedName);
      // SỬA (chẩn đoán lỗi thật "Download multimodal file timed out" —
      // OpenRouter/Qwen nhận request nhưng không tải xong file): log MỌI
      // request thực sự tới được server này (kèm IP nguồn) — nếu log này
      // KHÔNG xuất hiện ở lần chạy tiếp theo, nghĩa là request từ
      // OpenRouter/Qwen chưa bao giờ chạm tới VPS (firewall/security group
      // chặn port QWEN_FILE_SERVER_PORT), không phải do tốc độ mạng.
      console.log(
        `[qwenFileServer] Request đến: ${req.method} ${req.url} từ ${req.socket.remoteAddress}`,
      );
      if (!isPathInsideServeDir(filePath)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          console.log(
            `[qwenFileServer] 404 — không tìm thấy "${filePath}".`,
          );
          res.writeHead(404);
          res.end();
          return;
        }
        const contentType =
          EXTENSION_TO_CONTENT_TYPE[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": stat.size,
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        const startedAt = Date.now();
        res.on("finish", () => {
          console.log(
            `[qwenFileServer] Đã gửi xong "${filePath}" (${stat.size} bytes) trong ${Date.now() - startedAt}ms.`,
          );
        });
        req.on("aborted", () => {
          console.log(
            `[qwenFileServer] Request bị HUỶ GIỮA CHỪNG (client đóng kết nối sớm) — "${filePath}", sau ${Date.now() - startedAt}ms.`,
          );
        });
      });
    });
    server.on("error", (err) => {
      serverReadyPromise = null;
      reject(err);
    });
    server.listen(config.qwenFileServerPort, () => {
      console.log(
        `[qwenFileServer] Đang lắng nghe port ${config.qwenFileServerPort}, phục vụ từ "${SERVE_DIR}".`,
      );
      resolve(server);
    });
  });
  return serverReadyPromise;
}

/**
 * Khởi động server NGAY LÚC BOT BOOT (index.ts) thay vì chỉ lazy đợi lần đầu
 * publishFileTemporarily() được gọi — xác nhận qua sự cố thật: link "Nối
 * video" (MERGE_VIDEO_BUTTON_LABEL, publishFileTemporarily KHÔNG cleanup nên
 * file tồn tại lâu dài trong config.qwenFileServeDir) gửi cho user rồi bị
 * BÁO KHÔNG DÙNG ĐƯỢC — vì `npm run dev` chạy bằng `tsx watch`, MỌI lần sửa
 * code đều tự restart process, giết server HTTP đang chạy trong RAM, dù file
 * .mp4 vẫn còn NGUYÊN trên đĩa — server cũ mất, chưa có publish nào chạy lại
 * trong lần process mới nên KHÔNG có gì lắng nghe port nữa (xác nhận qua
 * `lsof -iTCP:<port>` rỗng). Gọi hàm này lúc boot để server luôn sẵn sàng
 * SUỐT vòng đời process, không phụ thuộc đã có ai gọi publishFileTemporarily
 * lần nào trong lần chạy này chưa — mọi file publish từ TRƯỚC (còn nằm trong
 * SERVE_DIR) tự phục vụ lại được ngay. Best-effort: bỏ qua nếu thiếu
 * QWEN_PUBLIC_BASE_URL (tính năng OpenRouT/Nối video không dùng), chỉ log lỗi
 * nếu port đã bị chiếm — KHÔNG throw, không được làm crash cả bot vì tính
 * năng phụ này.
 */
export function startQwenFileServerEagerly(): void {
  if (!config.qwenPublicBaseUrl) return;
  ensureServer().catch((err) => {
    console.error(
      `[qwenFileServer] Không khởi động được server lúc boot (port ${config.qwenFileServerPort}):`,
      err,
    );
  });
}

/**
 * Copy `localPath` vào config.qwenFileServeDir dưới tên `publicFileName`,
 * khởi động server (nếu chưa chạy) rồi trả về URL công khai (ghép với
 * config.qwenPublicBaseUrl) + hàm cleanup() để xoá file tạm này — GỌI
 * cleanup() ngay sau khi dùng xong (thành công hay lỗi đều phải gọi, xem
 * try/finally ở qwenAI.ts) để giảm tối đa thời gian file lộ công khai.
 */
export async function publishFileTemporarily(
  localPath: string,
  publicFileName: string,
): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!config.qwenPublicBaseUrl) {
    throw new Error(
      'Thiếu QWEN_PUBLIC_BASE_URL trong .env — cần URL công khai trỏ tới VPS đang chạy bot (vd "http://<ip-vps>:8787") để OpenRouter tải được video.',
    );
  }
  await ensureServer();
  const destPath = path.join(SERVE_DIR, publicFileName);
  await fs.promises.copyFile(localPath, destPath);
  const url = `${config.qwenPublicBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(publicFileName)}`;
  return {
    url,
    cleanup: async () => {
      await fs.promises.unlink(destPath).catch(() => {});
    },
  };
}
