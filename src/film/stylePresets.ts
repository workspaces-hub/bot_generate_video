/**
 * Từ khoá phong cách gõ nhanh cho yêu cầu riêng của bản remake ("Remake phim"
 * dòng 2+, "Test prompt remake phim" sau "xong"). Dòng nào đúng bằng từ khoá
 * thì được mở rộng thành mô tả đầy đủ; dòng khác giữ nguyên (ghi chú tự do
 * vẫn dùng được, vd "phương tây\nnữ chính là luật sư").
 */
const PRESETS: { keys: string[]; label: string; text: string }[] = [
  {
    keys: ["phuong tay", "tay", "western", "au my", "west"],
    label: "phương Tây",
    text: "PHONG CÁCH PHƯƠNG TÂY: thế giới, bối cảnh, kiến trúc, trang phục, phong tục và nghề nghiệp kiểu Âu–Mỹ (hiện đại hoặc cổ điển châu Âu tuỳ DNA tập gốc); nhân vật người phương Tây với tên tiếng Anh/châu Âu; quan hệ quyền lực theo mô hình phương Tây (tập đoàn, gia tộc quý tộc, toà án, cảnh sát, hội đồng quản trị...); lời thoại và cách ứng xử tự nhiên kiểu phương Tây.",
  },
  {
    keys: ["phuong dong", "dong", "eastern", "chau a", "east", "asian"],
    label: "phương Đông",
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

/** Mở rộng các dòng là từ khoá phong cách; trả về note mới + nhãn phong cách đã nhận. */
export function expandStyleNote(note: string | undefined): { note: string | undefined; styles: string[] } {
  if (!note) return { note, styles: [] };
  const styles: string[] = [];
  const lines = note.split("\n").map((line) => {
    const preset = PRESETS.find((p) => p.keys.includes(key(line)));
    if (!preset) return line;
    styles.push(preset.label);
    return preset.text;
  });
  return { note: lines.join("\n").trim() || undefined, styles };
}
