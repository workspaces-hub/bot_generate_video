/**
 * KHOÁ FRAME giữa các clip liền mạch: 2 VIDEO kề nhau CÙNG shot (shot bằng
 * nhau, clip sau = clip trước + 1) là 1 cảnh quay bị chia kỹ thuật — END FRAME
 * clip trước và START FRAME clip sau phải là CÙNG MỘT mô tả (nhân vật, tư thế,
 * vị trí, hướng nhìn, đạo cụ trên tay, góc máy, ánh sáng), nếu không model gen
 * mỗi clip một kiểu → đứt mạch (xác nhận qua lỗi thật iop_remake_1_tap11:
 * cuối clip trước nhân vật nằm, đầu clip sau lại đứng).
 *
 * Code ghi đè START FRAME clip sau bằng ĐÚNG END FRAME clip trước — dùng ở
 * bước viết kịch bản (seriesScript) và ngay trước khi gen video (ComfyUI),
 * để cả JSON cũ cũng được khoá khi gen lại.
 */

/**
 * Nhãn mục CẤP CAO của VIDEO.prompt (theo cấu trúc master prompt tạo tập) —
 * chỉ chúng là ranh giới mục. Nhãn con in hoa bên trong 1 mục (CHARACTERS:,
 * POSE:, CAMERA: của khung khoá frame; MUSIC PRESENCE: trong SOUND AND
 * EDITING...) KHÔNG cắt mục. "SPEECH MODE:" khác "SPEECH:".
 */
const TOP_LABELS = [
  "CLIP SPEC",
  "CAST AND VOICE",
  "START FRAME",
  "ACTION AND PERFORMANCE",
  "SPEECH",
  "SOUND AND EDITING",
  "END FRAME",
  "CONTINUITY FRAME",
  "CONTINUITY",
  "SOURCE SHOTS",
  "ANALYSIS ONLY",
];

/** Vị trí "LABEL:" đứng ở đầu chuỗi hoặc sau khoảng trắng/dấu câu, từ `from`. */
function findLabel(prompt: string, label: string, from = 0): number {
  const re = new RegExp(`(^|[\\s.;])${label.replace(/ /g, "\\s+")}:`, "g");
  re.lastIndex = from;
  const m = re.exec(prompt);
  return m ? m.index + m[1].length : -1;
}

/** Vị trí nội dung của mục `label` (sau "LABEL:" tới nhãn cấp cao kế tiếp), null nếu không có. */
function sectionRange(prompt: string, label: string): { start: number; end: number } | null {
  const at = findLabel(prompt, label);
  if (at < 0) return null;
  const start = prompt.indexOf(":", at) + 1;
  const ends = TOP_LABELS.map((l) => findLabel(prompt, l, start)).filter((i) => i >= 0);
  return { start, end: ends.length ? Math.min(...ends) : prompt.length };
}

export function getPromptSection(prompt: string, label: string): string | null {
  const r = sectionRange(prompt, label);
  return r ? prompt.slice(r.start, r.end).trim() : null;
}

/** Ghi đè nội dung mục `label`; chưa có mục thì chèn trước `before` (hoặc cuối prompt). */
export function setPromptSection(prompt: string, label: string, content: string, before = "ACTION AND PERFORMANCE"): string {
  const r = sectionRange(prompt, label);
  if (r) return `${prompt.slice(0, r.start)} ${content} ${prompt.slice(r.end).replace(/^\s+/, "")}`.replace(/ +\n/g, "\n");
  const insertAt = findLabel(prompt, before);
  const block = `${label}: ${content} `;
  return insertAt >= 0 ? `${prompt.slice(0, insertAt)}${block}${prompt.slice(insertAt)}` : `${prompt}\n${block}`;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

interface FrameLockVideo {
  id?: unknown;
  type?: unknown;
  shot?: unknown;
  clip?: unknown;
  prompt?: unknown;
}

/** Clip sau có phải phần nối tiếp liền mạch của clip trước (cùng shot, clip kế tiếp). */
export function isContinuation(prev: FrameLockVideo, next: FrameLockVideo): boolean {
  return Number(prev.shot) === Number(next.shot) && Number(next.clip) === Number(prev.clip) + 1;
}

/**
 * Khoá START FRAME = END FRAME clip trước cho mọi cặp liền mạch trong danh
 * sách VIDEO (theo thứ tự). Sửa TẠI CHỖ prompt; trả về id các VIDEO đã sửa.
 */
export function lockContinuousFrames(entries: FrameLockVideo[]): string[] {
  const videos = entries.filter((e) => e && e.type === "VIDEO" && typeof e.prompt === "string");
  const changed: string[] = [];
  for (let i = 1; i < videos.length; i++) {
    const [prev, next] = [videos[i - 1], videos[i]];
    if (!isContinuation(prev, next)) continue;
    const end = getPromptSection(String(prev.prompt), "END FRAME");
    if (!end) continue;
    const start = getPromptSection(String(next.prompt), "START FRAME");
    if (start !== null && norm(start) === norm(end)) continue;
    next.prompt = setPromptSection(String(next.prompt), "START FRAME", end);
    changed.push(String(next.id));
  }
  return changed;
}
