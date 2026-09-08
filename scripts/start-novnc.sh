#!/usr/bin/env bash
# Chạy bot với browser hiện trên 1 display ảo (Xvfb) CỐ ĐỊNH, kèm x11vnc +
# noVNC để xem trực tiếp qua trình duyệt (http://<ip-vps>:<NOVNC_PORT>/vnc.html)
# — hữu ích để quan sát trực quan lúc debug (picker, composer, cookie banner...)
# thay vì chỉ đọc log/screenshot debug rời rạc.
#
# Khác `npm run start:xvfb` (dùng xvfb-run): xvfb-run tự chọn display ngẫu
# nhiên và huỷ display đó ngay khi process con thoát — không có gì cố định để
# x11vnc trỏ vào. Script này tự quản Xvfb trên display CỐ ĐỊNH để gắn VNC được.
#
# Cần cài sẵn 1 lần trên VPS (KHÔNG tự cài trong script này):
#   apt-get install -y xvfb x11vnc novnc websockify
#
# Yêu cầu HEADLESS=false trong .env (browser thật mới có gì để xem qua VNC).
#
# Biến môi trường tuỳ chỉnh (đều có default hợp lý):
#   DISPLAY_NUM   (mặc định 1)    — số hiệu display Xvfb (:1, khớp display bot
#                                    đang dùng — xem "chạy bot qua display :1").
#                                    Nếu display này ĐÃ CÓ Xvfb chạy sẵn, script
#                                    tự phát hiện và dùng lại (không tạo thêm
#                                    display mới, không kill khi thoát).
#   VNC_PORT      (mặc định 5900) — port VNC thật (x11vnc)
#   NOVNC_PORT    (mặc định 6080) — port HTTP noVNC (xem qua trình duyệt)
#   VNC_PASSWORD  (mặc định rỗng) — để trống = không mật khẩu (-nopw). CHỈ để
#                                    trống nếu port không lộ ra Internet (vd
#                                    sau firewall, hoặc chỉ truy cập qua SSH
#                                    tunnel/VPN) — có mật khẩu thì set biến
#                                    này trước khi chạy.
#   NOVNC_DIR     (tự dò)         — thư mục cài noVNC, override nếu khác chuẩn
#                                    (/usr/share/novnc).
#   SCREEN_ARGS   (mặc định "1920x1080x24") — độ phân giải/độ sâu màu Xvfb.
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-1}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
SCREEN_ARGS="${SCREEN_ARGS:-1920x1080x24}"

export DISPLAY=":${DISPLAY_NUM}"

for bin in Xvfb x11vnc; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[start-novnc] LỖI: chưa cài '$bin'. Cài trước: apt-get install -y xvfb x11vnc novnc websockify" >&2
    exit 1
  fi
done

PIDS=()
STARTED_XVFB=0
cleanup() {
  echo "[start-novnc] Dọn dẹp tiến trình nền..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  # CHỈ xoá lock nếu chính script này đã khởi động Xvfb — nếu display :1 là
  # của process khác (đã có sẵn từ trước), xoá lock ở đây sẽ phá luôn display
  # đang được process đó dùng.
  if [ "$STARTED_XVFB" = "1" ]; then
    rm -f "/tmp/.X${DISPLAY_NUM}-lock"
  fi
}
trap cleanup EXIT INT TERM

# Dọn lock cũ nếu Xvfb trước đó bị kill không sạch (SIGKILL, crash VPS...) —
# không thì Xvfb báo "Server is already active" dù không còn process nào
# thật đang giữ display.
if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ] && ! pgrep -f "Xvfb :${DISPLAY_NUM} " >/dev/null 2>&1; then
  echo "[start-novnc] Xoá lock file cũ của display :${DISPLAY_NUM} (không có Xvfb nào đang giữ)."
  rm -f "/tmp/.X${DISPLAY_NUM}-lock"
fi

# Display :1 thường ĐÃ CÓ Xvfb chạy sẵn (bot vẫn dùng chung display này từ
# trước) — dò trước bằng pgrep, chỉ tự khởi động Xvfb mới nếu chưa có. QUAN
# TRỌNG: không thêm PID vào mảng cleanup nếu KHÔNG tự khởi động — script này
# không được phép kill display của process khác lúc thoát.
if pgrep -f "Xvfb :${DISPLAY_NUM} " >/dev/null 2>&1 || [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "[start-novnc] Display :${DISPLAY_NUM} đã có Xvfb chạy sẵn — dùng lại, không tạo mới."
else
  echo "[start-novnc] Khởi động Xvfb trên :${DISPLAY_NUM} (${SCREEN_ARGS})..."
  Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN_ARGS}" -dpi 96 +extension RANDR +extension GLX +render &
  PIDS+=("$!")
  STARTED_XVFB=1
  sleep 1
fi

if pgrep -f "x11vnc.*-rfbport ${VNC_PORT}\b" >/dev/null 2>&1 || (command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${VNC_PORT}" 2>/dev/null | grep -q LISTEN); then
  echo "[start-novnc] Đã có VNC server chạy sẵn trên port ${VNC_PORT} — dùng lại, không tạo mới."
else
  echo "[start-novnc] Khởi động x11vnc (port ${VNC_PORT})..."
  if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display ":${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -passwd "${VNC_PASSWORD}" -forever -shared -noxdamage -quiet &
  else
    echo "[start-novnc] CẢNH BÁO: VNC_PASSWORD trống — không mật khẩu, chỉ an toàn nếu port ${VNC_PORT}/${NOVNC_PORT} không lộ ra Internet." >&2
    x11vnc -display ":${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -nopw -forever -shared -noxdamage -quiet &
  fi
  PIDS+=("$!")
  sleep 1
fi

echo "[start-novnc] Khởi động noVNC (http://<ip-vps>:${NOVNC_PORT}/vnc.html)..."
NOVNC_DIR="${NOVNC_DIR:-}"
if [ -z "$NOVNC_DIR" ]; then
  for candidate in /usr/share/novnc /usr/share/webapps/novnc /opt/novnc "$HOME/novnc"; do
    if [ -d "$candidate" ]; then
      NOVNC_DIR="$candidate"
      break
    fi
  done
fi

if [ -n "$NOVNC_DIR" ] && [ -x "${NOVNC_DIR}/utils/novnc_proxy" ]; then
  "${NOVNC_DIR}/utils/novnc_proxy" --vnc "localhost:${VNC_PORT}" --listen "${NOVNC_PORT}" &
  PIDS+=("$!")
elif [ -n "$NOVNC_DIR" ] && command -v websockify >/dev/null 2>&1; then
  websockify --web "${NOVNC_DIR}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
  PIDS+=("$!")
elif command -v websockify >/dev/null 2>&1; then
  echo "[start-novnc] CẢNH BÁO: không tìm thấy thư mục static files của noVNC — chỉ chạy websocket proxy, không có giao diện /vnc.html. Cài: apt-get install -y novnc" >&2
  websockify "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
  PIDS+=("$!")
else
  echo "[start-novnc] LỖI: chưa cài websockify/novnc. Cài trước: apt-get install -y novnc websockify" >&2
  exit 1
fi
sleep 1

echo "[start-novnc] Sẵn sàng — xem trực tiếp tại http://<ip-vps>:${NOVNC_PORT}/vnc.html"
echo "[start-novnc] Khởi động bot (node dist/src/index.js)..."
node dist/src/index.js &
BOT_PID="$!"
PIDS+=("$BOT_PID")

wait "$BOT_PID"
