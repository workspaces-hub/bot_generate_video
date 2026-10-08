#!/usr/bin/env python3
"""
Worker xử lý video cho pipeline "Remake phim" (src/film/). CHỈ dùng stdlib +
ffmpeg — không cần pip install. Riêng lệnh `transcribe` cần faster-whisper
(tuỳ chọn): không có thì trả {"available": false}, pipeline vẫn chạy (Gemini
tự nghe thoại).

Mọi lệnh in ĐÚNG 1 JSON ra stdout; lỗi → exit code khác 0 + thông báo ở stderr.

  scenes     --video P [--threshold 0.3]
      → {"duration": float, "cuts": [float, ...]}   (giây, tính từ đầu clip)
  boundary   --a P --b P [--window 8] [--fps 4]
      → {"overlap": float, "overlapScore": float, "continuity": float}
        overlap   : số giây đầu clip B lặp lại đuôi clip A (0 nếu không có)
        continuity: 0..1, độ giống khung cuối A với khung đầu B (sau khi trim)
  transcribe --video P [--model small] [--language vi]
      → {"available": bool, "segments": [{"start","end","text"}], "language"}
"""
import argparse
import json
import re
import subprocess
import sys

THUMB = 16  # khung thu nhỏ 16x16 xám — đủ để so khớp, đủ nhẹ cho Python thuần
FRAME_BYTES = THUMB * THUMB


def run(cmd):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} lỗi ({proc.returncode}): {proc.stderr.decode('utf-8', 'replace')[-800:]}"
        )
    return proc


def probe_duration(path):
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ]).stdout.decode().strip()
    return float(out)


def scenes(path, threshold):
    # showinfo in pts_time của các khung vượt ngưỡng đổi cảnh ra stderr.
    proc = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-an", "-f", "null", "-",
    ])
    cuts = [float(m) for m in re.findall(r"pts_time:([0-9.]+)", proc.stderr.decode("utf-8", "replace"))]
    return {"duration": probe_duration(path), "cuts": sorted(set(round(c, 3) for c in cuts))}


def thumbs(path, fps, head=None, tail=None):
    """Khung 16x16 xám của `head` giây đầu hoặc `tail` giây cuối."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if tail is not None:
        cmd += ["-sseof", f"-{tail}"]
    cmd += ["-i", path]
    if head is not None:
        cmd += ["-t", str(head)]
    cmd += ["-vf", f"fps={fps},scale={THUMB}:{THUMB},format=gray", "-f", "rawvideo", "-"]
    raw = run(cmd).stdout
    return [raw[i:i + FRAME_BYTES] for i in range(0, len(raw) - FRAME_BYTES + 1, FRAME_BYTES)]


def frame_diff(a, b):
    """Sai khác trung bình 0..1, đã trừ độ sáng trung bình (chịu được fade/đổi exposure nhẹ)."""
    ma = sum(a) / FRAME_BYTES
    mb = sum(b) / FRAME_BYTES
    return sum(abs((x - ma) - (y - mb)) for x, y in zip(a, b)) / (FRAME_BYTES * 255.0)


def boundary(a_path, b_path, window, fps):
    a_tail = thumbs(a_path, fps, tail=window)
    b_head = thumbs(b_path, fps, head=window)
    if not a_tail or not b_head:
        return {"overlap": 0.0, "overlapScore": 0.0, "continuity": 0.0}

    # Tìm vị trí i trong đuôi A mà B bắt đầu lặp lại: so chuỗi A[i:] với
    # B[0:len]. Cần ít nhất 2 khung (0.5s ở 4fps) để tránh trùng ngẫu nhiên.
    best_i, best_diff = None, 1.0
    for i in range(len(a_tail) - 1):
        n = min(len(a_tail) - i, len(b_head))
        if n < 2:
            continue
        d = sum(frame_diff(a_tail[i + k], b_head[k]) for k in range(n)) / n
        if d < best_diff:
            best_i, best_diff = i, d
    overlap_score = max(0.0, 1.0 - best_diff * 6)  # diff 0 → 1.0, diff ≥ 0.167 → 0
    overlap = 0.0
    if best_i is not None and best_diff < 0.04:
        overlap = round((len(a_tail) - best_i) / fps, 3)

    # Độ liền mạch: khung cuối A so với khung đầu B SAU khi bỏ phần lặp.
    skip = int(round(overlap * fps))
    b_first = b_head[min(skip, len(b_head) - 1)]
    continuity = max(0.0, 1.0 - frame_diff(a_tail[-1], b_first) * 4)
    return {
        "overlap": overlap,
        "overlapScore": round(overlap_score, 3),
        "continuity": round(continuity, 3),
    }


def transcribe(path, model_name, language):
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        return {"available": False, "segments": [], "language": None}
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    # word_timestamps: khung segment của Whisper hay nuốt cả khoảng lặng/nhạc
    # phía trước (vd câu 3s mà segment 94→123s) → lấy mốc từ đầu/từ cuối thật.
    segments, info = model.transcribe(
        path, language=language or None, vad_filter=True, word_timestamps=True
    )
    out = []
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        words = [w for w in (s.words or []) if w.word.strip()]
        start = words[0].start if words else s.start
        end = words[-1].end if words else s.end
        out.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    return {"available": True, "language": info.language, "segments": out}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scenes")
    p.add_argument("--video", required=True)
    p.add_argument("--threshold", type=float, default=0.3)
    p = sub.add_parser("boundary")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--window", type=float, default=8)
    p.add_argument("--fps", type=float, default=4)
    p = sub.add_parser("transcribe")
    p.add_argument("--video", required=True)
    p.add_argument("--model", default="small")
    p.add_argument("--language", default="")
    args = parser.parse_args()

    if args.cmd == "scenes":
        result = scenes(args.video, args.threshold)
    elif args.cmd == "boundary":
        result = boundary(args.a, args.b, args.window, args.fps)
    else:
        result = transcribe(args.video, args.model, args.language)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — báo lỗi gọn cho Node
        print(str(exc), file=sys.stderr)
        sys.exit(1)
