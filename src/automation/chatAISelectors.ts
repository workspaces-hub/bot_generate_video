import type { Locator, Page } from "playwright";

/**
 * ChatAI CHƯA có DOM thật xác nhận (tính năng mới, chưa chạy qua debug
 * snapshot thực tế) — các selector dưới đây dựa theo cấu trúc DOM công khai,
 * ổn định từ lâu của giao diện ChatAI (id/data-testid), nhưng vẫn có thể
 * cần chỉnh lại qua debug snapshot (storage/debug/<jobId>*.png/.html) ở lần
 * chạy thử đầu — cùng cách các selector khác trong project này đã được tinh
 * chỉnh dần từ phỏng đoán ban đầu.
 */

/**
 * Ô nhập prompt — TRƯỚC ĐÂY là 1 div contenteditable (ProseMirror, id=
 * "prompt-textarea"). Xác nhận qua lỗi thật (job f0c50391, hàng loạt job
 * ChatAI lỗi cùng lúc "Không tìm thấy phần tử nào khớp"): ChatGPT đã đổi hẳn
 * sang <textarea name="prompt-textarea" aria-label="Chat with ChatGPT">
 * (class "wcDTda_fallbackTextarea", KHÔNG còn contenteditable, KHÔNG còn
 * id="prompt-textarea" — chỉ còn name), khiến CẢ 3 selector cũ đều không
 * khớp được nữa. Thêm selector mới KHỚP CHÍNH XÁC DOM hiện tại lên đầu danh
 * sách, giữ nguyên các selector cũ phía sau làm dự phòng (phòng site đổi
 * lại/A-B test).
 */
export const promptTextareaCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('textarea[name="prompt-textarea"]'),
  () => page.locator("#prompt-textarea"),
  () => page.getByRole("textbox", { name: /message/i }),
  () => page.locator('[contenteditable="true"]'),
];

/**
 * Toggle "Trò chuyện" (Chat) / "Công việc" (Work) — DOM thật xác nhận: 1 cặp
 * `<button role="radio" data-tpp-toggle-value="chatgpt|work">` (radio group,
 * `aria-checked="true"` trên nút đang chọn). Nhận diện qua attribute
 * `data-tpp-toggle-value="work"` (ổn định, không phụ thuộc ngôn ngữ hiển thị
 * — tiếng Việt là "Công việc", tiếng Anh là "Work").
 */
export const workModeToggleLocator = (page: Page): Locator =>
  page.locator('button[role="radio"][data-tpp-toggle-value="work"]');

/** Cùng radio group với workModeToggleLocator ở trên, giá trị còn lại ("Trò chuyện"/"Chat") — data-tpp-toggle-value="chatgpt". */
export const chatModeToggleLocator = (page: Page): Locator =>
  page.locator('button[role="radio"][data-tpp-toggle-value="chatgpt"]');

/**
 * CHƯA có DOM thật xác nhận (tính năng upload ảnh tham chiếu mới, chưa chạy
 * qua debug snapshot thực tế) — <input type="file"> phục vụ nút "+"/"Add
 * photos & files" trong composer thường bị ẨN (display:none/aria-hidden),
 * KHÔNG cần click mở menu trước — set thẳng file lên input này bằng
 * setInputFiles() (cách chuẩn của Playwright cho input file ẩn, bỏ qua bước
 * mở dialog OS). Có thể cần chỉnh lại qua debug snapshot ở lần chạy thử đầu
 * nếu ChatAI dùng cấu trúc khác (vd nhiều input file cho nhiều mục đích
 * khác nhau trên trang).
 */
export const fileUploadInputLocator = (page: Page): Locator =>
  page.locator('input[type="file"]').first();

/**
 * Nút gửi prompt (icon mũi tên) cạnh ô nhập.
 *
 * SỬA (xác nhận qua debug thật, job 5de37345-716d-47e6-8041-07c165ef0524):
 * ChatGPT đã đổi hẳn nút này — KHÔNG còn `data-testid="send-button"` (thuộc
 * tính này biến mất khỏi DOM hoàn toàn) VÀ `aria-label` đổi từ "Send prompt"
 * thành ĐÚNG "Send" (không còn chữ "prompt"), khiến CẢ 2 candidate cũ đều
 * không khớp được nữa — DOM thật xác nhận:
 * `<button type="submit" class="... bg-composer-primary ..." aria-label="Send">`.
 * Thêm candidate mới khớp CHÍNH XÁC (exact, tránh khớp nhầm các nút khác có
 * chữ "Send" là 1 phần tên, vd "Send to...") lên đầu; giữ 2 candidate cũ
 * phía sau làm dự phòng (phòng site đổi lại/A-B test khác tài khoản).
 */
export const sendButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: "Send", exact: true }),
  () => page.locator('button[data-testid="send-button"]'),
  () => page.getByRole("button", { name: /send prompt/i }),
];

/** Nút dừng khi ChatAI đang trả lời (thay chỗ nút gửi) — biến mất khi trả lời xong. */
export const stopGeneratingButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('button[data-testid="stop-button"]'),
  () => page.getByRole("button", { name: /stop generating/i }),
];

/**
 * Chỉ báo "Working for Xm Ys" hiển thị lúc ChatAI đang thực thi tool call
 * (đọc file, tra cứu web...) — DOM thật xác nhận (job
 * 61d57820-315e-47a6-834d-564f3a2d0deb_test_camera_1.txt, 2026-09-09):
 * `<div data-streaming-response-status=""><span aria-hidden="true">Working
 * for 1m 35s</span>...</div>`. Bổ sung THÊM cho stopGeneratingButtonCandidates
 * (không thay thế) — xác nhận qua lỗi thật: job này bị sendMessage() coi là
 * "xong" (báo 404 không có file) dù ảnh debug lúc đó cho thấy RÕ RÀNG trang
 * vẫn đang "Working for 1m 35s" VÀ nút Stop vẫn hiện — nghi việc dò nút Stop
 * có khoảng hở lúc tool call đang chạy (chưa xác nhận chắc nguyên nhân gốc,
 * nhưng tín hiệu "Working for" này rõ ràng/độc lập hơn, dùng làm lưới an
 * toàn thứ 2 để giảm rủi ro false-positive "đã xong").
 */
export const workingIndicatorLocator = (page: Page): Locator =>
  page.locator("[data-streaming-response-status]");

/**
 * Khối tin nhắn trả lời của ChatAI (mỗi lượt hỏi/đáp 1 khối riêng, lấy khối
 * CUỐI). DOM thật xác nhận (job 24b9cf53): phản hồi dùng tool tạo ẢNH
 * (image generation) KHÔNG nằm trong [data-message-author-role="assistant"]
 * như tin nhắn text thường — toàn trang lúc đó chỉ có ĐÚNG 1 attribute
 * data-message-author-role (của USER), khiến scope theo attribute này khớp
 * 0 phần tử dù ảnh đã tạo xong thật. Cấu trúc CHUNG cho MỌI lượt trả lời của
 * ChatAI (cả text lẫn ảnh) là `<section data-testid="conversation-turn-N">`
 * chứa 1 descendant mang class "agent-turn" — dùng cấu trúc này thay vì
 * attribute data-message-author-role để không bỏ sót trường hợp ảnh. Nhánh
 * này áp dụng cho chế độ "Chat" (chatModeToggleLocator).
 *
 * BỔ SUNG nhánh RIÊNG cho chế độ "Work"/"Công việc" (workModeToggleLocator)
 * — xác nhận qua debug thật (job 9ff64b1a-886f-4aec-97f4-af6f877a5cea VÀ
 * 7c2ddec9-8148-4855-969d-edde0c12fa83, cả 2 đều lặp vô hạn trong
 * sendMessage dù ChatAI đã trả lời XONG THẬT — "Analyzed" + đầy đủ nội dung
 * + link file JSON hiện rõ trên trang): ở mode Work, DOM KHÔNG hề có
 * `conversation-turn`/`.agent-turn`/`data-message-author-role` (0 phần tử,
 * đã grep toàn bộ HTML xác nhận) — cấu trúc THẬT SỰ dùng là
 * `<div data-content-search-unit-key="fallback-turn-N:M:assistant" ...>`
 * (attribute LUÔN kết thúc bằng ":assistant" cho lượt trả lời của ChatAI,
 * xác nhận cả 2 job trên đều khớp) bọc ngoài `<h4 data-conversation-role=
 * "assistant">` (sr-only) và nội dung markdown thật. Vì mode Work không có
 * `.agent-turn` nên nhánh Chat ở trên khớp 0 phần tử — phải OR thêm nhánh
 * này, không thay thế, để hasAssistantTurn/readLatestAssistantMessage nhận
 * đúng lượt trả lời ở CẢ HAI mode thay vì treo vô hạn (xem sendMessage).
 */
export const assistantMessageLocator = (page: Page): Locator =>
  page
    .locator('section[data-testid^="conversation-turn-"]')
    .filter({ has: page.locator(".agent-turn") })
    .or(page.locator('[data-content-search-unit-key$=":assistant"]'));

/**
 * File ChatAI tạo ra và đính kèm trong 1 tin nhắn trả lời (vd qua code
 * interpreter/canvas) — DOM thật xác nhận ChatAI dùng NHIỀU kiểu UI khác
 * nhau cho việc này tuỳ phiên/thời điểm (site đổi UI khá thường xuyên):
 * 1. Link-text tiếng Anh NGAY TRONG đoạn trả lời, nhãn "Download <filename>":
 *    `<button aria-label="Download meta.json">Download meta.json</button>`
 *    (job 6d869584) — bấm vào kích hoạt download thật NGAY (xem
 *    downloadFileLinkLocator, ưu tiên dùng cái này để tải).
 * 2. Thẻ "card" file hiện dưới câu trả lời:
 *    `<button aria-label="meta.json" class="group/open-file ...">` — bấm
 *    vào MỞ PREVIEW (canvas), không chắc tải thẳng (xem fileCardLocator,
 *    dùng làm fallback khi không có nút "Download ..." nào).
 * 3. Link-text TIẾNG VIỆT, có emoji, NGAY TRONG đoạn văn (job 4c746641,
 *    KHÔNG khớp cả 2 pattern trên nên trước đây bị bỏ sót hoàn toàn — file
 *    JSON có thật, ChatAI báo đã tạo, nhưng bot không tải được gì cả):
 *    `<button aria-label="📄 Tải file pip_mouse_..._full.json" class="behavior-btn ... entity-underline ...">📄 Tải file ..._full.json</button>`
 *    — nhận diện qua aria-label KẾT THÚC bằng ".json" (xem inlineFileLinkLocator).
 * 4. Chế độ "Work" (xem docstring assistantMessageLocator) — DOM HOÀN TOÀN
 *    KHÁC, không phải `<button>` mà là `<span role="button">`, xác nhận qua
 *    debug thật (job 9ff64b1a-886f-4aec-97f4-af6f877a5cea):
 *    `<span data-file-reference="true" data-markdown-copy-text="X.json"
 *    role="button" aria-label="Open preview of X.json">` — nhận diện qua
 *    attribute `data-file-reference="true"` (xem workModeFileReferenceLocator).
 * fileAttachmentLocator gộp cả 4 — dùng để CHECK "đã có file xuất hiện chưa"
 * (vd sendMessage coi đây là dấu hiệu ChatAI trả lời xong); còn lúc THỰC SỰ bấm
 * tải (downloadAttachedFiles trong chatAI.ts) phải ưu tiên
 * downloadFileLinkLocator/inlineFileLinkLocator trước, không bấm nhiều nút
 * cho CÙNG 1 file (tránh tải trùng/mở preview thừa).
 */
export const fileAttachmentLocator = (message: Locator): Locator =>
  message.locator(
    [
      'button[aria-label^="Download "]',
      'button[class*="group/open-file"]',
      'button[aria-label$=".json"]',
      '[data-file-reference="true"]',
      '[class*="group/resource-row"]',
    ].join(", "),
  );

/**
 * Chế độ "Work" — file tham chiếu render dạng `<span role="button"
 * data-file-reference="true" data-markdown-copy-text="<filename>"
 * aria-label="Open preview of <filename>">` NGAY TRONG đoạn markdown, KHÔNG
 * PHẢI `<button>` như mọi biến thể "Chat" khác (xem fileAttachmentLocator
 * mục 4) — xác nhận qua debug thật (job 9ff64b1a-886f-4aec-97f4-af6f877a5cea
 * VÀ 7c2ddec9-8148-4855-969d-edde0c12fa83).
 *
 * SỬA (xác nhận qua debug thật, job ec31faa8-2a40-48ae-904a-26e6a7002b5d):
 * bấm span này KHÔNG mở được panel xem trước nào ("screen-threadFlyOut"
 * count=0 trong HTML chụp lại NGAY SAU khi bấm) — nghi đây chỉ là 1 trích
 * dẫn/tham chiếu trong văn bản (giống citation), không phải nút tương tác
 * thật. Hạ xuống làm phương án CUỐI CÙNG (sau
 * workModeResourceCardDownloadButtonLocator, xem docstring đó — có bằng
 * chứng thật đáng tin cậy hơn hẳn), chỉ dùng khi resource card không tồn
 * tại vì lý do nào đó.
 */
export const workModeFileReferenceLocator = (message: Locator): Locator =>
  message.locator('[data-file-reference="true"]');

/**
 * Chế độ "Work" — "resource card" hiện SAU đoạn trả lời (KHÁC hẳn span
 * trích dẫn NGAY TRONG văn bản ở workModeFileReferenceLocator) — xác nhận
 * qua debug thật (job ec31faa8-2a40-48ae-904a-26e6a7002b5d, ĐÚNG lúc
 * workModeFileReferenceLocator bấm không ăn thua): DOM có sẵn 1 khối
 * `<span class="group/resource-row ...">` (cùng quy ước đặt tên
 * "group/..." với "group/open-file" đã dùng cho fileCardLocator) chứa 2 nút
 * RIÊNG — 1 nút phủ toàn bộ card `aria-label="Open preview of <filename>"`,
 * và 1 nút icon CHỈ hiện khi hover `aria-label="Download file"` (generic,
 * KHÔNG có tên file — khác hẳn quy ước aria-label="Download <filename>" của
 * downloadFileLinkLocator). Nút "Download file" này mới là nút tải THẬT
 * (mục đích rõ ràng qua icon + nhãn, không mơ hồ như span trích dẫn).
 *
 * QUAN TRỌNG: vì aria-label CHUNG CHUNG (không có tên file), KHÔNG dùng để
 * dedupe/đặt tên file khi có NHIỀU file cùng lượt — downloadAttachedFiles
 * phải tự tra thêm attribute `title` (tên file thật) trên phần tử hiển thị
 * tên trong CÙNG resource-row này (workModeResourceCardRowLocator) làm nhãn
 * thay thế.
 */
export const workModeResourceCardRowLocator = (message: Locator): Locator =>
  message.locator('[class*="group/resource-row"]');

export const workModeResourceCardDownloadButtonLocator = (
  message: Locator,
): Locator =>
  workModeResourceCardRowLocator(message).locator(
    'button[aria-label="Download file"]',
  );

/**
 * Nút link-text "Download <filename>" — bấm vào kích hoạt download thật ngay,
 * ưu tiên dùng cái này. DOM thật xác nhận (job 9a775122): CÙNG 1 file có tới
 * 2 nút cùng khớp `[aria-label^="Download "]` — nút link-text thật
 * (`aria-label="Download <filename>"`) VÀ 1 icon hover chung chung
 * (`aria-label="Download file"`, không có tên file) nằm đè lên thẻ card —
 * bấm cả 2 tải TRÙNG LẶP cùng 1 file (đã xác nhận: 2 file tải về giống hệt
 * nhau byte-for-byte). Loại trừ tường minh nút generic "Download file" —
 * chỉ giữ nút có TÊN FILE thật trong aria-label.
 */
export const downloadFileLinkLocator = (message: Locator): Locator =>
  message.locator(
    'button[aria-label^="Download "]:not([aria-label="Download file"])',
  );

/**
 * Link-text TIẾNG VIỆT kèm emoji, nhãn "📄 Tải file <filename>", NGAY TRONG
 * đoạn văn trả lời — DOM thật xác nhận (job 4c746641):
 * `<button aria-label="📄 Tải file pip_mouse_..._full.json" class="behavior-btn ... entity-underline ...">`,
 * hoàn toàn KHÔNG khớp downloadFileLinkLocator (không bắt đầu bằng
 * "Download "). Nhận diện qua aria-label kết thúc bằng ".json" (đủ đặc
 * trưng, ChatAI luôn đặt tên file JSON output theo đúng đuôi này) — NHƯNG
 * PHẢI loại trừ tường minh class "group/open-file" (thẻ card, xem
 * fileCardLocator): DOM thật xác nhận (job 67b2f3fc) CÙNG 1 file có thể có
 * CẢ HAI nút — 1 link-text trích dẫn (class "behavior-btn"/"entity-underline")
 * VÀ 1 thẻ card (class "group/open-file") — CẢ HAI đều có aria-label giống
 * hệt tên file, nếu không loại trừ sẽ khớp nhầm cả thẻ card vào đây. Cũng
 * xác nhận qua thực tế (job 67b2f3fc, pip_boulangerie): bấm nút link-text
 * trích dẫn KHÔNG có emoji "📄" (chỉ có tên file trần) KHÔNG mở ra được panel
 * xem trước lẫn kích hoạt download — có vẻ chỉ là citation/tham chiếu, khác
 * hẳn biến thể CÓ emoji "📄 Tải file" (job 4c746641, xác nhận tải được thật).
 * Vì độ tin cậy không chắc chắn, dùng làm phương án CUỐI CÙNG, sau
 * fileCardLocator (xem thứ tự ưu tiên trong downloadAttachedFiles).
 *
 * SỬA (xác nhận qua debug thật, job 14dae602-71eb-4d36-93bb-01439ee0252e —
 * job "Tạo kịch bản mới" nhiều tập): thêm biến thể THỨ BA, KHÔNG kèm emoji
 * VÀ aria-label KHÔNG kết thúc bằng ".json" — mỗi tập có 1 nút RIÊNG dạng
 * `<button aria-label="Tải file JSON Tập 1" class="behavior-btn ...
 * entity-underline ...">` (icon + text "Tải file JSON Tập 1" là nội dung
 * HIỂN THỊ thật, không phải chỉ aria-label) — trước đây hoàn toàn KHÔNG khớp
 * locator nào (không ".json" ở cuối, không "group/open-file", không
 * "Download "), khiến cả 3 locator trong downloadAttachedFiles đều
 * count()=0 và bỏ sót file dù ChatAI đã thật sự đính kèm. Thêm điều kiện
 * OR khớp aria-label BẮT ĐẦU bằng "Tải file" (cụm ChatAI luôn dùng cho mọi
 * nút tải file tiếng Việt, có hoặc không có emoji/tên file ở cuối).
 */
export const inlineFileLinkLocator = (message: Locator): Locator =>
  message.locator(
    'button[aria-label$=".json"]:not([class*="group/open-file"]), button[aria-label^="Tải file"]:not([class*="group/open-file"])',
  );

/**
 * Thẻ "card" file (mở preview/canvas dạng "screen-threadFlyOut", xem
 * downloadAttachedFiles) — DOM thật xác nhận đây là dạng ĐÁNG TIN CẬY NHẤT
 * để mở được panel xem trước khi không có nút "Download <filename>" trực
 * tiếp (job 38b68c7a, 67b2f3fc) — ưu tiên dùng TRƯỚC inlineFileLinkLocator.
 */
export const fileCardLocator = (message: Locator): Locator =>
  message.locator('button[class*="group/open-file"]');

/** Nút "Download" hiện ra sau khi bấm vào 1 file đính kèm (trường hợp bấm vào chỉ mở preview thay vì tải thẳng). */
export const downloadButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByRole("button", { name: /^download$/i }),
  () => page.getByRole("link", { name: /^download$/i }),
];

/**
 * Nút "Retry" hiện khi ChatAI báo lỗi generate (thực tế gặp: generate ẢNH lỗi
 * với message "Something went wrong. Please try again.") — DOM thật (job
 * d077805e): `<button data-testid="regenerate-thread-error-button">Retry</button>`.
 * Đây là lỗi THẬT phía ChatAI (không phải do bot chọn sai selector) — bấm
 * Retry thường tự sửa được vì nguyên nhân hay gặp là quá tải server nhất
 * thời.
 */
export const regenerateErrorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator('[data-testid="regenerate-thread-error-button"]'),
  () => page.getByRole("button", { name: /^retry$/i }),
  () => page.getByRole("button", { name: /^thử lại$/i }),
];

/**
 * ChatGPT báo đang xử lý CHẬM HƠN bình thường (thường do quá tải hạ tầng
 * phía ChatGPT) — nguyên văn: "Our systems are thinking a bit more about
 * this request before responding." Theo yêu cầu người dùng: gặp trạng thái
 * này thì reload lại trang thay vì tiếp tục chờ (xem sendMessage) — cùng
 * cách xử lý "Something went wrong"/Retry ở trên, khác ở chỗ trạng thái này
 * KHÔNG có nút bấm nào, chỉ hiện text, nên hành động khắc phục duy nhất là
 * tự reload.
 */
export const thinkingLongerIndicatorLocator = (page: Page): Locator =>
  page.getByText(
    "Our systems are thinking a bit more about this request before responding.",
  );

/** Dấu hiệu CHƯA đăng nhập (trang ChatAI hiện màn hình đăng nhập). */
export const signInIndicatorCandidates = (page: Page): Array<() => Locator> => [
  () => page.getByText(/^log in$/i),
  () => page.getByRole("button", { name: /^log in$/i }),
];

/**
 * Nút chọn mức "reasoning effort" hiện ở toolbar cạnh ô nhập. CHỈ LÀ NHÃN
 * HIỂN THỊ (mức độ suy luận), KHÔNG PHẢI tên model đầy đủ — muốn biết CHÍNH
 * XÁC model nào thực sự xử lý 1 câu trả lời, đọc attribute
 * data-message-model-slug trên tin nhắn trả lời thật (xem
 * assistantTextMessageLocator) thay vì dựa vào nút này.
 *
 * DOM thật xác nhận (storage/debug/chatai-effort-menu.html): nhãn KHÔNG cố
 * định theo 1 tập từ tiếng Anh cố định — tài khoản test thấy cả "Light"
 * (English) LẪN "Vừa" (tiếng Việt, = Medium) tuỳ thời điểm, nên regex đoán
 * text cũ (auto|fast|medium|thinking|extended thinking) SAI hoàn toàn, không
 * bao giờ khớp được nút thật:
 * `<button aria-haspopup="menu" aria-expanded="false" ...>
 *   <span class="uFxlGa_SliderTriggerModelLabel">5.6 Sol</span>
 *   <span class="uFxlGa_SliderTriggerEffortLabel" data-max-effort="false">Light</span>
 * </button>`
 * Attribute "data-max-effort" trên span nhãn mức là điểm neo ĐÁNG TIN CẬY
 * DUY NHẤT (không phụ thuộc ngôn ngữ hiển thị) — "true" nghĩa là ĐÃ ở mức tối
 * đa, dùng để biết có cần bấm chọn tiếp hay không. Giữ regex text cũ làm
 * fallback phòng site đổi lại cấu trúc.
 */
export const modelSelectorButtonCandidates = (page: Page): Array<() => Locator> => [
  () => page.locator("button:has(span[data-max-effort])"),
  () => page.getByRole("button", { name: /^(auto|fast|medium|thinking|extended thinking)$/i }),
];

/** Span nhãn mức hỗ trợ hiện tại — đọc attribute "data-max-effort" để biết đã ở mức tối đa chưa. */
export const effortLabelLocator = (page: Page): Locator =>
  page.locator("span[data-max-effort]");

/**
 * Popup mở ra sau khi bấm modelSelectorButtonCandidates KHÔNG phải menu với
 * các item bấm chọn — là 1 THANH TRƯỢT (Radix Slider) 5 nấc (aria-valuemin=0,
 * aria-valuemax=4). DOM thật xác nhận (storage/debug/chatai-effort-menu.html,
 * lúc đang ở nấc 2/5 "Light"):
 * `<div role="menuitem" tabindex="0" class="... d1BZWq_SliderControl"
 *   aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Power" ...>
 *   ...<span role="slider" aria-valuemin="0" aria-valuemax="4" tabindex="-1"
 *     aria-hidden="true" aria-valuenow="1" ...></span>
 * </div>`
 * — phần tử THẬT SỰ nhận focus/phím là div[role="menuitem"][aria-label="Power"]
 * (tabindex="0", có aria-keyshortcuts) — span role="slider" bên trong chỉ là
 * proxy hiển thị (tabindex="-1", aria-hidden="true"), KHÔNG focus/press phím
 * trực tiếp lên đó được. Bấm phím "ArrowRight" lặp lại trên
 * effortSliderControlLocator tới khi effortSliderThumbLocator có
 * aria-valuenow === aria-valuemax (đã ở nấc cao nhất).
 */
export const effortSliderControlLocator = (page: Page): Locator =>
  page.locator('[role="menuitem"][aria-label="Power"]');

/** Proxy hiển thị giá trị hiện tại của thanh trượt mức hỗ trợ — chỉ đọc attribute, không thao tác trực tiếp lên đây. */
export const effortSliderThumbLocator = (page: Page): Locator =>
  page.locator('span[role="slider"]');

/**
 * Nhãn TÊN THẬT (vd "Light"/"Medium"/"High"/"Max") của nấc thanh trượt Power
 * ĐANG chọn, đọc được NGAY CẢ KHI popup thanh trượt đang mở — xác nhận qua
 * lỗi thật (script test-chatai-select-model.ts): effortLabelLocator (span
 * có data-max-effort) chỉ tồn tại ở trạng thái nút toolbar ĐÃ ĐÓNG (hiện
 * dạng rút gọn "GPT-6 Astra | High") — biến mất HOÀN TOÀN (0 phần tử) khi
 * popup đang mở, nên KHÔNG dùng được để dò từng nấc lúc đang thao tác trên
 * thanh trượt (khác effortLabelLocator — hàm đó chỉ đáng tin lúc CHƯA mở
 * popup, xem selectMaxReasoningEffort). Vùng thông báo trợ năng (aria-live,
 * class chứa "KeyboardAnnouncement" — hash CSS-module đổi được nên chỉ khớp
 * theo substring) LUÔN cập nhật đúng tên nấc + vị trí dạng "Light, 1 of 5."
 * mỗi khi bấm ArrowLeft/ArrowRight, kể cả lúc popup đang mở — lọc thêm bằng
 * text pattern ", N of M" để phân biệt với span thông báo hướng dẫn chung
 * ("Use Left and Right arrow keys...") cũng dùng chung class.
 */
export const effortSliderAnnouncementLocator = (page: Page): Locator =>
  page
    .locator('[class*="KeyboardAnnouncement"]')
    .filter({ hasText: /,\s*\d+\s+of\s+\d+/i });

/**
 * Item "Select model" (có mũi tên chevron) trong popup mở ra từ
 * modelSelectorButtonCandidates — bấm vào đây để chuyển từ "simple view"
 * (chỉ có thanh trượt Power) sang "advanced view" (danh sách ĐẦY ĐỦ tên
 * model, xem modelOptionLocator bên dưới) — DOM thật xác nhận
 * (storage/debug/inspect-chatai-model-picker*.html, mode "Work"):
 * `<div role="menuitem" aria-label="Select model" ...><span>...<span
 * data-max-effort="false">GPT-5.6 Sol</span></span><svg .../chevron-right...
 * /></div>`. CHỈ hiện danh sách model đầy đủ (GPT-6 Astra, GPT-5.6
 * Sol/Terra/Luna, GPT-5.5...) ở mode "Work" (xem workModeToggleLocator) —
 * mode "Chat" chỉ có 2 lựa chọn (GPT-5.6 Sol, GPT-5.5).
 */
export const modelPickerSelectModelToggleLocator = (page: Page): Locator =>
  page.locator('[role="menuitem"][aria-label="Select model"]');

/**
 * 1 model cụ thể trong "advanced view" (menuitemradio) — khớp theo
 * substring tên hiển thị (đủ để phân biệt, không trùng tên nào khác, vd
 * "GPT-6 Astra" không phải substring của "GPT-5.6 Sol/Terra/Luna" hay
 * ngược lại). Chỉ tồn tại/thấy được SAU khi đã bấm
 * modelPickerSelectModelToggleLocator để vào advanced view.
 */
export const modelPickerOptionLocator = (page: Page, modelName: string): Locator =>
  page.locator('[role="menuitemradio"]').filter({ hasText: modelName });

/**
 * Tin nhắn trả lời TEXT thường (KHÔNG dùng cho phản hồi tạo ảnh — xem
 * assistantMessageLocator không có attribute này) — DOM thật xác nhận (job
 * b38b1151): `<div data-message-author-role="assistant" ...
 * data-message-model-slug="chatai-5-6-thinking">` — attribute
 * data-message-model-slug ghi đúng tên model THẬT đã xử lý câu trả lời đó,
 * đáng tin cậy hơn hẳn nhãn hiển thị trên nút chọn model (nhãn đó chỉ là mức
 * độ suy luận, không phải tên model).
 */
export const assistantTextMessageLocator = (page: Page): Locator =>
  page.locator('[data-message-author-role="assistant"]');
