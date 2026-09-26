import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc: ${name} (xem .env.example)`,
    );
  }
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  // Video kết quả (hoặc "404" khi lỗi) luôn đăng vào group cố định này.
  groupChatId: Number(required("GROUP_CHAT_ID")),
  groupChatIdTest: Number(required("GROUP_CHAT_ID_TEST")),

  // Domain thật của dịch vụ tạo video/ảnh AI (bên thứ 3) bot tự động hoá —
  // giá trị mặc định PHẢI giữ đúng domain thật này, chỉ đổi được qua env var
  // AIVIDEO_BASE_URL nếu cần.
  aiVideoBaseUrl: process.env.AIVIDEO_BASE_URL ?? "https://hailuoai.video",
  aiVideoCreateVideoPath:
    process.env.AIVIDEO_CREATE_VIDEO_PATH ?? "/create/image-to-video",
  aiVideoCreateImagePath:
    process.env.AIVIDEO_CREATE_IMAGE_PATH ?? "/create/image-generation",
  // Trang tạo video từ Image Reference / Character Reference — khác hẳn
  // trang tạo video thường (/create/video). Xác nhận thật: chip chuyển mode
  // "Start/End Frame" chỉ mở popover Image/Character Reference trên trang
  // NÀY — trên /create/video, chip đó không mở popover mode nào cả (đã thử
  // và xác nhận qua debug HTML: click không mở đúng popover, chỉ có popover
  // "model-selection-options" không liên quan tồn tại sẵn trong DOM).
  aiVideoCreateVideoRefPath:
    process.env.AIVIDEO_CREATE_VIDEO_REF_PATH ??
    "/create/subject-reference-to-video",

  // Session cho hàng đợi VIDEO (AIVideo) — xem getVideoBrowserContext trong
  // browser.ts. Giữ nguyên tên biến môi trường STORAGE_STATE_PATH cũ (không
  // đổi) để không phá session đã đăng nhập sẵn trên VPS.
  storageStatePath: path.resolve(
    process.env.STORAGE_STATE_PATH ?? "./storage/session.json",
  ),
  // Session RIÊNG cho hàng đợi ẢNH (AIVideo) — 2 TÀI KHOẢN KHÁC NHAU theo
  // yêu cầu người dùng (không chỉ 2 browser context của CÙNG 1 tài khoản):
  // gen ảnh và gen video giờ chạy song song ở 2 hàng đợi độc lập (xem
  // imageJobs/videoJobs trong queue.ts), tách hẳn tài khoản để không tranh
  // credit/rate-limit lẫn nhau. Đăng nhập bằng `npm run login -- image` (xem
  // scripts/login.ts) — KHÁC lệnh đăng nhập tài khoản video (`npm run login`
  // hoặc `npm run login -- video`).
  aiVideoImageStorageStatePath: path.resolve(
    process.env.AIVIDEO_IMAGE_STORAGE_STATE_PATH ??
      "./storage/session-image.json",
  ),
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR ?? "./storage/downloads"),
  // Thư mục profile/cache tạm của Chrome (user-data-dir) — mặc định
  // Playwright tự tạo trong os.tmpdir() (thường "/tmp" trên Linux). Nhiều
  // VPS mount "/tmp" bằng tmpfs (RAM, xem "/dev/shm" cùng cơ chế) — ghi
  // profile Chrome (cache HTTP, IndexedDB, GPU shader cache...) vào đó thực
  // chất là TỐN THÊM RAM, không phải đĩa, cộng dồn thêm vào áp lực RAM đã
  // xác nhận là nút thắt chính (xem launch.ts). Đổi sang 1 thư mục THẬT
  // trong chính ổ đĩa của project — launch.ts tự set biến môi trường TMPDIR
  // trỏ vào đây trước khi launch Chrome.
  chromeTmpDir: path.resolve(process.env.CHROME_TMP_DIR ?? "./storage/chrome-tmp"),
  // Ảnh tham chiếu tải từ Telegram (tính năng tạo ảnh) lưu tạm ở đây.
  uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? "./storage/uploads"),
  debugDir: path.resolve("./storage/debug"),

  // Tính năng "ChatAI": bot mở dịch vụ chat AI (bên thứ 3) thật, điền prompt,
  // chờ trả lời xong rồi lưu ra file. Dùng session RIÊNG (khác AIVideo) vì
  // khác domain — xem scripts/login-chatai.ts. Giá trị mặc định PHẢI giữ
  // đúng domain thật này, chỉ đổi được qua env var CHATAI_BASE_URL nếu cần.
  chatAIBaseUrl: process.env.CHATAI_BASE_URL ?? "https://chatgpt.com",
  chatAIStorageStatePath: path.resolve(
    process.env.CHATAI_STORAGE_STATE_PATH ?? "./storage/chatai-session.json",
  ),
  // Session RIÊNG (tài khoản KHÁC hẳn chatAIStorageStatePath ở trên) chỉ
  // dùng cho reviseGenerationPrompt (chatAI.ts) — nhờ ChatAI viết lại prompt
  // bị AIVideo từ chối vì vi phạm chính sách nội dung. Tách riêng vì
  // reviseGenerationPrompt có thể chạy CÙNG LÚC với askChatAI (2 hàng đợi độc
  // lập, xem queue.ts) — dùng chung 1 session sẽ khiến 2 tab thao tác song
  // song trên CÙNG 1 tài khoản (dễ đụng clipboard, trông "máy" hơn với
  // ChatGPT, tăng rủi ro bị rate-limit/chặn). Đăng nhập bằng
  // `npm run login-chatai -- revise` (xem scripts/login-chatai.ts).
  chatAIReviseStorageStatePath: path.resolve(
    process.env.CHATAI_REVISE_STORAGE_STATE_PATH ??
      "./storage/chatai-revise-session.json",
  ),
  // Session RIÊNG (tài khoản KHÁC hẳn chatAIStorageStatePath VÀ
  // chatAIReviseStorageStatePath) chỉ dùng cho generateReferenceImage
  // (chatAIImage.ts — CHARACTER/LOCATION/SCENE_SETTING qua ChatAI, và
  // fallback khi pollo.ai gen ảnh lỗi, xem generateImage trong polloImage.ts).
  // Tách riêng vì generateReferenceImage có thể chạy CÙNG LÚC với askChatAI
  // (2 hàng đợi độc lập, xem queue.ts) — cùng lý do đã tách
  // chatAIReviseStorageStatePath ở trên: dùng chung 1 session sẽ khiến 2 tab
  // thao tác song song trên CÙNG 1 tài khoản. Đăng nhập bằng
  // `npm run login-chatai -- image` (xem scripts/login-chatai.ts).
  chatAIImageStorageStatePath: path.resolve(
    process.env.CHATAI_IMAGE_STORAGE_STATE_PATH ??
      "./storage/chatai-image-session.json",
  ),
  chatAIResultsDir: path.resolve(
    process.env.CHATAI_RESULTS_DIR ?? "./storage/chatai-results",
  ),

  headless: (process.env.HEADLESS ?? "false").toLowerCase() === "true",
  generationTimeoutMs: Number(process.env.GENERATION_TIMEOUT_MS ?? 10800_000),

  // Chrome thật (không phải Chromium bundled của Playwright) để Google OAuth
  // không chặn với lỗi "This browser or app may not be secure". Đặt thành
  // "chromium" để dùng Chromium bundled của Playwright (không cần cài Chrome
  // hệ thống) — phù hợp khi chạy trên VPS chỉ để tái sử dụng session đã
  // đăng nhập sẵn, không cần đăng nhập Google trực tiếp trên VPS.
  browserChannel: process.env.BROWSER_CHANNEL || "chrome",

  // Bật khi chạy trong container/VPS không hỗ trợ Chrome sandbox namespace.
  // Chỉ bật khi thực sự cần — giảm cô lập bảo mật của Chrome.
  chromeNoSandbox:
    (process.env.CHROME_NO_SANDBOX ?? "false").toLowerCase() === "true",

  // Danh sách Telegram user id được phép dùng bot, cách nhau bởi dấu phẩy.
  // Để trống = không ai dùng được (an toàn mặc định) — xem cảnh báo dưới đây.
  admins: (process.env.ADMINS ?? "")
    .split(",")
    .map((i) => i.trim())
    .filter(Boolean),
  adminsNotify: process.env.ADMINS_NOTIFY ?? "",

  // Proxy cho Playwright (áp dụng cả lúc `npm run login` và lúc bot chạy
  // generate) — nên dùng CÙNG 1 proxy cho cả 2 để tránh đăng nhập từ IP
  // này nhưng generate từ IP khác, dễ bị AIVideo/Google đánh dấu
  // đáng ngờ. Để trống PROXY_SERVER nếu không dùng proxy.
  proxyServer: process.env.PROXY_SERVER || undefined,
  proxyUsername: process.env.PROXY_USERNAME || undefined,
  proxyPassword: process.env.PROXY_PASSWORD || undefined,
  formatOuput: "format_output.txt",
  // Master prompt cho tính năng "Tham chiếu kịch bản" (nút
  // SCRIPT_REFERENCE_BUTTON_LABEL, xem askChatAIAboutReferenceVideo trong
  // chatAI.ts): user upload 1 video, bot upload video này + nội dung file
  // này lên ChatAI, chờ ChatAI trả file JSON storyboard rồi gửi lại luôn cho
  // user (không gen ảnh/video tiếp). Cùng quy ước path tương đối-CWD như
  // formatOuput ở trên.
  promptSplitVideo: "prompt_split_video.txt",
  // Master prompt cho tính năng "Tham chiếu video" (nút
  // VIDEO_REFERENCE_BUTTON_LABEL) — GIỐNG hệt luồng "Tham chiếu kịch bản"
  // (cùng askChatAIAboutReferenceVideo, cùng ScriptReferenceVideoJob/
  // processChatAIQueue) nhưng dùng MASTER PROMPT KHÁC: JSON
  // trả về chỉ có ĐÚNG 1 phần tử VIDEO (không chia SHOT/CLIP) — prompt của
  // phần tử đó mô tả TOÀN BỘ video để gen lại trong 1 lần, xem
  // prompt_video_reference.txt.
  promptVideoReference: "prompt_video_reference.txt",
  // Master prompt cho tính năng "Tạo kịch bản mới" (nút
  // GENERATE_SCRIPT_BUTTON_LABEL) — user gõ tên file json, bot tìm các file
  // JSON storyboard đã có trong config.chatAIResultsDir có tên CHỨA chuỗi đó
  // (có thể khớp nhiều file = nhiều tập phim), ghép nội dung các file đó +
  // master prompt này thành 1 file đính kèm gửi lên ChatAI, yêu cầu viết lại
  // thành 1 bộ phim MỚI TƯƠNG TỰ (đổi kịch bản/nhân vật/bối cảnh/đạo cụ/lời
  // thoại, giữ cấu trúc kỹ thuật dựng phim) — id nhân vật/bối cảnh/đạo cụ/vật
  // thể phải nhất quán xuyên các tập (xem prompt_generate_script.txt, mục
  // "ASSET LEDGER DÙNG CHUNG XUYÊN SUỐT CÁC TẬP").
  promptGenerateScript: "prompt_generate_script.txt",

  // Telegram Bot API (api.telegram.org) CHỈ cho bot TẢI file <= 20MB qua
  // getFile — video tham chiếu user gửi cho "Tham chiếu kịch bản" thường
  // vượt mức này. Fallback: dùng MTProto (thư viện teleproto, xem
  // src/automation/telegramMTProto.ts) đăng nhập LẠI CHÍNH bot này (qua
  // botToken ở trên, không cần số điện thoại/OTP) để tải trực tiếp từ
  // Telegram, không qua giới hạn 20MB của lớp HTTP Bot API. BẮT BUỘC lấy
  // TELEGRAM_API_ID/TELEGRAM_API_HASH tại https://my.telegram.org/apps
  // (mục "API development tools") — đây LÀ CẶP KHOÁ RIÊNG của MTProto,
  // khác hẳn BOT_TOKEN, không có sẽ không tải được file >20MB.
  telegramApiId: Number(process.env.TELEGRAM_API_ID ?? 0),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  // Session MTProto (StringSession) lưu lại sau lần đăng nhập đầu tiên — có
  // rồi thì các lần chạy sau không cần bắt tay xác thực lại DC từ đầu.
  telegramMTProtoSessionPath: path.resolve(
    process.env.TELEGRAM_MTPROTO_SESSION_PATH ??
      "./storage/mtproto-session.txt",
  ),
  defaultModelVideo: process.env.DEFAULT_MODEL_VIDEL || "Hailuo 2.0",

  // Bật để askChatAI (chatAI.ts) tự chọn mức "reasoning effort" CAO NHẤT
  // (thanh trượt cạnh ô nhập ChatAI, xem selectMaxReasoningEffort) trước khi
  // gửi prompt — trả lời chất lượng hơn nhưng chậm/tốn quota hơn. Mặc định
  // TẮT (giữ nguyên mức site đang để) để không đổi hành vi cũ khi chưa cấu
  // hình gì.
  chatAIMaxEffort:
    (process.env.CHATAI_MAX_EFFORT ?? "false").toLowerCase() === "true",

  // Theo yêu cầu người dùng: chọn mode "Công việc"/Work hay "Trò chuyện"/Chat
  // cho askChatAI/askChatAIWithInlineContent (chatAI.ts) — CHATAI_MODE=work
  // thì chọn mode Work + model "GPT-6 Astra" (mức effort Medium, xem
  // selectModelGPT6AstraMediumEffort); bất kỳ giá trị nào khác (mặc định,
  // kể cả để trống) thì dùng Chat thường, KHÔNG chọn model riêng gì cả.
  // Mặc định "chat" — mode Work có quota RIÊNG ("5-hour limit") dễ hết đột
  // ngột, tách biệt khỏi quota Chat (xác nhận qua test thật), nên chỉ nên
  // bật "work" khi biết chắc quota đó còn.
  chatAIMode:
    (process.env.CHATAI_MODE ?? "chat").toLowerCase() === "work"
      ? "work"
      : ("chat" as "work" | "chat"),

  // Tính năng gen ảnh/video qua pollo.ai — PROVIDER MỚI chạy SONG SONG với
  // AIVideo (hailuoai.video), không thay thế. Session/domain hoàn toàn riêng
  // — xem scripts/login-pollo.ts và src/automation/polloBrowser.ts.
  polloBaseUrl: process.env.POLLO_BASE_URL ?? "https://pollo.ai",
  polloStorageStatePath: path.resolve(
    process.env.POLLO_STORAGE_STATE_PATH ?? "./storage/pollo-session.json",
  ),
  // Số video Pollo gen SONG SONG tối đa (worker-pool, xem
  // generateVideosForFilePollo trong storyboardPipeline.ts) — tài khoản
  // pollo.ai cho phép tối đa 8 task song song (theo xác nhận người dùng),
  // mặc định 2 (chừa biên an toàn cho job ảnh Pollo chạy chung tài khoản —
  // xem thêm withPolloTaskSlot trong polloBrowser.ts, gate CHUNG chặn cứng
  // tổng số task ảnh+video không vượt quá giới hạn thật dù config này đặt
  // bao nhiêu).
  // QUAN TRỌNG khi 2 MÁY KHÁC NHAU cùng dùng CHUNG 1 tài khoản pollo.ai (2
  // process độc lập, không chia sẻ được biến đếm trong bộ nhớ với nhau): mỗi
  // máy phải tự đặt biến này thành 1 phần CỐ ĐỊNH của tổng số task muốn dùng
  // (vd 1 + 1, hoặc tỷ lệ khác tuỳ máy) — KHÔNG để cả 2 máy cùng giữ mặc
  // định, sẽ cộng dồn vượt quá giới hạn thật của tài khoản.
  polloVideoConcurrency: Number(process.env.POLLO_VIDEO_CONCURRENCY ?? 2),
  // Số ảnh Pollo gen SONG SONG tối đa (worker-pool) — dùng CHUNG cho cả
  // generateReferenceImagesForFileViaPollo (CHARACTER/LOCATION) và
  // generateSceneImagesForFileViaPollo (SCENE_SETTING_START/END, xem
  // storyboardPipeline.ts) vì 2 bước này không bao giờ chạy CÙNG LÚC với
  // nhau (chạy 2 job/2 lượt xác nhận nối tiếp, xem processPolloImageQueue
  // trong queue.ts) — nhưng CÓ THỂ chạy CÙNG LÚC với hàng đợi VIDEO Pollo
  // (2 hàng đợi độc lập). Khi tính tổng task đồng thời tối đa trên tài
  // khoản pollo.ai, cộng polloImageConcurrency + polloVideoConcurrency
  // (không phải chỉ 1 trong 2) — và cùng lưu ý chia tĩnh cho 2 máy khác
  // nhau như polloVideoConcurrency ở trên.
  polloImageConcurrency: Number(process.env.POLLO_IMAGE_CONCURRENCY ?? 2),

  // Tính năng gen video qua ComfyUI (workflow LTX-2 frame-to-video, self-host
  // — xem src/automation/comfyui.ts) — PROVIDER KHÁC HẲN 2 provider trên
  // (AIVideo/pollo.ai): gọi THẲNG REST API của chính ComfyUI (server chạy
  // local/mạng nội bộ, KHÔNG cần Playwright/trình duyệt, không cần session
  // đăng nhập gì cả — ComfyUI mặc định không có auth).
  comfyUIBaseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
  // Thời gian tối đa chờ 1 video ComfyUI generate xong (ms). Mặc định 20
  // phút — cùng bậc với generationTimeoutMs của AIVideo/pollo, workflow
  // LTX-2 chạy trên GPU cục bộ có thể nhanh/chậm rất khác tuỳ phần cứng.
  comfyUIGenerationTimeoutMs: Number(
    process.env.COMFYUI_GENERATION_TIMEOUT_MS ?? 20 * 60 * 1000,
  ),
  // Số sampling steps cho workflow MiniMax H3 "Reference to Video" (nhánh
  // "Full" khi Lightning LoRA tắt — node "143" trong
  // comfyuiWorkflows/minimax-h3-reference-to-video.json, xem
  // generateVideoComfyMiniMaxH3 trong comfyui.ts) — trước đây hardcode trong
  // chính file JSON template, giờ đọc qua config để đổi được không cần sửa
  // file JSON. Mặc định 8 (khớp giá trị đang có trong template).
  comfyUIMiniMaxH3Steps: Number(process.env.COMFYUI_MINIMAX_H3_STEPS ?? 8),
  // Độ phân giải đích (megapixel) cho workflow MiniMax H3 — node "115"
  // ResolutionSelector trong comfyuiWorkflows/minimax-h3-reference-to-video.json,
  // xem generateVideoComfyMiniMaxH3 trong comfyui.ts. Trước đây hardcode
  // trong chính file JSON template (0.4 — xác nhận qua lỗi thật: video 9:16
  // xuất ra ĐÚNG 480x864, hình không đủ nét cho nội dung premium). Mặc định
  // 0.4 (giữ nguyên hành vi cũ) — tăng lên (vd 1.0, gần 720p) cho hình nét
  // hơn, đổi lại generate chậm hơn/tốn VRAM hơn trên ComfyUI.
  comfyUIMiniMaxH3Megapixels: Number(
    process.env.COMFYUI_MINIMAX_H3_MEGAPIXELS ?? 0.4,
  ),
};

// if (config.admins.length === 0) {
//   console.warn(
//     "[config] ADMINS trống — không ai có quyền dùng bot. Thêm Telegram user id vào ADMINS trong .env (cách nhau bởi dấu phẩy).",
//   );
// }
