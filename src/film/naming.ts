/**
 * Tên file clip nguồn chứa tên phim + số tập, nhiều kiểu viết:
 *   "02_aladinhusband.mp4", "aladinhusband_02.mp4", "aladinhusband tap 2.mp4",
 *   "aladinhusband-ep02.mp4", "Aladin Husband E2.mp4"
 * Số tập quyết định thứ tự clip (KHÔNG dựa vào thứ tự gửi — Telegram có thể
 * giao album lộn thứ tự) và để phát hiện thiếu/trùng tập trước khi chạy.
 */
import path from "node:path";

export interface ParsedClipName {
  /** Số tập, null nếu tên không có số tập. */
  episode: number | null;
  /** Phần tên phim còn lại (chưa chuẩn hoá). */
  title: string;
}

const SEP = "[\\s._-]";

export function parseClipFileName(fileName: string): ParsedClipName {
  // NFC: macOS lưu tên file tiếng Việt dạng tách dấu (NFD) — "ậ" thành "a" + dấu.
  const base = path.basename(fileName.normalize("NFC"), path.extname(fileName)).trim();
  const clean = (s: string) => s.replace(new RegExp(`^${SEP}+|${SEP}+$`, "g"), "");
  // 1. Có từ khoá tập: "tap 2", "tập02", "ep03", "episode 4", "E05", "part 6".
  const keyword = base.match(new RegExp(`(^|${SEP})(?:t[aậ]p|ep(?:isode)?|e|part)${SEP}*(\\d{1,4})(?=$|${SEP})`, "i"));
  if (keyword && keyword.index !== undefined) {
    const title = clean(base.slice(0, keyword.index) + base.slice(keyword.index + keyword[0].length));
    return { episode: Number(keyword[2]), title };
  }
  // 2. Số đứng đầu: "02_aladinhusband".
  const leading = base.match(new RegExp(`^(\\d{1,4})${SEP}+(.+)$`));
  if (leading) return { episode: Number(leading[1]), title: clean(leading[2]) };
  // 3. Số đứng cuối: "aladinhusband_02".
  const trailing = base.match(new RegExp(`^(.+?)${SEP}+(\\d{1,4})$`));
  if (trailing) return { episode: Number(trailing[2]), title: clean(trailing[1]) };
  return { episode: null, title: base };
}

/** Tên phim → id thư mục: bỏ dấu tiếng Việt, chỉ giữ chữ/số/_/-. */
export function normalizeFilmId(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 60);
}

/** Tên phim trong tên file có khớp phim đang nhận không (so sau chuẩn hoá, bỏ _/-). */
export function sameFilm(title: string, filmId: string): boolean {
  const key = (s: string) => normalizeFilmId(s).toLowerCase().replace(/[_-]/g, "");
  const a = key(title);
  const b = key(filmId);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}
