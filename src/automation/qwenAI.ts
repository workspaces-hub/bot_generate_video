import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config";
import { publishFileTemporarily } from "./qwenFileServer";
import {
  findDanglingAssetRefs,
  type StoryboardEntry,
} from "./storyboardPipeline";

const execFileAsync = promisify(execFile);

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const DONE_MARKER = "ĐÃ HOÀN THÀNH";
// Đọc từ .env (QWEN_MAX_PART_TURNS, xem config.ts) thay vì hardcode — chỉnh
// được không cần sửa code/build lại.
const MAX_PART_TURNS = config.qwenMaxPartTurns;
const PROVIDER_ERROR_MAX_RETRIES = 3;
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_BITRATE = "64k";
// SỬA (xác nhận qua debug thật, job test-qwen-1790561343021, lượt 2): request
// KHÔNG hề set max_tokens trước đây — text trả về bị CẮT GIỮA CHỪNG thật sự
// (chỉ 1 dấu ``` mở, không đóng; dừng đột ngột giữa 1 chuỗi) dù finish_reason
// báo "stop" (không phải "length" như lẽ ra phải có khi bị cắt do token —
// nghi ngờ OpenRouter/Alibaba chuẩn hoá sai finish_reason cho model này).
// Set max_tokens CAO hẳn lên để loại trừ khả năng đang dùng default thấp của
// provider — nếu vẫn còn cắt sau khi đổi, nguyên nhân KHÔNG phải max_tokens.
const MAX_OUTPUT_TOKENS = 32000;

export class QwenAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenAIError";
  }
}

type OpenRouterTextPart = {
  type: "text";
  text: string;
};

type OpenRouterVideoPart = {
  type: "video_url";
  video_url: {
    url: string;
  };
};

type OpenRouterAudioPart = {
  type: "input_audio";
  input_audio: {
    data: string;
    format: "mp3";
  };
};

type OpenRouterContentPart =
  | OpenRouterTextPart
  | OpenRouterVideoPart
  | OpenRouterAudioPart;

interface OpenRouterMessage {
  role: "user" | "assistant" | "system";
  content: string | OpenRouterContentPart[];
}

interface CallOpenRouterResult {
  text: string;
  finishReason: string | null;
  errorType: string | null;
}

function extractJsonFromText(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenceMatch ? fenceMatch[1] : text).trim();

  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * SỬA (theo yêu cầu người dùng: file prompt tham chiếu video CÓ THỂ được sửa
 * để yêu cầu output là OBJECT thay vì ARRAY — mỗi master prompt tự quyết
 * định schema riêng qua nội dung file .txt, KHÔNG cố định trong code): bản
 * ngay trước đó ép cứng CHỈ chấp nhận ARRAY (fix cho lỗi thật job
 * 54548cd4-c05b-4998-9087-9c3135825fb5 — bản CŨ HƠN NỮA lại ép cứng chỉ chấp
 * nhận OBJECT với 6 key cố định, cũng sai vì không khớp schema thật lúc đó).
 * Cả 2 lần đều sai vì HARD-CODE 1 kiểu duy nhất trong khi schema thực tế do
 * FILE PROMPT (user tự sửa qua UPDATE_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL/
 * UPDATE_TEST_VIDEO_REFERENCE_PROMPT_BUTTON_LABEL) quyết định, có thể đổi bất
 * kỳ lúc nào. Giờ tự DÒ kiểu (array hay object) dựa vào lượt ĐẦU TIÊN model
 * thực sự trả về, rồi merge nhất quán theo đúng kiểu đó cho các lượt sau —
 * hỗ trợ CẢ 2 kiểu mà không cần biết trước đang dùng master prompt nào.
 */
export interface MergeState {
  kind: "unset" | "array" | "object";
  items: unknown[];
  obj: Record<string, unknown>;
}

// SỬA (xác nhận qua log thật): hàm này DÙNG CHUNG cho cả askQwen VÀ
// askQwenAboutReferenceVideo (xem 2 nơi gọi mergeJsonPartAuto) — trước đây
// mọi dòng log bên dưới hardcode cứng tên "askQwenAboutReferenceVideo",
// khiến log của askQwen (vd job "Tạo kịch bản mới") hiện SAI tên hàm, dễ
// tưởng nhầm 2 hàm đang chạy song song trên CÙNG 1 jobId (thực ra không
// phải — processChatAIQueue chỉ gọi ĐÚNG 1 trong 2 hàm cho mỗi job). Bỏ tên
// hàm cụ thể, chỉ giữ "[qwenAI]" + jobId — vẫn đối chiếu được với dòng log
// của đúng hàm đang gọi (in ngay trước/sau) nhờ CÙNG jobId.
export function mergeJsonPartAuto(
  state: MergeState,
  part: unknown,
  jobId: string,
  turn: number,
): void {
  const isArrayPart = Array.isArray(part);
  const isObjectPart = part !== null && typeof part === "object" && !isArrayPart;

  if (!isArrayPart && !isObjectPart) {
    console.warn(
      `[qwenAI] (job ${jobId}) lượt ${turn} trả JSON không phải array/object hợp lệ — bỏ qua: ${JSON.stringify(part).slice(0, 200)}`,
    );
    return;
  }

  if (state.kind === "unset") {
    state.kind = isArrayPart ? "array" : "object";
    // console.log(
    //   `[qwenAI] (job ${jobId}) lượt ${turn} — xác định kiểu kết quả là "${state.kind}" (dựa theo lượt đầu tiên có dữ liệu).`,
    // );
  }

  if (state.kind === "array") {
    if (!isArrayPart) {
      console.warn(
        `[qwenAI] (job ${jobId}) lượt ${turn} — đã bắt đầu theo kiểu ARRAY nhưng lượt này trả OBJECT, bỏ qua (không trộn lẫn 2 kiểu).`,
      );
      return;
    }
    state.items.push(...(part as unknown[]));
    return;
  }

  if (!isObjectPart) {
    console.warn(
      `[qwenAI] (job ${jobId}) lượt ${turn} — đã bắt đầu theo kiểu OBJECT nhưng lượt này trả ARRAY, bỏ qua (không trộn lẫn 2 kiểu).`,
    );
    return;
  }
  for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
    const existing = state.obj[key];
    if (existing === undefined) {
      state.obj[key] = value;
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      state.obj[key] = [...existing, ...value];
    } else {
      console.warn(
        `[qwenAI] (job ${jobId}) lượt ${turn} GHI ĐÈ key "${key}" đã có từ lượt trước (không phải mảng để nối) — có thể model đã lặp lại phần đã gửi.`,
      );
      state.obj[key] = value;
    }
  }
}

async function extractAudioForQwen(
  videoPath: string,
  outputPath: string,
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-c:a",
      "libmp3lame",
      "-b:a",
      AUDIO_BITRATE,
      outputPath,
    ]);
  } catch (err) {
    throw new QwenAIError(
      `Không thể tách audio bằng ffmpeg từ "${videoPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new QwenAIError(
      `FFmpeg không tạo được audio hợp lệ từ "${videoPath}".`,
    );
  }
}

/**
 * Nén 1 bản video NHẸ HƠN riêng để publish cho OpenRouter/Qwen tải (KHÔNG
 * đụng tới videoPath gốc — video gốc vẫn dùng nguyên cho các bước khác của
 * pipeline). Xác nhận qua lỗi thật (job 269504c4-b8bb-4c7d-bc3e-888c72e0cee6,
 * 2026-09-29): sau khi đã sửa xong vấn đề mạng (RunPod TCP port thay vì HTTP
 * proxy — xem qwenFileServer.ts), request TỪ Alibaba ĐÃ tới được server
 * (`[qwenFileServer] Request đến`), nhưng OpenRouter vẫn trả lỗi cụ thể
 * "Download multimodal file timed out" — log server xác nhận client (Alibaba)
 * chủ động đóng kết nối sau ĐÚNG 120222ms, nghĩa là Alibaba tự giới hạn thời
 * gian tải file (~120s) và video gốc (thường vài trăm MB tới hàng GB, có thể
 * dài tới 1 tiếng — xem hội thoại trước) không tải kịp trong ngần đó thời
 * gian qua kết nối thực tế từ VPS/pod.
 *
 * Giải pháp: hạ hẳn kích thước file cần Alibaba tải, KHÔNG cần giữ chất
 * lượng cao — Qwen chỉ cần NHÌN được nội dung (nhân vật/bối cảnh/hành động)
 * để phân tích kịch bản, không phải xem để đánh giá chất lượng hình ảnh.
 * - Hạ độ phân giải xuống tối đa 480p (scale=-2:480, -2 giữ tỉ lệ khung hình
 *   VÀ đảm bảo số chẵn — codec H.264 yêu cầu width/height chia hết cho 2).
 * - Giảm framerate còn 15fps — đủ để nhận diện hành động/chuyển cảnh, không
 *   cần mượt.
 * - CRF 30 (nén nhiều hơn hẳn mức mặc định ~23) — chấp nhận giảm chất lượng
 *   hình để đổi lấy file nhẹ hơn nhiều.
 * - -an (bỏ HẲN track audio) — model đã nhận audio THẬT riêng qua input_audio
 *   (xem QUY TẮC AUDIO/VIDEO BẮT BUỘC trong buildTurnPrompt: model được dặn
 *   dùng input_audio làm nguồn audio chính thức), audio trong chính file
 *   video không cần thiết, bỏ đi giảm thêm dung lượng đáng kể.
 * - -movflags +faststart — đưa metadata (moov atom) lên ĐẦU file thay vì
 *   cuối, để 1 client tải tuần tự (Alibaba fetch qua HTTP) có thể bắt đầu xử
 *   lý sớm hơn thay vì phải tải hết mới đọc được metadata — giảm thêm rủi ro
 *   timeout với file MP4 encode mặc định (moov thường nằm cuối).
 */
async function compressVideoForQwen(
  videoPath: string,
  outputPath: string,
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "scale=-2:480,fps=15",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-an",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } catch (err) {
    throw new QwenAIError(
      `Không thể nén video bằng ffmpeg từ "${videoPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new QwenAIError(
      `FFmpeg không tạo được video nén hợp lệ từ "${videoPath}".`,
    );
  }
}

async function callOpenRouter(
  messages: OpenRouterMessage[],
  jobId: string,
): Promise<CallOpenRouterResult> {
  if (!config.openRouterApiKey) {
    throw new QwenAIError(
      "Thiếu OPENROUTER_API_KEY trong .env — lấy tại https://openrouter.ai/settings/keys",
    );
  }

  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.qwenOmniModel,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");

    // Lỗi tạm thời phía provider khi tải video/audio (URL công khai bị
    // nghẽn/timeout thoáng qua, hoặc qua tunnel free-tier như ngrok đôi khi
    // trả response thiếu header/lỗi vặt dù server mình gửi ĐÚNG — xác nhận
    // qua test thật: curl -I qua ngrok LUÔN thấy Content-Length đầy đủ, cùng
    // lúc Alibaba báo "Missing Content-Length of multimodal url") — KHÔNG
    // throw cứng ở đây vì sẽ bỏ qua luôn callOpenRouterWithProviderRetry
    // (throw thoát khỏi vòng lặp retry). Trả về kết quả có cấu trúc để lớp
    // retry xử lý giống provider_unavailable — dù "URL không hợp lệ" thật sự
    // (vd trỏ localhost) sẽ retry vô ích rồi vẫn fail sau
    // PROVIDER_ERROR_MAX_RETRIES lần, không có gì mất thêm ngoài vài giây.
    const isTransientUrlFetchError =
      /failed to download multimodal content/i.test(bodyText) ||
      /missing content-length/i.test(bodyText) ||
      /does not appear to be valid/i.test(bodyText);
    if (isTransientUrlFetchError) {
      console.warn(
        `[qwenAI] callOpenRouter(${jobId}): HTTP ${response.status} — lỗi tải multimodal content tạm thời: ${bodyText.slice(0, 500)}`,
      );
      return {
        text: "",
        finishReason: "error",
        errorType: "download_failed",
      };
    }

    throw new QwenAIError(
      `OpenRouter trả lỗi HTTP ${response.status} (job ${jobId}, model=${config.qwenOmniModel}): ${bodyText.slice(0, 2000)}`,
    );
  }

  const okBodyText = await response.text().catch(() => "");
  let data: {
    choices?: Array<{
      message?: {
        content?: unknown;
        reasoning?: unknown;
      };
      finish_reason?: string | null;
      error?: {
        message?: string;
        metadata?: {
          error_type?: string;
        };
      } | null;
    }>;
  };
  try {
    data = JSON.parse(okBodyText);
  } catch (err) {
    // Body rỗng/không hợp lệ dù HTTP 200 — lỗi mạng thoáng qua (kết nối bị
    // cắt giữa chừng), KHÔNG throw cứng để retry được như provider_unavailable.
    console.warn(
      `[qwenAI] callOpenRouter(${jobId}): body trả về không phải JSON hợp lệ (rỗng hoặc bị cắt): "${okBodyText.slice(0, 500)}"`,
    );
    return {
      text: "",
      finishReason: "error",
      errorType: "invalid_response_body",
    };
  }

  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  const errorType = choice?.error?.metadata?.error_type ?? null;

  if (choice?.error) {
    console.warn(
      `[qwenAI] callOpenRouter(${jobId}): finish_reason=${choice.finish_reason}, choice.error=${JSON.stringify(choice.error).slice(0, 1000)}`,
    );
  }

  if (typeof text !== "string") {
    if (!choice) {
      throw new QwenAIError(
        `OpenRouter trả response không có choices[0] nào (job ${jobId}): ${JSON.stringify(data).slice(0, 2000)}`,
      );
    }

    // content null/thiếu dù CÓ choice — có thể kèm choice.error (lỗi hạ tầng
    // provider, đã xử lý như cũ) HOẶC KHÔNG kèm error gì cả (xác nhận qua lỗi
    // thật, job a272783d-7464-4378-a047-81c3262e4b78: finish_reason="length",
    // message.content=null nhưng message.reasoning có hàng nghìn ký tự — model
    // đốt hết ngân sách token vào "reasoning" trước khi kịp sinh answer thật,
    // KHÔNG phải lỗi hạ tầng provider). CẢ 2 trường hợp đều KHÔNG throw cứng ở
    // đây (sẽ bỏ qua callOpenRouterWithProviderRetry, throw thoát khỏi vòng
    // lặp retry) — trả kết quả có cấu trúc để lớp retry thử lại NGUYÊN
    // request, vì cả 2 đều là lỗi tạm thời/không đoán trước được, thử lại
    // thường thành công (model không nhất thiết lặp lại y hệt lỗi cũ do
    // sampling).
    return {
      text: "",
      finishReason: choice.finish_reason ?? "error",
      errorType: errorType ?? "empty_content",
    };
  }

  return {
    text,
    finishReason: choice?.finish_reason ?? null,
    errorType,
  };
}

async function callOpenRouterWithProviderRetry(
  messages: OpenRouterMessage[],
  jobId: string,
  turnLabel: string,
): Promise<CallOpenRouterResult> {
  let lastResult: CallOpenRouterResult | null = null;

  for (
    let attempt = 1;
    attempt <= PROVIDER_ERROR_MAX_RETRIES;
    attempt++
  ) {
    const result = await callOpenRouter(messages, jobId);
    lastResult = result;

    const isTransientProviderError =
      (result.finishReason === "error" &&
        (result.errorType === "provider_unavailable" ||
          result.errorType === "download_failed" ||
          result.errorType === "invalid_response_body")) ||
      // empty_content GIỮ NGUYÊN finish_reason thật từ API (vd "length", xem
      // callOpenRouter) thay vì ép thành "error" như 3 loại lỗi trên — kiểm
      // tra RIÊNG theo errorType, không gộp chung điều kiện finishReason===
      // "error".
      result.errorType === "empty_content";

    if (
      !isTransientProviderError ||
      attempt === PROVIDER_ERROR_MAX_RETRIES
    ) {
      return result;
    }

    console.warn(
      // KHÔNG hardcode tên hàm gọi (vd "askQwenAboutReferenceVideo") ở đây —
      // callOpenRouterWithProviderRetry là hàm DÙNG CHUNG cho askQwen,
      // askQwenAboutReferenceVideo, reviseGenerationPromptQwen VÀ
      // verifyReferenceVideoJson (xem turnLabel mỗi nơi gọi truyền vào khác
      // nhau). Xác nhận qua log thật: hardcode cứng "askQwenAboutReferenceVideo"
      // trước đây khiến log của askQwen hiện nhầm tên hàm, dễ tưởng nhầm là 2
      // hàm đang chạy song song trên CÙNG 1 jobId (thực ra không phải).
      `[qwenAI] (job ${jobId}) ${turnLabel} — lỗi hạ tầng tạm thời (${result.errorType}), thử lại NGUYÊN request (lần ${attempt + 1}/${PROVIDER_ERROR_MAX_RETRIES})...`,
    );
  }

  return lastResult as CallOpenRouterResult;
}

/**
 * Mô tả trạng thái đã gom được — nhánh theo state.kind ("array" hay
 * "object", xem docstring mergeJsonPartAuto) để model biết CHÍNH XÁC đã tới
 * đâu (điểm neo: số item/id cuối cho array, hoặc danh sách key + số phần tử
 * mỗi key cho object) khi tiếp tục 1 kết quả dài, không lặp/không bỏ sót.
 */
export function describeMergeState(state: MergeState): string {
  if (state.kind === "unset") return "(chưa có dữ liệu nào)";

  if (state.kind === "array") {
    if (state.items.length === 0) return "(chưa có item nào)";
    const lastItem = state.items[state.items.length - 1] as
      | Record<string, unknown>
      | undefined;
    const lastId =
      lastItem && typeof lastItem === "object" && "id" in lastItem
        ? String(lastItem.id)
        : null;
    return `Đang trả lời theo kiểu JSON ARRAY — đã có ${state.items.length} item${lastId ? `, item CUỐI CÙNG có id="${lastId}"` : ""}. Nếu tiếp tục, PHẢI bắt đầu NGAY SAU item cuối trên — KHÔNG lặp lại item đã có, KHÔNG bỏ sót phần nào ở giữa.`;
  }

  const keys = Object.keys(state.obj);
  if (keys.length === 0) return "(chưa có key nào)";
  const keyDetails = keys
    .map((key) => {
      const value = state.obj[key];
      if (Array.isArray(value)) {
        const count = value.length;
        const lastItem = value[count - 1] as
          | Record<string, unknown>
          | undefined;
        const lastId =
          lastItem && typeof lastItem === "object" && "id" in lastItem
            ? String(lastItem.id)
            : null;
        return `- "${key}": ĐÃ CÓ (${count} phần tử${lastId ? `, phần tử CUỐI id="${lastId}"` : ""}). Nếu tiếp tục mảng này, PHẢI bắt đầu NGAY SAU phần tử cuối — KHÔNG lặp lại, KHÔNG bỏ sót.`;
      }
      return `- "${key}": ĐÃ CÓ (đối tượng đơn — coi như xong, không cần gửi lại trừ khi phát hiện sai).`;
    })
    .join("\n");
  return `Đang trả lời theo kiểu JSON OBJECT — các key đã gom được:\n${keyDetails}`;
}

function buildTurnPrompt(
  basePrompt: string,
  state: MergeState,
  turn: number,
  /** true nếu lượt NGAY TRƯỚC bị cắt giữa chừng (JSON không hợp lệ/không đóng) — nhắc model chủ động chia nhỏ hơn NỮA ở lượt này, xem MAX_OUTPUT_TOKENS. */
  lastTurnTruncated = false,
  /** false = bỏ qua "QUY TẮC AUDIO/VIDEO BẮT BUỘC" — dùng cho askQwen (chỉ có text, không có video/audio đính kèm). Mặc định true cho askQwenAboutReferenceVideo. */
  includeVideoAudioRules = true,
): string {
  const completionState = describeMergeState(state);

  const truncationWarning = lastTurnTruncated
    ? `\n\n## CẢNH BÁO — LƯỢT TRƯỚC BỊ CẮT GIỮA CHỪNG\nLượt ngay trước đã trả về JSON KHÔNG HỢP LỆ (bị cắt giữa chừng do quá dài, không đóng được khối). Lượt NÀY hãy chia nhỏ HƠN NỮA để mỗi lượt luôn là JSON hoàn chỉnh.`
    : "";

  const videoAudioRules = includeVideoAudioRules
    ? `

## QUY TẮC AUDIO/VIDEO BẮT BUỘC

Bạn được cung cấp:
1. video gốc dưới dạng video_url;
2. audio được tách trực tiếp từ CHÍNH video đó dưới dạng input_audio.

Hai nguồn là CÙNG MỘT media và cùng timeline.

Khi phân tích:
- dùng VIDEO để xác định nhân vật, bối cảnh, hành động, biểu cảm, vật thể và chronology;
- dùng AUDIO THẬT để xác minh lời nói, ngôn ngữ, nhịp nói, khoảng ngắt, cường độ, cách nhấn và sắc thái cảm xúc phát âm;
- KHÔNG lấy phụ đề cháy làm bằng chứng duy nhất cho lời thoại khi audio nghe được;
- nếu phụ đề cháy khác audio, ưu tiên nội dung thực sự nghe được từ audio và ghi nhận bất đồng nếu schema cho phép;
- KHÔNG được tự tuyên bố "không có kênh âm thanh" chỉ vì video_url riêng lẻ không mang audio: input_audio đã được cung cấp riêng;
- chỉ coi audio là không khả dụng khi input_audio thực sự không thể truy cập hoặc không chứa tín hiệu hữu ích.`
    : "";

  return `${basePrompt}${truncationWarning}${videoAudioRules}

## QUY TẮC TRẢ LỜI NHIỀU LƯỢT — BẮT BUỘC

Kết quả JSON cuối cùng PHẢI ĐÚNG THEO SCHEMA đã mô tả ở master prompt phía trên — có thể là MỘT JSON ARRAY phẳng, hoặc MỘT JSON OBJECT gồm nhiều key, tuỳ theo master prompt yêu cầu. Chọn ĐÚNG 1 kiểu (theo schema master prompt) và giữ NHẤT QUÁN kiểu đó xuyên suốt mọi lượt — TUYỆT ĐỐI KHÔNG đổi giữa array/object giữa các lượt.

KHÔNG cố xuất toàn bộ kết quả trong một lượt.

GIỚI HẠN CỨNG MỖI LƯỢT — TUÂN THỦ NGHIÊM: tối đa 3 item MỚI (nếu schema ARRAY) hoặc tối đa 3 phần tử MỚI gộp trên mọi key (nếu schema OBJECT) cho MỖI LƯỢT, KỂ CẢ khi còn dư chỗ để viết thêm. Đây KHÔNG phải giới hạn "nếu quá dài mới áp dụng" — ÁP DỤNG LUÔN TỪ LƯỢT ĐẦU TIÊN, bất kể lượt đó có vẻ còn ngắn. Thà mất thêm nhiều lượt hơn còn hơn 1 lượt bị cắt giữa chừng thành JSON hỏng (không parse được, mất trắng toàn bộ nội dung của lượt đó). Nếu 1 item/phần tử tự nó đã dài (vd 1 đoạn VIDEO.prompt chi tiết nhiều câu thoại), GIẢM xuống còn 1 item/lượt — ưu tiên TUYỆT ĐỐI việc đóng JSON hợp lệ hơn số lượng item gửi được.

Mỗi lượt:
- chỉ trả về ĐÚNG MỘT khối code \`\`\`json ... \`\`\`;
- nếu schema là ARRAY: bên trong khối là 1 JSON ARRAY hợp lệ, chỉ chứa các item MỚI chưa gửi ở lượt trước (TỐI ĐA 3 item, xem giới hạn cứng ở trên);
- nếu schema là OBJECT: bên trong khối là 1 JSON OBJECT hợp lệ, chỉ chứa 1 vài key/phần tử MỚI chưa gửi ở lượt trước (TỐI ĐA 3 phần tử, xem giới hạn cứng ở trên; nếu 1 key là mảng dài, có thể tiếp tục dùng lại đúng key đó ở lượt sau nhưng chỉ chứa PHẦN TỬ MỚI của mảng, không bọc thêm object cha khác);
- không lặp lại dữ liệu đã gửi nếu không cần thiết;
- TRƯỚC KHI kết thúc phản hồi, TỰ ĐẾM LẠI số dấu ngoặc mở/đóng (\`{\`/\`}\`, \`[\`/\`]\`) của khối JSON vừa viết — nếu còn lệch (chưa đóng đủ), PHẢI hoàn tất việc đóng ngoặc TRƯỚC, kể cả phải cắt bớt nội dung của item cuối đang viết dở để kịp đóng — KHÔNG BAO GIỜ được dừng lại giữa chừng khi ngoặc chưa cân bằng.

Trạng thái đã gom được tới trước lượt ${turn} (dựa CHÍNH XÁC vào đây để biết tiếp tục từ đâu, KHÔNG tự đoán):
${completionState}

Đây là lượt ${turn}/${MAX_PART_TURNS}.

Ở CUỐI tin nhắn của LƯỢT CUỐI CÙNG, sau khối JSON, khi chắc chắn đã gửi ĐỦ toàn bộ theo đúng schema đã mô tả ở master prompt, hãy viết đúng nguyên văn:
${DONE_MARKER}

TUYỆT ĐỐI KHÔNG viết "${DONE_MARKER}" nếu vẫn còn phần chưa gửi.
`;
}

export async function askQwenAboutReferenceVideo(
  videoPath: string,
  jobId: string,
  /** Tên file video gốc — dùng đặt tên JSON kết quả. */
  videoFileName?: string,
  /** Caption/yêu cầu bổ sung từ user — nối vào cuối master prompt. */
  extraInstruction?: string,
  /** Path master prompt. */
  masterPromptPath: string = config.promptSplitVideo,
): Promise<{ downloadedFiles: string[] }> {
  const masterPrompt = await fs.promises.readFile(
    masterPromptPath,
    "utf-8",
  );

  const basePrompt = extraInstruction
    ? `${masterPrompt}

## YÊU CẦU BỔ SUNG TỪ NGƯỜI DÙNG
Ưu tiên áp dụng yêu cầu bổ sung này nếu không xung đột với ràng buộc schema bắt buộc:

${extraInstruction}`
    : masterPrompt;

  await fs.promises.mkdir(config.debugDir, {
    recursive: true,
  });

  const compressedVideoPath = path.join(
    config.debugDir,
    `${jobId}-qwen-video.mp4`,
  );

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): nén video bằng ffmpeg trước khi publish (giảm rủi ro Alibaba tải không kịp trong ~120s)...`,
  );

  await compressVideoForQwen(videoPath, compressedVideoPath);

  const compressedStat = await fs.promises.stat(compressedVideoPath);
  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): video nén còn ${(compressedStat.size / 1024 / 1024).toFixed(2)} MB.`,
  );

  // SỬA (theo yêu cầu người dùng, xem docstring config.qwenVideoUsePublicUrl):
  // nhánh theo config thay vì LUÔN publish URL công khai — false thì gửi
  // THẲNG video base64 inline (KHÔNG cần qwenFileServer/QWEN_PUBLIC_BASE_URL),
  // hữu ích khi chạy local không có URL công khai đáng tin cậy.
  let videoUrl: string;
  let cleanup: () => Promise<void>;
  if (config.qwenVideoUsePublicUrl) {
    console.log(
      `[qwenAI] askQwenAboutReferenceVideo(${jobId}): publish video "${compressedVideoPath}" ra URL công khai tạm thời...`,
    );

    ({ url: videoUrl, cleanup } = await publishFileTemporarily(
      compressedVideoPath,
      `${jobId}${path.extname(compressedVideoPath) || ".mp4"}`,
    ));

    console.log(
      `[qwenAI] askQwenAboutReferenceVideo(${jobId}): video công khai tại ${videoUrl}`,
    );
  } else {
    console.log(
      `[qwenAI] askQwenAboutReferenceVideo(${jobId}): QWEN_VIDEO_USE_PUBLIC_URL=false — gửi video base64 inline (KHÔNG publish URL công khai).`,
    );

    const videoBase64 = await fs.promises.readFile(
      compressedVideoPath,
      "base64",
    );
    videoUrl = `data:video/mp4;base64,${videoBase64}`;
    cleanup = async () => {};
  }

  const audioPath = path.join(
    config.debugDir,
    `${jobId}-qwen-audio.mp3`,
  );

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): tách audio bằng ffmpeg...`,
  );

  await extractAudioForQwen(videoPath, audioPath);

  const audioStat = await fs.promises.stat(audioPath);

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): audio đã tách ${(audioStat.size / 1024 / 1024).toFixed(2)} MB.`,
  );

  const audioBase64 = await fs.promises.readFile(
    audioPath,
    "base64",
  );

  const mergeState: MergeState = { kind: "unset", items: [], obj: {} };
  let sawDoneMarker = false;
  let lastTurnTruncated = false;

  try {
    for (
      let turn = 1;
      turn <= MAX_PART_TURNS;
      turn++
    ) {
      const turnLabel = `lượt ${turn}/${MAX_PART_TURNS}`;

      const turnPrompt = buildTurnPrompt(
        basePrompt,
        mergeState,
        turn,
        lastTurnTruncated,
      );

      const messages: OpenRouterMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "video_url",
              video_url: {
                url: videoUrl,
              },
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: "mp3",
              },
            },
            {
              type: "text",
              text: turnPrompt,
            },
          ],
        },
      ];

      console.log(
        `[qwenAI] askQwenAboutReferenceVideo(${jobId}): ${turnLabel} — gọi OpenRouter (model=${config.qwenOmniModel}, video+audio)...`,
      );

      const {
        text,
        finishReason,
        errorType,
      } = await callOpenRouterWithProviderRetry(
        messages,
        jobId,
        turnLabel,
      );

      console.log(
        `[qwenAI] askQwenAboutReferenceVideo(${jobId}): ${turnLabel} xong, finish_reason=${finishReason}, error_type=${errorType}, độ dài text=${text.length}.`,
      );

      if (
        (finishReason === "error" &&
          (errorType === "provider_unavailable" ||
            errorType === "download_failed" ||
            errorType === "invalid_response_body")) ||
        errorType === "empty_content"
      ) {
        throw new QwenAIError(
          `Qwen/OpenRouter vẫn lỗi (${errorType}) sau ${PROVIDER_ERROR_MAX_RETRIES} lần retry (job ${jobId}, ${turnLabel}).`,
        );
      }

      sawDoneMarker = text.includes(DONE_MARKER);

      const jsonPartText = extractJsonFromText(text);
      lastTurnTruncated = !jsonPartText;

      if (jsonPartText) {
        try {
          const parsedPart = JSON.parse(jsonPartText);
          mergeJsonPartAuto(
            mergeState,
            parsedPart,
            jobId,
            turn,
          );
        } catch (err) {
          console.warn(
            `[qwenAI] askQwenAboutReferenceVideo(${jobId}): lượt ${turn} — parse lại jsonPartText lỗi bất thường:`,
            err,
          );
        }
      } else {
        console.warn(
          `[qwenAI] askQwenAboutReferenceVideo(${jobId}): lượt ${turn} — KHÔNG tìm thấy khối JSON hợp lệ trong text trả lời (nghi bị cắt giữa chừng — lượt sau sẽ được nhắc chia nhỏ hơn).`,
        );
      }

      if (sawDoneMarker) {
        break;
      }
    }
  } finally {
    await cleanup().catch((err) => {
      console.warn(
        `[qwenAI] askQwenAboutReferenceVideo(${jobId}): cleanup video public URL lỗi:`,
        err,
      );
    });

    await fs.promises.unlink(audioPath).catch(() => {});
    await fs.promises.unlink(compressedVideoPath).catch(() => {});
  }

  if (!sawDoneMarker) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) chưa gửi "${DONE_MARKER}" sau ${MAX_PART_TURNS} lượt — kết quả có thể chưa đầy đủ. ${describeMergeState(mergeState)}`,
    );
  }

  const finalResult: unknown =
    mergeState.kind === "array" ? mergeState.items : mergeState.obj;
  const isEmpty =
    mergeState.kind === "unset" ||
    (mergeState.kind === "array" && mergeState.items.length === 0) ||
    (mergeState.kind === "object" &&
      Object.keys(mergeState.obj).length === 0);

  if (isEmpty) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) đã báo "${DONE_MARKER}" nhưng không gom được dữ liệu nào (mọi lượt trả về đều không parse được thành JSON array/object hợp lệ).`,
    );
  }

  // SỬA (xác nhận qua lỗi thật: JSON tham chiếu "CHAR_BALD_MAN_GLASSES"
  // trong VIDEO.ref nhưng KHÔNG có entry CHARACTER nào id đó) — chỉ validate
  // khi kết quả là ARRAY (đúng schema storyboard CHARACTER/LOCATION/PROP/
  // OBJECT/VIDEO có ref, xem findDanglingAssetRefs); kết quả kiểu OBJECT là
  // schema tự do khác (xem describeMergeState), không áp dụng được kiểm tra
  // này. Throw NGAY, KHÔNG lưu file — tốt hơn để lỗi trôi xuống tận bước gen
  // ảnh/video mới phát hiện (tốn API call, thông báo lỗi lúc đó cũng mơ hồ
  // hơn).
  if (mergeState.kind === "array") {
    const danglingRefErrors = findDanglingAssetRefs(
      mergeState.items as StoryboardEntry[],
    );
    if (danglingRefErrors.length > 0) {
      throw new QwenAIError(
        `Qwen (job ${jobId}) tạo JSON có ref trỏ tới asset chưa từng khai báo (${danglingRefErrors.length} lỗi):\n${danglingRefErrors.join("\n")}`,
      );
    }
  }

  await fs.promises.mkdir(config.chatAIResultsDir, {
    recursive: true,
  });

  const baseName = videoFileName
    ? path.basename(
        videoFileName,
        path.extname(videoFileName),
      )
    : `${jobId}`;

  const filePath = path.join(
    config.chatAIResultsDir,
    `${baseName}_full.json`,
  );

  await fs.promises.writeFile(
    filePath,
    JSON.stringify(finalResult, null, 2),
    "utf-8",
  );

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): đã lưu "${filePath}" (kiểu ${mergeState.kind}, ${
      mergeState.kind === "array"
        ? `${mergeState.items.length} item`
        : `${Object.keys(mergeState.obj).length} key`
    }).`,
  );

  return {
    downloadedFiles: [filePath],
  };
}

/**
 * Bản CLONE của askChatAI/askChatAIWithInlineContent (chatAI.ts) — theo yêu
 * cầu người dùng, dùng cho CẢ 2 luồng "chatAI" (prompt tuỳ ý + file đính kèm
 * tuỳ chọn) VÀ "Tạo kịch bản mới" (GenerateScriptJob — xem docstring trong
 * queue.ts, cùng gọi askChatAI ở nhánh else của processChatAIQueue) — 2 luồng
 * này vốn đã dùng CHUNG 1 hàm askChatAI bên ChatGPT, nên cũng dùng chung 1
 * hàm askQwen ở đây.
 *
 * SỬA (xác nhận qua lỗi thật, job 2dd75b09-12f2-41f1-8ea7-62de636d7224):
 * TRƯỚC ĐÂY hàm này tự viết riêng 1 vòng lặp multi-turn kiểu "conversation
 * NGÀY CÀNG DÀI" (đẩy thêm assistant+user vào messages mỗi lượt) — CHÍNH kiểu
 * này đã gây lỗi data_inspection_failed (input bị Alibaba coi là chứa nội
 * dung không phù hợp) khi context tích luỹ đủ dài, y hệt lỗi đã gặp và ĐÃ SỬA
 * cho askQwenAboutReferenceVideo trước đó (xem lịch sử sửa buildTurnPrompt/
 * MergeState) — nhưng askQwen lại không được áp dụng cùng bản sửa. Giờ dùng
 * LẠI CHÍNH cơ chế "fresh-per-turn" đã chứng minh ổn định của
 * askQwenAboutReferenceVideo: mỗi lượt xây messages MỚI HOÀN TOÀN từ đầu
 * (không tích luỹ lịch sử hội thoại), nhúng thẳng trạng thái đã gom được
 * (describeMergeState) vào prompt để model biết tiếp tục từ đâu — tránh hẳn
 * context phình to theo thời gian.
 *
 * KHÁC askQwenAboutReferenceVideo: KHÔNG có video/audio (chỉ text + file đính
 * kèm dạng text nếu có, không upload), nên buildTurnPrompt gọi với
 * includeVideoAudioRules=false. Vẫn dùng CHUNG MergeState/mergeJsonPartAuto
 * (tự dò kết quả là ARRAY hay OBJECT dựa theo lượt đầu tiên) — KHÔNG còn ép
 * cứng phải là ARRAY như bản cũ, vì prompt_generate_script.txt cũng có thể
 * được user tự sửa đổi schema như file prompt tham chiếu video.
 *
 * KHÔNG upload file đính kèm nào — nếu có promptAttachmentPath, đọc THẲNG
 * nội dung text rồi dán vào đầu prompt (giống cách askChatAIWithInlineContent
 * làm khi dùng làm fallback), vì OpenRouter/Qwen ở đây chỉ nhận text.
 */
export async function askQwen(
  prompt: string,
  jobId: string,
  /** Tên file .txt/.md gốc (nếu có) — dùng đặt tên file JSON kết quả. */
  promptFileName?: string,
  /** Path local file nội dung đính kèm (nếu có) — đọc thẳng làm text, dán vào đầu prompt (KHÔNG upload). */
  promptAttachmentPath?: string,
): Promise<{ downloadedFiles: string[] }> {
  const fileContent = promptAttachmentPath
    ? await fs.promises
        .readFile(promptAttachmentPath, "utf-8")
        .catch(() => null)
    : null;

  const basePrompt = fileContent
    ? `${fileContent}\n\n${prompt}`
    : prompt;

  const mergeState: MergeState = { kind: "unset", items: [], obj: {} };
  let sawDoneMarker = false;
  let lastTurnTruncated = false;

  for (let turn = 1; turn <= MAX_PART_TURNS; turn++) {
    const turnLabel = `lượt ${turn}/${MAX_PART_TURNS}`;
    console.log(
      `[qwenAI] askQwen(${jobId}): ${turnLabel} — gọi OpenRouter (model=${config.qwenOmniModel})...`,
    );

    const turnPrompt = buildTurnPrompt(
      basePrompt,
      mergeState,
      turn,
      lastTurnTruncated,
      false,
    );
    const messages: OpenRouterMessage[] = [
      { role: "user", content: turnPrompt },
    ];

    const { text } = await callOpenRouterWithProviderRetry(
      messages,
      jobId,
      turnLabel,
    );
    console.log(
      `[qwenAI] askQwen(${jobId}): ${turnLabel} xong, độ dài text=${text.length}.`,
    );

    sawDoneMarker = text.includes(DONE_MARKER);
    const jsonPartText = extractJsonFromText(text);
    lastTurnTruncated = !jsonPartText;

    if (jsonPartText) {
      try {
        const parsedPart = JSON.parse(jsonPartText);
        mergeJsonPartAuto(mergeState, parsedPart, jobId, turn);
      } catch (err) {
        console.warn(
          `[qwenAI] askQwen(${jobId}): lượt ${turn} — parse lại jsonPartText lỗi bất thường:`,
          err,
        );
      }
    } else {
      console.warn(
        `[qwenAI] askQwen(${jobId}): lượt ${turn} — KHÔNG tìm thấy khối JSON hợp lệ trong text trả lời (nghi bị cắt giữa chừng — lượt sau sẽ được nhắc chia nhỏ hơn).`,
      );
    }

    console.log(
      `[qwenAI] askQwen(${jobId}): lượt ${turn} — kiểu "${mergeState.kind}", ${
        mergeState.kind === "array"
          ? `${mergeState.items.length} item`
          : mergeState.kind === "object"
            ? `${Object.keys(mergeState.obj).length} key`
            : "chưa có dữ liệu"
      }, marker "${DONE_MARKER}": ${sawDoneMarker ? "CÓ" : "chưa"}.`,
    );

    if (sawDoneMarker) break;
  }

  if (!sawDoneMarker) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) chưa gửi "${DONE_MARKER}" sau ${MAX_PART_TURNS} lượt — kết quả có thể chưa đầy đủ.`,
    );
  }

  const finalResult: unknown =
    mergeState.kind === "object" ? mergeState.obj : mergeState.items;
  const isEmpty =
    mergeState.kind === "unset" ||
    (mergeState.kind === "array" && mergeState.items.length === 0) ||
    (mergeState.kind === "object" &&
      Object.keys(mergeState.obj).length === 0);
  if (isEmpty) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) báo đã hoàn thành nhưng không có dữ liệu JSON nào.`,
    );
  }

  await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
  const baseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : `qwen-${jobId}`;
  const filePath = path.join(config.chatAIResultsDir, `${baseName}.json`);
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(finalResult, null, 2),
    "utf-8",
  );
  console.log(
    `[qwenAI] askQwen(${jobId}): đã lưu "${filePath}" (kiểu ${mergeState.kind}, ${
      mergeState.kind === "array"
        ? `${mergeState.items.length} item`
        : `${Object.keys(mergeState.obj).length} key`
    }).`,
  );

  return { downloadedFiles: [filePath] };
}

/** Dọn markdown/dấu ngoặc thừa quanh prompt model trả về — y hệt cleanRevisedPrompt (chatAI.ts, hàm KHÔNG export nên viết lại thay vì import). */
function cleanRevisedPromptQwen(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/**
 * Bản CLONE của reviseGenerationPrompt (chatAI.ts) — nhờ Qwen viết lại 1
 * prompt tạo ảnh/video đã bị AIVideo từ chối vì vi phạm chính sách nội dung.
 * Nhẹ nhất trong 3 hàm clone (askQwenAboutReferenceVideo/askQwen/hàm này) —
 * chỉ cần 1 câu trả lời TEXT NGẮN, không cần chiến lược "nhiều phần JSON".
 */
export async function reviseGenerationPromptQwen(
  prompt: string,
  violationReason: string,
  jobId: string,
): Promise<string> {
  const message = `Prompt sau đây bị công cụ tạo ảnh/video (Hailuo) từ chối vì vi phạm chính sách nội dung (nhạy cảm hoặc chứa IP có bản quyền như tên/hình ảnh nhân vật nổi tiếng):

Lý do bị từ chối: ${violationReason}

Prompt gốc:
${prompt}

Hãy viết lại ĐÚNG prompt này để mô tả lại y hệt ý tưởng, bối cảnh, hành động, bố cục — nhưng thay thế hoặc loại bỏ mọi tên riêng, thương hiệu, nhân vật có bản quyền hoặc từ ngữ nhạy cảm có thể khiến công cụ kiểm duyệt nội dung từ chối. Chỉ trả lời DUY NHẤT prompt mới, không thêm giải thích, không dùng dấu ngoặc kép hay markdown.`;

  const messages: OpenRouterMessage[] = [{ role: "user", content: message }];
  const { text } = await callOpenRouterWithProviderRetry(
    messages,
    jobId,
    "reviseGenerationPromptQwen",
  );
  const revisedPrompt = cleanRevisedPromptQwen(text);
  console.log(
    `[qwenAI] reviseGenerationPromptQwen(${jobId}): revisedPrompt=`,
    revisedPrompt,
  );
  if (!revisedPrompt) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) không trả về prompt viết lại nào`,
    );
  }
  return revisedPrompt;
}

/**
 * Dùng cho "Test prompt tham chiếu video" (TEST_VIDEO_REFERENCE_BUTTON_LABEL,
 * xem config.promptVideoReferenceTest/ScriptReferenceVideoJob.verifyPromptTest
 * trong queue.ts): sau khi askQwenAboutReferenceVideo đã tạo ra 1 file JSON TỪ
 * video gốc (dùng prompt.txt), gọi hàm này để upload LẠI CHÍNH video gốc đó
 * kèm nội dung file JSON vừa tạo, nhờ Qwen đối chiếu xem JSON có mô tả ĐÚNG
 * video thật hay không — trả về 1 đoạn văn bản báo cáo cho người dùng đọc.
 *
 * KHÁC askQwenAboutReferenceVideo: đây KHÔNG dùng chiến lược nhiều lượt/JSON
 * parts (mục tiêu chỉ là 1 nhận xét ngắn, không phải tái tạo lại toàn bộ nội
 * dung) — gọi OpenRouter ĐÚNG 1 LẦN duy nhất.
 */
export async function verifyReferenceVideoJson(
  videoPath: string,
  jsonPath: string,
  jobId: string,
): Promise<string> {
  const jsonContent = await fs.promises.readFile(jsonPath, "utf-8");

  await fs.promises.mkdir(config.debugDir, { recursive: true });

  console.log(
    `[qwenAI] verifyReferenceVideoJson(${jobId}): publish video "${videoPath}" ra URL công khai tạm thời...`,
  );

  const { url: videoUrl, cleanup } = await publishFileTemporarily(
    videoPath,
    `${jobId}-verify${path.extname(videoPath) || ".mp4"}`,
  );

  const audioPath = path.join(config.debugDir, `${jobId}-verify-audio.mp3`);

  try {
    console.log(
      `[qwenAI] verifyReferenceVideoJson(${jobId}): tách audio bằng ffmpeg...`,
    );
    await extractAudioForQwen(videoPath, audioPath);
    const audioBase64 = await fs.promises.readFile(audioPath, "base64");

    const verifyPrompt = `Bạn nhận được 1 video gốc (kèm audio) và 1 file JSON được tạo ra TỪ chính video này (JSON gồm các asset CHARACTER/LOCATION/PROP/OBJECT và các đoạn VIDEO — mục tiêu của JSON là mô tả đủ chi tiết để gen ảnh + gen video rồi ghép lại tái tạo giống video gốc).

Nhiệm vụ: xem/nghe kỹ video gốc, đối chiếu TỪNG PHẦN của JSON với đúng nội dung video thật, rồi báo cáo:
1. JSON có khớp CHÍNH XÁC với video gốc không (nhân vật, bối cảnh, đạo cụ/vật thể, lời thoại, số lượng đoạn VIDEO, thứ tự, duration mỗi đoạn)?
2. Liệt kê CỤ THỂ từng điểm sai lệch nếu có — nêu rõ id/field nào sai, mô tả đúng phải là gì theo video thật. Nếu JSON khớp hoàn toàn, nói rõ "Khớp hoàn toàn, không phát hiện sai lệch."
3. Không sửa lại JSON, không xuất file — CHỈ trả lời bằng 1 đoạn văn bản báo cáo ngắn gọn, rõ ràng, có thể dùng gạch đầu dòng cho từng điểm sai lệch.

Nội dung file JSON cần đối chiếu:
\`\`\`json
${jsonContent}
\`\`\``;

    const messages: OpenRouterMessage[] = [
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: videoUrl } },
          {
            type: "input_audio",
            input_audio: { data: audioBase64, format: "mp3" },
          },
          { type: "text", text: verifyPrompt },
        ],
      },
    ];

    const { text, finishReason } = await callOpenRouterWithProviderRetry(
      messages,
      jobId,
      "verifyReferenceVideoJson",
    );

    if (finishReason === "length") {
      console.warn(
        `[qwenAI] verifyReferenceVideoJson(${jobId}): finish_reason=length — báo cáo có thể bị cắt giữa chừng.`,
      );
    }

    if (!text) {
      throw new QwenAIError(
        `Qwen không trả về nội dung đối chiếu nào (job ${jobId}).`,
      );
    }

    return text;
  } finally {
    await cleanup().catch((err) => {
      console.warn(
        `[qwenAI] verifyReferenceVideoJson(${jobId}): cleanup video public URL lỗi:`,
        err,
      );
    });
    await fs.promises.unlink(audioPath).catch(() => {});
  }
}
