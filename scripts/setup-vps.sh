#!/usr/bin/env bash
# Cài đặt TOÀN BỘ môi trường cần thiết để chạy bot trên 1 VPS Ubuntu 24 MỚI —
# chạy SAU khi đã `git clone` repo về VPS, TRƯỚC lần deploy/khởi động đầu
# tiên. Các lần deploy SAU dùng scripts/deploy.sh, không phải script này.
#
# Gồm 4 bước:
# 1. Gói hệ thống + Node.js + pm2 + Google Chrome + xvfb — dùng lại
#    scripts/install-node.sh bằng "source" (không phải chạy subprocess), để
#    nvm/node/npm/pm2 vừa cài dùng được NGAY trong các bước sau của CHÍNH
#    script này (chạy bằng "bash" thường thì shell cha sẽ không thấy PATH
#    vừa đổi — xem chú thích cuối install-node.sh).
# 2. Cài dependencies của project (npm ci).
# 3. Cài Playwright Chromium + thư viện hệ thống Linux cần thiết
#    (--with-deps) — cần khi BROWSER_CHANNEL=chromium, khuyến nghị cho VPS
#    chỉ tái sử dụng session đã đăng nhập sẵn (xem .env.example). Không hại
#    gì nếu cuối cùng dùng BROWSER_CHANNEL=chrome (Google Chrome thật, đã cài
#    ở bước 1).
# 4. Tạo sẵn các thư mục storage/ cần thiết + tạo .env từ .env.example nếu
#    chưa có (KHÔNG ghi đè .env đã có sẵn).
#
# Cách dùng (trên VPS, sau khi git clone xong):
#   cd bot_generate_video && bash scripts/setup-vps.sh
#
# Idempotent — chạy lại nhiều lần không lỗi, không cài đè/ghi đè nếu đã có
# sẵn đúng thứ cần.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f package.json ] || ! grep -q '"name": "ai-video-telegram-bot"' package.json; then
  echo "[setup-vps] LỖI: không thấy package.json của project — script phải chạy TỪ TRONG repo đã git clone (vd: cd bot_generate_video && bash scripts/setup-vps.sh)." >&2
  exit 1
fi

echo "=== [1/4] Gói hệ thống + Node.js + pm2 + Chrome + xvfb ==="
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/install-node.sh"

echo
echo "=== [2/4] Cài dependencies project (npm ci) ==="
npm ci

echo
echo "=== [3/4] Cài Playwright Chromium + thư viện hệ thống cần thiết ==="
npx playwright install --with-deps chromium

echo
echo "=== [4/4] Thư mục storage/ + file .env ==="
mkdir -p storage/downloads storage/uploads storage/chrome-tmp storage/debug \
  storage/chatai-results storage/generated storage/reference-images
echo "[setup-vps] Đã tạo/xác nhận các thư mục storage/ cần thiết."

if [ -f .env ]; then
  echo "[setup-vps] .env đã có sẵn — bỏ qua, KHÔNG ghi đè."
else
  cp .env.example .env
  echo "[setup-vps] Đã tạo .env từ .env.example — BẮT BUỘC điền các giá trị trống (BOT_TOKEN, GROUP_CHAT_ID, ADMINS, PROXY_SERVER nếu có...) trước khi chạy bot."
fi

cat <<'EOF'

[setup-vps] Xong phần cài môi trường. Các bước tiếp theo:

  1. Điền đầy đủ .env (BOT_TOKEN, GROUP_CHAT_ID, ADMINS, PROXY_SERVER nếu có...).

  2. Mở lại shell mới (để PATH nhận node/npm/pm2 vừa cài), rồi đăng nhập
     từng dịch vụ cần dùng:
       npm run login              # AIVideo, hàng đợi video
       npm run login -- image     # AIVideo, hàng đợi ảnh (tài khoản KHÁC)
       npm run login-chatai
       npm run login-chatai -- revise
       npm run login-pollo
     Nếu VPS không có màn hình/GUI để xem trình duyệt lúc đăng nhập, đăng
     nhập trên máy có GUI trước rồi copy các file storage/*.json (session)
     sang VPS, hoặc dùng "npm run start:novnc" để đăng nhập qua VNC.

  3. Build + khởi động qua pm2:
       npm run build
       pm2 start pm2.bot.config.js
       pm2 save
     Các lần deploy SAU dùng "bash scripts/deploy.sh", không phải bước này.
EOF
