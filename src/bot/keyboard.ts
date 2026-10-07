import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Video - frame bắt đầu";
export const IMAGE_BUTTON_LABEL = "Image";
export const VIDEO_REF_BUTTON_LABEL = "Video - Tham chiếu ảnh";
export const CHARACTER_REF_BUTTON_LABEL = "Video - Tham chiếu nhân vật";
export const OMNI_REF_BUTTON_LABEL = "Video - Tham chiếu toàn diện";
export const CHATAI_BUTTON_LABEL = "Tạo video từ kịch bản";
/** Giống CHATAI_BUTTON_LABEL nhưng CHỈ hỏi ChatAI + tải file JSON về gửi lại luôn — không gen ảnh/video (xem submitChatAIJob, processChatAIQueue). */
export const CHATAI_CHECK_BUTTON_LABEL = "Check prompt kịch bản";
/**
 * User upload 1 video (KHÔNG phải kịch bản text) — bot upload video này +
 * master prompt prompt_split_video.txt lên ChatAI, chờ ChatAI phân tích rồi
 * trả file JSON storyboard, gửi lại cho user KÈM nút xác nhận "Tạo ảnh
 * (Pollo)" — cùng luồng xác nhận với CHATAI_BUTTON_LABEL/
 * CHATAI_CHECK_BUTTON_LABEL sau khi có JSON (xem submitScriptReferenceVideoJob,
 * processChatAIQueue).
 */
export const SCRIPT_REFERENCE_BUTTON_LABEL = "Tham chiếu kịch bản";
/**
 * GẦN GIỐNG SCRIPT_REFERENCE_BUTTON_LABEL (cùng askChatAIAboutReferenceVideo,
 * cùng job "scriptReferenceVideo"/processChatAIQueue) nhưng
 * KHÁC 2 điểm: (1) master prompt dùng config.promptVideoReference thay vì
 * config.promptSplitVideo — JSON trả về chia thành các đoạn VIDEO NGẮN nối
 * tiếp (tối đa 15s/đoạn, ranh giới cắt theo lời thoại/diễn biến hợp lý —
 * xem mục 3B trong prompt_video_reference.txt), KHÁC prompt_split_video.txt
 * ở chỗ không chia theo diễn biến/cảnh (không có SHOT nhiều CLIP thời lượng
 * tự do) mà chia đều theo ngân sách thời lượng cố định; (2) job đặt
 * skipImageConfirmation=true — CHỈ dừng ở bước gửi lại JSON cho user, KHÔNG
 * tạo folder generated/, KHÔNG gửi nút xác nhận "Tạo ảnh" (khác hẳn
 * SCRIPT_REFERENCE_BUTTON_LABEL, xem xử lý trong processChatAIQueue).
 */
export const VIDEO_REFERENCE_BUTTON_LABEL = "Tham chiếu video";
/**
 * GẦN GIỐNG VIDEO_REFERENCE_BUTTON_LABEL (cùng askQwenAboutReferenceVideo,
 * cùng job "scriptReferenceVideo"/processChatAIQueue, skipImageConfirmation=
 * true) nhưng KHÁC 2 điểm: (1) master prompt dùng config.promptVideoReferenceTest
 * (file prompt.txt ở gốc repo, schema CHARACTER/LOCATION/PROP/OBJECT + VIDEO,
 * xem prompt.txt) thay vì config.promptVideoReference; (2) job đặt thêm
 * verifyPromptTest=true — SAU KHI có JSON, bot tự upload LẠI CHÍNH video gốc
 * + JSON vừa tạo lên Qwen lần nữa để ĐỐI CHIẾU xem JSON có mô tả đúng video
 * thật không (xem verifyReferenceVideoJson trong qwenAI.ts), rồi gửi báo cáo
 * đối chiếu đó cho user — dùng để TEST độ chính xác của prompt.txt.
 */
export const TEST_VIDEO_REFERENCE_BUTTON_LABEL = "Test prompt tham chiếu video";
/**
 * GIỐNG UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL HỆT nhưng ghi đè
 * config.promptVideoReferenceTest (prompt.txt, dùng cho
 * TEST_VIDEO_REFERENCE_BUTTON_LABEL) thay vì prompt_video_reference.txt.
 */
export const UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt test tham chiếu video";
/**
 * User gõ tên (1 phần của tên) file JSON storyboard đã có sẵn trong
 * storage/chatai-results — bot tìm TẤT CẢ file JSON có tên CHỨA chuỗi đó
 * (có thể khớp nhiều file = nhiều tập phim), gửi ghép nội dung các file đó +
 * master prompt config.promptGenerateScript lên ChatAI, yêu cầu viết lại
 * thành 1 bộ phim MỚI TƯƠNG TỰ (đổi kịch bản/nhân vật/bối cảnh/đạo cụ/lời
 * thoại, giữ cấu trúc kỹ thuật dựng phim) rồi trả về NHIỀU file JSON tương
 * ứng từng tập, với id nhân vật/bối cảnh/đạo cụ/vật thể nhất quán xuyên các
 * tập (xem prompt_generate_script.txt, handleGenerateScriptRequest/
 * processChatAIQueue — dùng CHUNG hàng đợi/mảng với ChatAIJob, xem docstring
 * GenerateScriptJob trong queue.ts). Cùng luồng xác nhận "Tạo ảnh (Pollo)"
 * với SCRIPT_REFERENCE_BUTTON_LABEL sau khi có JSON (dùng chung
 * runStoryboardPipelinePollo/notifyChatAISuccess).
 */
export const GENERATE_SCRIPT_BUTTON_LABEL = "Tạo kịch bản mới";
/**
 * Bản KHÁC GENERATE_SCRIPT_BUTTON_LABEL ở trên — thay vì tham chiếu CẢ PHIM
 * (mọi tập) rồi sinh lại toàn bộ trong 1 lần, nút này sinh ĐÚNG 1 TẬP/lần
 * (dùng prompt_generate_script_episode.txt, config.promptGenerateScriptEpisode):
 * user gõ tên/1 phần tên file JSON TẬP GỐC (bắt buộc, dòng 1) dùng làm khung
 * kỹ thuật, và TUỲ CHỌN tên/1 phần tên file JSON TẬP MỚI ngay trước đó (dòng
 * 2, nếu đây là tập tiếp nối) để giữ nhất quán nhân vật/bối cảnh/mạch truyện
 * — xem handleGenerateScriptEpisodeRequest trong handlers.ts. Không có dòng 2
 * = coi đây là tập đầu tiên của 1 phim mới (tự tính remake version mới, cùng
 * cơ chế resolveNextRemakeVersion với GENERATE_SCRIPT_BUTTON_LABEL). Có dòng 2
 * = tiếp nối đúng phim/tên đã tạo ở tập trước (giữ nguyên folder generated/,
 * chỉ tăng số tập).
 */
export const GENERATE_SCRIPT_EPISODE_BUTTON_LABEL = "Tạo kịch bản theo từng tập";
/**
 * Tạo tiếp series đã tạo bằng "Tạo kịch bản mới" (pipeline series Gemini, xem
 * seriesScript.ts): user gõ tên series (vd "9trung_remake_1") — bot tạo từ
 * tập sau tập cuối đã có tới hết các file tham chiếu còn lại.
 */
export const CONTINUE_GENERATE_SCRIPT_BUTTON_LABEL = "Tiếp tục tạo kịch bản";
/**
 * Bất kỳ ai trong nhóm được phép dùng bot (isAllowedGroup, KHÔNG giới hạn
 * admin — theo yêu cầu người dùng) đều bấm được — user upload 1 file .txt
 * để GHI ĐÈ master prompt prompt_generate_script.txt (dùng cho
 * GENERATE_SCRIPT_BUTTON_LABEL), cho phép sửa prompt trực tiếp từ Telegram
 * không cần SSH/sửa file trên server. Bản CŨ được sao lưu thành
 * "prompt_generate_script_vXX.txt" (XX tăng dần, dùng chung nextBackupVersion
 * với tryReplaceGeneratedFile/tryHandleReferenceJsonUpload) TRƯỚC khi ghi
 * đè — không mất bản trước nếu cần khôi phục lại.
 */
export const UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt tạo kịch bản";
/**
 * GIỐNG UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL HỆT (không giới hạn
 * admin, cùng cơ chế sao lưu bản cũ bằng nextBackupVersion trước khi ghi
 * đè, xem handleUpdateMasterPromptUpload) nhưng ghi đè master prompt
 * prompt_generate_script_episode.txt (config.promptGenerateScriptEpisode,
 * dùng cho GENERATE_SCRIPT_EPISODE_BUTTON_LABEL — sinh 1 TẬP/lần) thay vì
 * prompt_generate_script.txt (dùng cho GENERATE_SCRIPT_BUTTON_LABEL — sinh
 * CẢ PHIM/lần) — RIÊNG nút/mode theo đúng quy ước mỗi master prompt 1 nút
 * cập nhật của dự án, không gộp chung rồi chọn file qua tham số.
 */
export const UPDATE_GENERATE_SCRIPT_EPISODE_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt tạo kịch bản theo từng tập";
/**
 * GIỐNG UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL HỆT (không giới hạn
 * admin, cùng cơ chế sao lưu bản cũ bằng nextBackupVersion trước khi ghi
 * đè) nhưng ghi đè master prompt prompt_video_reference.txt (dùng cho
 * VIDEO_REFERENCE_BUTTON_LABEL) thay vì prompt_generate_script.txt — RIÊNG
 * nút/mode theo đúng quy ước clone-theo-provider của dự án, không gộp
 * chung 1 nút rồi chọn file qua tham số.
 */
export const UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL =
  "Cập nhật prompt tham chiếu video";
/** Dừng SỚM các job đang chờ/đang gen ảnh-video của CHARACTER_REF_BUTTON_LABEL và CHATAI_BUTTON_LABEL — xem stopAll() trong queue.ts. */
export const STOP_ALL_BUTTON_LABEL = "🛑 Stop All";
/** Retry job "storyboardVideo" đã lỗi trước đó (xem failedStoryboardJobs/continueFailedStoryboardVideo trong queue.ts) — user nhập tên file json, bot tự tra lại. */
export const CONTINUE_VIDEO_BUTTON_LABEL = "Tiếp tục tạo video";
/**
 * SỬA (theo yêu cầu người dùng): nút này giờ đẩy job "storyboardScenePollo"
 * (pollo.ai) THAY VÌ "storyboardImagesAIVideo" — xem nhánh "continueSceneFrame"
 * trong handlers.ts, cùng cách đã đổi cho CONTINUE_VIDEO_BUTTON_LABEL (Pollo
 * thay AIVideo).
 */
export const CONTINUE_SCENE_FRAME_BUTTON_LABEL = "Tiếp tục tạo frame";
/**
 * GIỐNG CONTINUE_SCENE_FRAME_BUTTON_LABEL HỆT (không tra failedStoryboardJobsPollo
 * — chỉ cần file JSON khớp tên tồn tại trong generated/ là đẩy thẳng job mới,
 * xem nhánh "continueImage" trong handlers.ts) nhưng đẩy job
 * "storyboardImagesPollo" (gen ảnh CHARACTER/LOCATION qua pollo.ai, xem
 * generateReferenceImagesForFileViaPollo trong storyboardPipeline.ts) THAY VÌ
 * "storyboardScenePollo" — dùng khi cần gen lại/tiếp tục ảnh CHARACTER/
 * LOCATION còn thiếu/lỗi (khác CONTINUE_SCENE_FRAME_BUTTON_LABEL chỉ lo ảnh
 * SCENE_SETTING_START/END).
 */
export const CONTINUE_IMAGE_BUTTON_LABEL = "Tiếp tục tạo ảnh";
/**
 * User gõ tên (1 phần của tên) file JSON storyboard ĐÃ CÓ SẴN trong
 * storage/generated (đã gen xong toàn bộ entry VIDEO — tìm qua
 * resolveExistingGeneratedJsonPath, CÙNG cách tra file với
 * CONTINUE_VIDEO_BUTTON_LABEL) — bot đọc JSON, lấy các entry VIDEO, GHÉP lại
 * theo ĐÚNG thứ tự timeline (shot rồi clip, xem mergeVideosForFile trong
 * storyboardPipeline.ts — dùng chung logic với bước ghép cuối của
 * TEST_VIDEO_REFERENCE_BUTTON_LABEL), lưu video kết quả CÙNG TÊN với file
 * JSON (chỉ khác đuôi .mp4) vào ĐÚNG folder generated/ chứa JSON đó — sau đó
 * publish THÊM 1 bản ra QWEN_PUBLIC_BASE_URL (qwenFileServer.ts, xem
 * handlers.ts) để xem trực tiếp qua link, gửi LINK đó cho user (KHÔNG gửi
 * nguyên file qua Telegram). KHÔNG tự gen thiếu — entry VIDEO nào chưa có
 * file .mp4 trên đĩa thì báo lỗi rõ ràng, không ghép thiếu clip.
 */
export const MERGE_VIDEO_BUTTON_LABEL = "Nối video";
/**
 * User gõ tên file JSON storyboard ở DÒNG ĐẦU, và MỖI DÒNG TIẾP THEO là 1
 * đoạn thời gian bị lỗi TRÊN VIDEO ĐÃ GHÉP (kết quả MERGE_VIDEO_BUTTON_LABEL
 * — timeline tính THEO ĐÚNG cách mergeVideosForFile ghép, xem
 * buildVideoTimeline trong storyboardPipeline.ts), dạng "mốc1-mốc2" — mốc
 * chấp nhận giây ("12"), "mm:ss" ("1:05") hay "hh:mm:ss" ("1:02:05"), tự
 * nhận diện qua số dấu ":" (xem parseTimeRangeMark trong handlers.ts).
 *
 * Bot cộng dồn VIDEO.duration theo đúng thứ tự timeline (shot rồi clip) để
 * suy ra mốc [start,end) của TỪNG clip, đối chiếu với (các) đoạn lỗi user
 * nhập ra đúng (các) clip bị CHỒNG LẤN (1 đoạn lỗi vắt ngang ranh giới 2 clip
 * thì tính CẢ HAI). Clip nào khớp: đánh dấu success=false, XOÁ file .mp4 cũ
 * (cùng cách regenerateStoryboardItemLine đang làm cho luồng "<file>__<id>"),
 * rồi đẩy 1 job "storyboardVideoComfy" DUY NHẤT cho cả file — job tự CHỈ gen
 * lại entry nào success != true (entry còn success=true bị bỏ qua, xem
 * generateVideosForFileComfyUI), không đụng tới các clip không liên quan.
 * Trả lời user rõ mốc thời gian nào ứng với clip (id) nào sẽ được gen lại.
 */
export const REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL = "Gen lại video lỗi";

export const promptMenu = Markup.keyboard([
  [CHATAI_CHECK_BUTTON_LABEL, CHATAI_BUTTON_LABEL],
  [VIDEO_REFERENCE_BUTTON_LABEL, GENERATE_SCRIPT_BUTTON_LABEL],
  [CONTINUE_GENERATE_SCRIPT_BUTTON_LABEL],
  [GENERATE_SCRIPT_EPISODE_BUTTON_LABEL, UPDATE_GENERATE_SCRIPT_EPISODE_PROMPT_BUTTON_LABEL],
  [CONTINUE_IMAGE_BUTTON_LABEL, CONTINUE_VIDEO_BUTTON_LABEL],
  [UPDATE_GENERATE_SCRIPT_PROMPT_BUTTON_LABEL, UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL],
  // [TEST_VIDEO_REFERENCE_BUTTON_LABEL, UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL],
  [MERGE_VIDEO_BUTTON_LABEL, REGENERATE_VIDEO_BY_TIME_BUTTON_LABEL],
  [STOP_ALL_BUTTON_LABEL],
  // [IMAGE_BUTTON_LABEL, PROMPT_BUTTON_LABEL],
  // [VIDEO_REF_BUTTON_LABEL, CHARACTER_REF_BUTTON_LABEL],
  // [OMNI_REF_BUTTON_LABEL],
]).resize();
