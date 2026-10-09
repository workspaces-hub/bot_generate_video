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

  // Theo yêu cầu người dùng: clone askChatAI sang Gemini web (gemini.google.com,
  // Playwright — xem geminiAI.ts). CHATAI_PROVIDER=gemini thì job ChatAI
  // (prompt/file, "Tạo kịch bản mới") và "Tham chiếu video"/"Tham chiếu kịch
  // bản" dùng Gemini thay ChatGPT; mặc định "chatgpt" (giữ hành vi cũ).
  chatAIProvider:
    (process.env.CHATAI_PROVIDER ?? "chatgpt").toLowerCase() === "gemini"
      ? ("gemini" as const)
      : ("chatgpt" as const),
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? "https://gemini.google.com/app",
  // Session RIÊNG cho tài khoản Google dùng Gemini — đăng nhập bằng
  // `npm run login-gemini` (scripts/login-gemini.ts).
  geminiStorageStatePath: path.resolve(
    process.env.GEMINI_STORAGE_STATE_PATH ?? "./storage/gemini-session.json",
  ),
  // Theo yêu cầu người dùng: session RIÊNG (tài khoản Google khác) cho tạo ảnh
  // bằng Gemini (geminiImage.ts) — hạn mức tạo ảnh/tin nhắn không ăn vào tài
  // khoản askGemini. Đăng nhập bằng `npm run login-gemini -- image`.
  geminiImageStorageStatePath: path.resolve(
    process.env.GEMINI_IMAGE_STORAGE_STATE_PATH ?? "./storage/gemini-image-session.json",
  ),
  // Text (khớp 1 phần, không phân biệt hoa thường) của model cần chọn trong
  // menu chọn model của Gemini, vd "2.5 Pro" / "Pro". Để trống = giữ model
  // đang mặc định của tài khoản.
  // Theo yêu cầu người dùng: mặc định chọn "Flash-Lite". Đặt GEMINI_MODEL_LABEL
  // khác (vd "Flash", "Pro") để đổi; để rỗng ("") thì giữ model mặc định.
  geminiModelLabel: process.env.GEMINI_MODEL_LABEL ?? "3.5 Flash-Lite",
  // Số lượt tối đa gom JSON nhiều phần (mỗi lượt Gemini gửi 1 phần + marker
  // "ĐÃ HOÀN THÀNH" ở lượt cuối, xem askGemini).
  geminiMaxTurns: Number(process.env.GEMINI_MAX_TURNS ?? 1000),
  // Giới hạn kích thước khối JSON mỗi lượt Gemini được yêu cầu gửi (ký tự) —
  // gửi NHIỀU item nhất có thể trong mức này. Đo thật: khối 10–21k ký tự vẫn
  // hợp lệ; khối hỏng xảy ra cả ở 500 ký tự (do mất ngữ cảnh, không phải độ dài).
  geminiMaxCharsPerTurn: Number(process.env.GEMINI_MAX_CHARS_PER_TURN ?? 20000),
  // Số lần thử upload file (video/kịch bản) lên Gemini trước khi chịu thua —
  // chờ tăng dần giữa các lần (xem uploadFileWithRetry trong geminiAI.ts).
  geminiUploadMaxAttempts: Number(process.env.GEMINI_UPLOAD_MAX_ATTEMPTS ?? 2),
  // Có đi qua proxy như ChatGPT không (mặc định có — dùng chung PROXY_*).
  geminiUseProxy: (process.env.GEMINI_USE_PROXY ?? "true").toLowerCase() !== "false",

  // Theo yêu cầu người dùng: gen ảnh bằng pollo.ai lỗi thì fallback sang
  // provider nào (xem generateImage trong polloImage.ts): "gpt" (mặc định,
  // ChatGPT — generateReferenceImage), "gemini" (generateImageGemini), "none"
  // (không fallback, báo lỗi luôn).
  polloImageFallback: (() => {
    const value = (process.env.POLLO_IMAGE_FALLBACK ?? "gpt").toLowerCase();
    return value === "gemini" || value === "none" ? value : "gpt";
  })() as "gpt" | "gemini" | "none",

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
  // Master prompt cho tính năng "Test prompt tham chiếu video" (nút
  // TEST_VIDEO_REFERENCE_BUTTON_LABEL) — GIỐNG luồng "Tham chiếu video" ở
  // trên (cùng ScriptReferenceVideoJob/askQwenAboutReferenceVideo) nhưng
  // dùng file prompt.txt ở gốc repo, và job đặt verifyPromptTest=true: sau
  // khi có JSON, gọi THÊM 1 lượt Qwen khác (verifyReferenceVideoJson trong
  // qwenAI.ts) upload lại CHÍNH video gốc + JSON vừa tạo để đối chiếu xem
  // JSON có mô tả đúng video thật không, rồi gửi báo cáo đối chiếu đó cho
  // user (xem processChatAIQueue trong queue.ts).
  promptVideoReferenceTest: "prompt.txt",
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
  // Master prompt cho tính năng "Tạo kịch bản theo từng tập" (nút
  // GENERATE_SCRIPT_EPISODE_BUTTON_LABEL) — KHÁC promptGenerateScript ở trên:
  // sinh ĐÚNG 1 tập/lần thay vì cả phim cùng lúc, tham chiếu 1 tập gốc (khung
  // kỹ thuật) + TUỲ CHỌN tập MỚI ngay trước đó (nguồn ledger/mạch truyện) để
  // tiếp nối đúng nhân vật/bối cảnh/cốt truyện — xem
  // handleGenerateScriptEpisodeRequest trong handlers.ts,
  // prompt_generate_script_episode.txt.
  promptGenerateScriptEpisode: "prompt_generate_script_episode.txt",
  // "Tạo kịch bản mới" nhiều tập bằng Gemini — pipeline series (xem
  // seriesScript.ts): Dramatic DNA từng tập gốc → Series Bible → Season Arc →
  // từng tập + Continuity Ledger → QA toàn series. Mỗi bước 1 master prompt.
  promptSeriesDna: "prompt_series_dna.txt",
  promptSeriesBible: "prompt_series_bible.txt",
  // "Tạo tiếp" series từ tập K: chỉ THÊM nhân vật/bối cảnh/bí mật mới vào Bible đã khoá.
  promptSeriesBibleExtend: "prompt_series_bible_extend.txt",
  promptSeriesArc: "prompt_series_arc.txt",
  promptSeriesLedger: "prompt_series_ledger.txt",
  promptSeriesQa: "prompt_series_qa.txt",
  // Kết quả từng bước của pipeline series, theo tên phim (remakeBaseName) —
  // bước nào đã có file thì bỏ qua (bot restart giữa chừng chạy tiếp).
  seriesDir: path.resolve(process.env.SERIES_DIR ?? "./storage/series"),

  // "Remake phim" (src/film/pipeline.ts): N clip của 1 phim → Global Timeline
  // → phân tích từng clip với Story Memory cuốn chiếu → Story Structure →
  // pipeline series ở trên. Dữ liệu từng phim ở filmsDir/<tên phim>/; clip
  // nguồn đặt trong filmsDir/<tên phim>/source/ (bot tự lưu khi user gửi).
  filmsDir: path.resolve(process.env.FILMS_DIR ?? "./storage/films"),
  promptFilmAnalyze: "prompt_film_analyze.txt",
  promptFilmReconstruct: "prompt_film_reconstruct.txt",
  promptFilmAdaptMap: "prompt_film_adapt_map.txt",
  // "Test prompt remake phim": so sánh video gốc ↔ video remake theo tiêu chí drama (src/film/compare.ts).
  promptFilmCompare: "prompt_film_compare.txt",
  // scripts/compare-same.ts: 2 video có giống nhau về kịch bản/hành động/lời thoại không (nhân vật được đổi).
  promptFilmCompareSame: "prompt_film_compare_same.txt",
  // "Remake phim" chế độ THAY NHÂN VẬT: giữ nguyên bối cảnh/hành động/
  // góc máy/nhịp shot, chỉ thay nhân vật, thoại dịch sang tiếng Anh.
  promptFilmFaithfulBible: "prompt_film_faithful_bible.txt",
  promptFilmFaithfulBibleExtend: "prompt_film_faithful_bible_extend.txt",
  promptFilmFaithfulEpisode: "prompt_film_faithful_episode.txt",
  // "Remake phim" chế độ GIỐNG HỆT GỐC (mặc định): giữ nguyên nhân vật và lời thoại
  // nguyên văn (ngôn ngữ gốc); ảnh nhân vật/bối cảnh đều gen lại.
  promptFilmReplicaBible: "prompt_film_replica_bible.txt",
  promptFilmReplicaBibleExtend: "prompt_film_replica_bible_extend.txt",
  promptFilmReplicaEpisode: "prompt_film_replica_episode.txt",
  // Worker xử lý video (workers/timeline_worker.py — chỉ cần stdlib + ffmpeg).
  filmPythonBin: process.env.FILM_PYTHON_BIN ?? "python3",
  // Ngưỡng đổi cảnh của ffmpeg (0..1) — nhỏ hơn = cắt nhiều shot hơn.
  filmSceneThreshold: Number(process.env.FILM_SCENE_THRESHOLD ?? 0.3),
  // Shot dài hơn mức này bị chia đều (đơn vị phân tích đủ nhỏ để tham chiếu).
  filmMaxSegmentSeconds: Number(process.env.FILM_MAX_SEGMENT_SECONDS ?? 12),
  // Shot ngắn hơn mức này gộp vào shot trước (giảm nhiễu scene-detect).
  filmMinSegmentSeconds: Number(process.env.FILM_MIN_SEGMENT_SECONDS ?? 1),
  // Model faster-whisper (tuỳ chọn — chưa cài thì bỏ qua, Gemini tự nghe thoại).
  filmWhisperModel: process.env.FILM_WHISPER_MODEL ?? "small",
  // Phân tích phim gốc xong thì xoá video gốc trong source/ (giữ clip cuối
  // để đợt sau dò ranh giới). FILM_KEEP_SOURCE_VIDEOS=true để giữ lại.
  filmDeleteSourceAfterAnalyze: process.env.FILM_KEEP_SOURCE_VIDEOS?.toLowerCase() !== "true",
  // Model Gemini RIÊNG cho các bước LLM của pipeline phim (phân tích tập, cấu
  // trúc truyện, ánh xạ) — xem video dài + giữ đủ schema cần model mạnh hơn
  // Flash-Lite. Ghi đúng tên trong menu chọn model của Gemini (vd "3.5 Pro");
  // để trống = dùng GEMINI_MODEL_LABEL như mọi tác vụ khác.
  filmGeminiModelLabel: process.env.FILM_GEMINI_MODEL_LABEL ?? "",
  // Số tập tối đa mỗi đợt viết kịch bản remake (1 Season Arc/QA mỗi đợt) — bản
  // remake mới của phim dài được chia nhiều đợt nối tiếp trong cùng 1 job.
  filmRemakeChunkEpisodes: Number(process.env.FILM_REMAKE_CHUNK_EPISODES ?? 10),

  // Theo yêu cầu người dùng: bản clone của askChatAIAboutReferenceVideo dùng
  // API Qwen (qua OpenRouter, KHÔNG phải browser automation) thay vì
  // ChatGPT/Playwright — xem askQwenAboutReferenceVideo trong qwenAI.ts. Lấy
  // API key tại https://openrouter.ai/settings/keys.
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  // Slug model do người dùng cung cấp trực tiếp (xác nhận qua yêu cầu người
  // dùng — KHÔNG tự đoán/sửa lại) — nếu OpenRouter báo lỗi "model not found",
  // kiểm tra lại đúng slug tại https://openrouter.ai/models rồi override qua
  // biến môi trường này, không cần sửa code.
  qwenOmniModel: process.env.QWEN_OPENROUTER_MODEL ?? "qwen3.8-omni-flash",

  // SỬA (xác nhận qua lỗi thật: video 28.7MB base64 hoá ~38MB bị OpenRouter
  // trả 413 Request Entity Too Large): base64 inline không dùng được với
  // video thật — chuyển sang serve video qua 1 static file server nhỏ ngay
  // trên VPS (xem qwenFileServer.ts), gửi URL công khai đó cho OpenRouter
  // thay vì nhúng base64. QWEN_PUBLIC_BASE_URL PHẢI là URL công khai trỏ tới
  // đúng VPS đang chạy bot (vd "http://<ip-vps>:8787") — để trống thì
  // askQwenAboutReferenceVideo báo lỗi rõ ràng thay vì âm thầm dùng URL sai.
  qwenPublicBaseUrl: process.env.QWEN_PUBLIC_BASE_URL ?? "",
  // SỬA (theo yêu cầu người dùng): cho phép TẮT hẳn đường publish URL công
  // khai (qwenFileServer.ts) cho video tham chiếu (askQwenAboutReferenceVideo)
  // — hữu ích khi chạy LOCAL không có URL công khai đáng tin cậy (localhost
  // không được, tunnel free-tier như ngrok đôi khi lỗi vặt, xem lỗi thật
  // "Missing Content-Length of multimodal url"/"URL does not appear to be
  // valid"). Mặc định TRUE (giữ nguyên hành vi cũ — video đã được
  // compressVideoForQwen nén nhỏ trước khi publish, nhưng vẫn ưu tiên URL vì
  // đây là đường ĐÃ XÁC NHẬN hoạt động ổn định trên VPS thật). Đặt "false" để
  // gửi THẲNG video base64 inline (video_url.url = "data:video/mp4;base64,...")
  // thay vì publish — chỉ nên dùng khi video đã nén đủ nhỏ (base64 hoá còn
  // lớn dễ bị OpenRouter trả 413, xem lịch sử comment qwenOmniModel phía
  // trên — lý do ban đầu chuyển sang URL).
  qwenVideoUsePublicUrl:
    (process.env.QWEN_VIDEO_USE_PUBLIC_URL ?? "true") !== "false",
  qwenFileServerPort: Number(process.env.QWEN_FILE_SERVER_PORT ?? 8787),
  qwenFileServeDir: path.resolve(
    process.env.QWEN_FILE_SERVE_DIR ?? "./storage/qwen-public-tmp",
  ),
  // Số lượt tối đa cho chiến lược "mỗi lượt 1 phần JSON hoàn chỉnh" (xem
  // askQwenAboutReferenceVideo/askQwen trong qwenAI.ts) — trước đây hardcode
  // = 20, chuyển qua env để chỉnh được không cần sửa code/build lại (vd tăng
  // lên nếu video dài/nội dung nhiều khiến 20 lượt chưa đủ để model gửi hết).
  qwenMaxPartTurns: Number(process.env.QWEN_MAX_PART_TURNS ?? 20),

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

  // Theo yêu cầu người dùng: true (mặc định, giữ hành vi cũ) thì gửi nút xác
  // nhận "Tạo ảnh"/"Tạo video" như trước; false thì đẩy thẳng job vào hàng đợi
  // tạo ảnh/video, không cần bấm nút (xem queue.ts).
  confirmImageGeneration:
    (process.env.CONFIRM_IMAGE_GENERATION ?? "true").toLowerCase() !== "false",
  confirmVideoGeneration:
    (process.env.CONFIRM_VIDEO_GENERATION ?? "true").toLowerCase() !== "false",

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
  // Nối frame cuối clip trước (cùng shot) làm ảnh tham chiếu cho clip sau khi
  // gen ComfyUI — giữ liền mạch tư thế/vị trí qua chỗ chia clip (xem
  // previousClipLastFrame trong storyboardPipeline.ts). "false" để tắt.
  comfyUIChainLastFrame: (process.env.COMFYUI_CHAIN_LAST_FRAME ?? "false").toLowerCase() !== "false",
  comfyUIMiniMaxH3Megapixels: Number(
    process.env.COMFYUI_MINIMAX_H3_MEGAPIXELS ?? 0.4,
  ),
};

// if (config.admins.length === 0) {
//   console.warn(
//     "[config] ADMINS trống — không ai có quyền dùng bot. Thêm Telegram user id vào ADMINS trong .env (cách nhau bởi dấu phẩy).",
//   );
// }
