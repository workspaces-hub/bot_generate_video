#!/usr/bin/env bash
# Deploy code mới nhất lên VPS đang chạy bot — CHẠY TRỰC TIẾP TRÊN VPS (trong
# thư mục repo, vd /root/work/bot_generate_video), KHÔNG chạy từ máy dev.
#
# Theo yêu cầu người dùng: rất nhiều "bug mới" báo trong quá trình dev hoá ra
# CHỈ là bug ĐÃ SỬA từ trước nhưng VPS chưa được deploy code mới (xác nhận
# qua log thật: production vẫn throw lỗi từ insertMentionForFile dù hàm này
# đã bị disable trong source từ commit 0f9580c5) — script này gộp lại đúng
# thứ tự bước deploy để tránh quên bước nào.
#
# Cách dùng (trên VPS):
#   bash scripts/deploy.sh
#
# Biến môi trường tuỳ chỉnh:
#   PM2_APP_NAME (mặc định "bot_generate", khớp pm2.bot.config.js)
#   PM2_CONFIG   (mặc định "pm2.bot.config.js")
set -euo pipefail

PM2_APP_NAME="${PM2_APP_NAME:-bot_generate}"
PM2_CONFIG="${PM2_CONFIG:-pm2.bot.config.js}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[deploy] Kiểm tra working tree..."
if [ -n "$(git status --porcelain)" ]; then
  echo "[deploy] LỖI: có thay đổi chưa commit/chưa stash trên VPS — dừng lại để tránh mất dữ liệu." >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "[deploy] Branch hiện tại: ${CURRENT_BRANCH}"

echo "[deploy] git pull..."
git pull --ff-only origin "$CURRENT_BRANCH"

echo "[deploy] Cài lại dependencies (npm ci)..."
npm ci

echo "[deploy] Build TypeScript..."
npm run build

echo "[deploy] Reload pm2 (${PM2_APP_NAME})..."
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  # reload (không phải restart) — giữ pm2 quản lý đúng 1 process, tránh tạo
  # thêm process trùng tên nếu gọi lại script nhiều lần.
  pm2 reload "$PM2_APP_NAME"
else
  echo "[deploy] Chưa có process '${PM2_APP_NAME}' trong pm2 — khởi động mới từ ${PM2_CONFIG}."
  pm2 start "$PM2_CONFIG"
fi

pm2 save

echo "[deploy] Dọn debug snapshot cũ (storage/debug)..."
find storage/debug -type f -delete 2>/dev/null || true

echo "[deploy] Dọn log pm2 cũ (${PM2_APP_NAME})..."
pm2 flush "$PM2_APP_NAME"

echo "[deploy] Xong. Xem log: pm2 logs ${PM2_APP_NAME}"
