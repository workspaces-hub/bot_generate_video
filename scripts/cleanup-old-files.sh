#!/usr/bin/env bash
# Xoá các file thường (không phải thư mục) cũ hơn N giờ trong 1 thư mục chỉ định.
# Viết cho việc dọn output/ của ComfyUI trên RunPod (tránh lỗi "Disk quota
# exceeded" khi ổ đĩa đầy dần vì bot chỉ tải file về mà không xoá bản gốc
# trên server — xem output/video, output/image, ...).
#
# Mặc định chạy DRY-RUN (chỉ liệt kê, KHÔNG xoá) để an toàn khi chạy tay lần
# đầu. Thêm --force để thực sự xoá. Dùng cho cron để tự động dọn định kỳ.
#
# Cách dùng:
#   ./cleanup-old-files.sh <thư-mục> [--hours N] [--force]
#
# Ví dụ:
#   ./cleanup-old-files.sh /workspace/runpod-slim/ComfyUI/output --hours 4 --force
#
# Cron mỗi giờ (dọn file cũ hơn 4h, log ra file):
#   0 * * * * /path/to/cleanup-old-files.sh /workspace/runpod-slim/ComfyUI/output --hours 4 --force >> /var/log/cleanup-comfyui.log 2>&1

set -euo pipefail

TARGET_DIR=""
HOURS=4
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)
      HOURS="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      if [[ -z "$TARGET_DIR" ]]; then
        TARGET_DIR="$1"
      else
        echo "Tham số không hợp lệ: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$TARGET_DIR" ]]; then
  echo "Thiếu thư mục đích." >&2
  echo "Cách dùng: $0 <thư-mục> [--hours N] [--force]" >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Thư mục không tồn tại: $TARGET_DIR" >&2
  exit 1
fi

# Chặn chạy nhầm vào thư mục gốc hệ thống hoặc thư mục rỗng chuỗi.
case "$TARGET_DIR" in
  "/" | "" | "/root" | "/home" | "/etc" | "/usr" | "/var")
    echo "Từ chối chạy trên thư mục nhạy cảm: $TARGET_DIR" >&2
    exit 1
    ;;
esac

MINUTES=$((HOURS * 60))
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

echo "[$TIMESTAMP] Quét \"$TARGET_DIR\" — file cũ hơn ${HOURS}h (mode=$([[ "$FORCE" == true ]] && echo XOÁ || echo DRY-RUN))"

TOTAL_COUNT=0
TOTAL_BYTES=0

while IFS= read -r -d '' file; do
  SIZE=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo 0)
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + SIZE))

  if [[ "$FORCE" == true ]]; then
    rm -f -- "$file"
    echo "  ĐÃ XOÁ: $file (${SIZE} bytes)"
  else
    echo "  SẼ XOÁ: $file (${SIZE} bytes)"
  fi
done < <(find "$TARGET_DIR" -mindepth 1 -type f -mmin "+${MINUTES}" -print0)

TOTAL_MB=$((TOTAL_BYTES / 1024 / 1024))
if [[ "$FORCE" == true ]]; then
  echo "[$TIMESTAMP] Xong. Tổng: ${TOTAL_COUNT} file, ~${TOTAL_MB} MB đã giải phóng."
else
  echo "[$TIMESTAMP] Xong (DRY-RUN). Tổng: ${TOTAL_COUNT} file, ~${TOTAL_MB} MB sẽ được giải phóng nếu chạy lại với --force."
fi
