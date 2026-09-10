#!/usr/bin/env bash
# Cài nvm + Node.js 24 + pm2 + Google Chrome (+ xvfb) trên Ubuntu (dùng để
# setup VPS mới trước khi deploy bot). Script idempotent — chạy lại nhiều
# lần không lỗi, không cài đè nếu đã có sẵn đúng phiên bản.
#
# Cài Google Chrome thật (không phải Chromium bundled của Playwright) vì
# launch.ts dùng channel: "chrome" (src/automation/launch.ts) để có sẵn
# codec/font/tối ưu anti-detection của Chrome chính chủ.
#
# Cách dùng:
#   bash scripts/install-node.sh
#
# Biến môi trường tuỳ chỉnh:
#   NODE_VERSION (mặc định 24)         — major version Node cần cài
#   NVM_VERSION  (mặc định v0.40.1)    — version nvm cài (release ổn định mới nhất tại thời điểm viết)
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24}"
NVM_VERSION="${NVM_VERSION:-v0.40.1}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

echo "[install-node] Cài các gói hệ thống cần thiết (curl, build-essential, xvfb...)..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  # xvfb: cung cấp lệnh xvfb-run (dùng cho "npm run start:xvfb" — chạy Chrome
  # headful trên display ảo, không cần GPU/màn hình thật).
  sudo apt-get install -y curl ca-certificates build-essential xvfb
else
  echo "[install-node] CẢNH BÁO: không tìm thấy apt-get — bỏ qua bước cài gói hệ thống, giả định đã có curl/build tools/xvfb." >&2
fi

if [ -s "$NVM_DIR/nvm.sh" ]; then
  echo "[install-node] nvm đã có sẵn tại ${NVM_DIR} — bỏ qua bước cài mới."
else
  echo "[install-node] Cài nvm ${NVM_VERSION}..."
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi

# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"

echo "[install-node] Cài Node.js ${NODE_VERSION}..."
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

echo "[install-node] Node: $(node -v), npm: $(npm -v)"

if command -v pm2 >/dev/null 2>&1; then
  echo "[install-node] pm2 đã có sẵn ($(pm2 -v)) — bỏ qua bước cài mới."
else
  echo "[install-node] Cài pm2 (global)..."
  npm install -g pm2
fi

echo "[install-node] pm2: $(pm2 -v)"

if command -v xvfb-run >/dev/null 2>&1; then
  echo "[install-node] xvfb-run: OK ($(command -v xvfb-run))"
else
  echo "[install-node] CẢNH BÁO: không tìm thấy xvfb-run — 'npm run start:xvfb' sẽ không chạy được." >&2
fi

if command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; then
  echo "[install-node] Google Chrome đã có sẵn — bỏ qua bước cài mới."
elif command -v apt-get >/dev/null 2>&1; then
  echo "[install-node] Cài Google Chrome (repo chính thức của Google)..."
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | sudo gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y google-chrome-stable
else
  echo "[install-node] CẢNH BÁO: không tìm thấy apt-get — bỏ qua bước cài Google Chrome, giả định đã có sẵn." >&2
fi

if command -v google-chrome-stable >/dev/null 2>&1; then
  echo "[install-node] Google Chrome: $(google-chrome-stable --version)"
else
  echo "[install-node] CẢNH BÁO: không tìm thấy google-chrome-stable sau khi cài — kiểm tra lại." >&2
fi

# nvm chỉ load qua ~/.bashrc/~/.profile ở shell interactive mới — nếu shell
# hiện tại (vd chạy qua "bash scripts/install-node.sh" không phải "source")
# thì PATH của shell CHA sẽ không thấy node/pm2 sau khi script thoát. Nhắc
# rõ để tránh nhầm "lệnh mới cài mà không chạy được".
cat <<'EOF'

[install-node] Xong. Nếu chạy script này bằng "bash scripts/install-node.sh"
(không phải "source scripts/install-node.sh"), mở lại shell mới (hoặc chạy
"source ~/.bashrc") để PATH nhận node/npm/pm2 vừa cài.
EOF
