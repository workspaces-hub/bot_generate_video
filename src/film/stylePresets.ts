/**
 * Từ khoá phong cách gõ nhanh cho yêu cầu riêng của bản remake ("Remake phim"
 * dòng 2+, "Test prompt remake phim" sau "xong"). Dòng nào đúng bằng từ khoá
 * thì được mở rộng thành mô tả đầy đủ; dòng khác giữ nguyên (ghi chú tự do
 * vẫn dùng được, vd "phương tây\nnữ chính là luật sư").
 */
/**
 * text: chế độ ĐỔI THẾ GIỚI (cả thế giới theo phong cách). faithful: chế độ
 * GIỐNG GỐC — bối cảnh giữ nguyên, phong cách CHỈ áp cho nhân vật mới.
 */
const PRESETS: { keys: string[]; label: string; text: string; faithful: string }[] = [
  {
    keys: ["phuong tay", "tay", "western", "au my", "west"],
    label: "phương Tây",
    faithful:
      "NHÂN VẬT PHONG CÁCH PHƯƠNG TÂY: mọi nhân vật mới là người phương Tây (Âu–Mỹ) — tên tiếng Anh/châu Âu, gương mặt, tóc, vóc dáng kiểu phương Tây. Bối cảnh, đạo cụ, câu chuyện, hành động GIỮ NGUYÊN như phim gốc.",
    text: "PHONG CÁCH PHƯƠNG TÂY: thế giới, bối cảnh, kiến trúc, trang phục, phong tục và nghề nghiệp kiểu Âu–Mỹ (hiện đại hoặc cổ điển châu Âu tuỳ DNA tập gốc); nhân vật người phương Tây với tên tiếng Anh/châu Âu; quan hệ quyền lực theo mô hình phương Tây (tập đoàn, gia tộc quý tộc, toà án, cảnh sát, hội đồng quản trị...); lời thoại và cách ứng xử tự nhiên kiểu phương Tây.",
  },
  {
    keys: ["phuong dong", "dong", "eastern", "chau a", "east", "asian"],
    label: "phương Đông",
    faithful:
      "NHÂN VẬT PHONG CÁCH PHƯƠNG ĐÔNG: mọi nhân vật mới là người Á Đông (Trung/Hàn/Nhật) — tên phiên âm Latin hợp văn hoá đó, gương mặt, tóc, vóc dáng kiểu Á Đông. Bối cảnh, đạo cụ, câu chuyện, hành động GIỮ NGUYÊN như phim gốc.",
    text: "PHONG CÁCH PHƯƠNG ĐÔNG: thế giới, bối cảnh, kiến trúc, trang phục, phong tục và nghề nghiệp kiểu Á Đông (Trung Hoa/Việt/Hàn/Nhật — hiện đại hoặc cổ trang tuỳ DNA tập gốc); nhân vật người châu Á với tên phù hợp văn hoá đó; quan hệ quyền lực theo mô hình phương Đông (gia tộc, thứ bậc trưởng–thứ, mẹ chồng–nàng dâu, tông môn, triều đình, tập đoàn gia đình...); lời thoại và lễ nghi tự nhiên kiểu phương Đông.",
  },
];

function key(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/^phong cach\s+/, "")
    .replace(/[^a-z ]/g, "")
    .trim();
}

/** Dòng chọn chế độ remake ĐỔI THẾ GIỚI (cách cũ) — mặc định là giống gốc, chỉ thay nhân vật. */
const TRANSFORM_KEYS = ["doi the gioi", "transform", "the gioi moi", "doi boi canh"];
const FAITHFUL_KEYS = ["giong goc", "giong het goc", "chi thay nhan vat", "faithful"];

/**
 * Mở rộng các dòng là từ khoá phong cách; dòng chọn chế độ ("đổi thế giới",
 * "giống gốc") được bỏ khỏi note và trả về ở mode. Mặc định mode "faithful".
 */
export function expandStyleNote(note: string | undefined): {
  note: string | undefined;
  styles: string[];
  mode: "faithful" | "transform";
} {
  if (!note) return { note, styles: [], mode: "faithful" };
  const raw = note.split("\n");
  // Chế độ quyết định cách mở rộng từ khoá phong cách → xác định trước.
  const mode: "faithful" | "transform" = raw.some((l) => TRANSFORM_KEYS.includes(key(l))) ? "transform" : "faithful";
  const styles: string[] = [];
  const lines: string[] = [];
  for (const line of raw) {
    const k = key(line);
    if (TRANSFORM_KEYS.includes(k) || FAITHFUL_KEYS.includes(k)) continue;
    const preset = PRESETS.find((p) => p.keys.includes(k));
    if (preset) styles.push(preset.label);
    lines.push(preset ? (mode === "faithful" ? preset.faithful : preset.text) : line);
  }
  return { note: lines.join("\n").trim() || undefined, styles, mode };
}
