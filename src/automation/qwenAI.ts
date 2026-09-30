import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config";
import { publishFileTemporarily } from "./qwenFileServer";

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

function mergeJsonPart(
  target: Record<string, unknown>,
  part: unknown,
  jobId: string,
  turn: number,
): void {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    console.warn(
      `[qwenAI] askQwenAboutReferenceVideo(${jobId}): lượt ${turn} trả JSON không phải object — bỏ qua merge: ${JSON.stringify(part).slice(0, 200)}`,
    );
    return;
  }

  for (const [key, value] of Object.entries(
    part as Record<string, unknown>,
  )) {
    const existing = target[key];

    if (existing === undefined) {
      target[key] = value;
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
    } else {
      console.warn(
        `[qwenAI] askQwenAboutReferenceVideo(${jobId}): lượt ${turn} GHI ĐÈ key "${key}" đã có từ lượt trước (không phải mảng để nối) — có thể model đã lặp lại phần đã gửi.`,
      );
      target[key] = value;
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
    // nghẽn/timeout thoáng qua) — KHÔNG throw cứng ở đây vì sẽ bỏ qua luôn
    // callOpenRouterWithProviderRetry (throw thoát khỏi vòng lặp retry).
    // Trả về kết quả có cấu trúc để lớp retry xử lý giống provider_unavailable.
    if (/failed to download multimodal content/i.test(bodyText)) {
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
    if (choice?.error) {
      return {
        text: "",
        finishReason: choice.finish_reason ?? "error",
        errorType,
      };
    }

    throw new QwenAIError(
      `OpenRouter trả response không có choices[0].message.content dạng text (job ${jobId}): ${JSON.stringify(data).slice(0, 2000)}`,
    );
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
      result.finishReason === "error" &&
      (result.errorType === "provider_unavailable" ||
        result.errorType === "download_failed" ||
        result.errorType === "invalid_response_body");

    if (
      !isTransientProviderError ||
      attempt === PROVIDER_ERROR_MAX_RETRIES
    ) {
      return result;
    }

    console.warn(
      `[qwenAI] askQwenAboutReferenceVideo(${jobId}): ${turnLabel} — lỗi hạ tầng tạm thời (${result.errorType}), thử lại NGUYÊN request (lần ${attempt + 1}/${PROVIDER_ERROR_MAX_RETRIES})...`,
    );
  }

  return lastResult as CallOpenRouterResult;
}

/**
 * SỬA (theo câu hỏi người dùng: "1 lượt bị mất không parse được JSON thì lượt
 * sau có thực hiện lại data của lượt đó không?" — câu trả lời THẬT là KHÔNG,
 * đây là lỗ hổng thật): mỗi lượt là 1 request MỚI HOÀN TOÀN, không mang lịch
 * sử hội thoại — nếu chỉ báo "đã có key X" (không nói rõ đã có BAO NHIÊU
 * phần tử/tới MỐC nào), model không biết chính xác đã phủ tới đâu khi tiếp
 * tục 1 mảng dài (segments...), dễ BỎ SÓT (tưởng đã đủ, nhảy sang phần sau)
 * hoặc TRÙNG LẶP (gửi lại từ đầu, bị mergeJsonPart nối chồng lên vì chỉ biết
 * concat, không dedupe). Báo CHI TIẾT: số phần tử hiện có + id/end_s của
 * phần tử CUỐI CÙNG (nếu mảng có các field này) — cho model điểm neo chính
 * xác để tiếp tục đúng chỗ, không đoán mù.
 */
function describeCompletionState(
  mergedResult: Record<string, unknown>,
): string {
  const keys = Object.keys(mergedResult);
  if (keys.length === 0) return "(chưa có key nào)";
  return keys
    .map((key) => {
      const value = mergedResult[key];
      if (Array.isArray(value)) {
        const count = value.length;
        const lastItem = value[count - 1] as
          | Record<string, unknown>
          | undefined;
        const lastId =
          lastItem && typeof lastItem === "object" && "id" in lastItem
            ? String(lastItem.id)
            : null;
        const lastEndS =
          lastItem && typeof lastItem === "object" && "end_s" in lastItem
            ? lastItem.end_s
            : null;
        const detailParts = [
          `${count} phần tử`,
          lastId ? `phần tử CUỐI id="${lastId}"` : null,
          lastEndS !== null && lastEndS !== undefined
            ? `end_s CUỐI=${lastEndS}`
            : null,
        ].filter(Boolean);
        return `- "${key}": ĐÃ CÓ (${detailParts.join(", ")}). Nếu tiếp tục mảng này, PHẢI bắt đầu NGAY SAU phần tử cuối trên — KHÔNG lặp lại phần tử đã có, KHÔNG bỏ sót đoạn nào ở giữa.`;
      }
      return `- "${key}": ĐÃ CÓ (đối tượng đơn — coi như xong, không cần gửi lại trừ khi phát hiện sai).`;
    })
    .join("\n");
}

function buildTurnPrompt(
  basePrompt: string,
  mergedResult: Record<string, unknown>,
  turn: number,
  /** true nếu lượt NGAY TRƯỚC bị cắt giữa chừng (JSON không hợp lệ/không đóng) — nhắc model chủ động chia nhỏ hơn NỮA ở lượt này, xem MAX_OUTPUT_TOKENS. */
  lastTurnTruncated = false,
): string {
  const completionState = describeCompletionState(mergedResult);

  const truncationWarning = lastTurnTruncated
    ? `\n\n## CẢNH BÁO — LƯỢT TRƯỚC BỊ CẮT GIỮA CHỪNG\nLượt ngay trước đã trả về JSON KHÔNG HỢP LỆ (bị cắt giữa chừng do quá dài, không đóng được khối code). Lượt NÀY hãy chia nhỏ HƠN NỮA — ví dụ nếu đang gửi "segments", chỉ gửi 1 PHẦN TỬ segment DUY NHẤT (không phải nhiều phần tử cùng lúc) để chắc chắn JSON đóng gọn trong giới hạn 1 lượt.`
    : "";

  return `${basePrompt}${truncationWarning}

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
- chỉ coi audio là không khả dụng khi input_audio thực sự không thể truy cập hoặc không chứa tín hiệu hữu ích.

## QUY TẮC TRẢ LỜI NHIỀU LƯỢT — BẮT BUỘC

Kết quả JSON cuối cùng là MỘT object duy nhất gồm các key:
- schema_version
- film_info
- assets
- segments
- emotional_beats
- adaptation_blueprint

KHÔNG cố xuất toàn bộ object này trong một lượt.

Mỗi lượt:
- chỉ trả về ĐÚNG MỘT khối code \`\`\`json ... \`\`\`;
- bên trong phải là MỘT JSON object HỢP LỆ, tự đóng, parse được;
- chỉ chứa một vài key/phần tử MỚI chưa gửi ở lượt trước;
- không bọc thêm object cha khác;
- không lặp lại dữ liệu đã gửi nếu không cần thiết;
- nếu key là mảng dài như segments, có thể tiếp tục dùng lại cùng key "segments" ở lượt sau nhưng chỉ chứa các PHẦN TỬ MỚI;
- nếu một phần vẫn quá dài, phải chia nhỏ hơn nữa để mỗi lượt luôn là JSON hoàn chỉnh.

Trạng thái các top-level key bot đã gom được tới trước lượt ${turn} (dựa CHÍNH XÁC vào đây để biết tiếp tục từ đâu, KHÔNG tự đoán):
${completionState}

Đây là lượt ${turn}/${MAX_PART_TURNS}.

Ở CUỐI tin nhắn của LƯỢT CUỐI CÙNG, sau khối JSON, khi chắc chắn đã gửi ĐỦ toàn bộ:
schema_version, film_info, assets, segments, emotional_beats, adaptation_blueprint

hãy viết đúng nguyên văn:
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

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): publish video "${compressedVideoPath}" ra URL công khai tạm thời...`,
  );

  const { url: videoUrl, cleanup } =
    await publishFileTemporarily(
      compressedVideoPath,
      `${jobId}${path.extname(compressedVideoPath) || ".mp4"}`,
    );

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): video công khai tại ${videoUrl}`,
  );

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

  const mergedResult: Record<string, unknown> = {};
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
        mergedResult,
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
        finishReason === "error" &&
        (errorType === "provider_unavailable" ||
          errorType === "download_failed" ||
          errorType === "invalid_response_body")
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
          mergeJsonPart(
            mergedResult,
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
      `Qwen (job ${jobId}) chưa gửi "${DONE_MARKER}" sau ${MAX_PART_TURNS} lượt — kết quả có thể chưa đầy đủ. Các key đã gom được: ${Object.keys(mergedResult).join(", ") || "(không có)"}.`,
    );
  }

  const requiredTopLevelKeys = [
    "schema_version",
    "film_info",
    "assets",
    "segments",
    "emotional_beats",
    "adaptation_blueprint",
  ] as const;

  const missingKeys = requiredTopLevelKeys.filter(
    (key) => !(key in mergedResult),
  );

  if (missingKeys.length > 0) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) đã báo "${DONE_MARKER}" nhưng JSON merge vẫn thiếu top-level key: ${missingKeys.join(", ")}.`,
    );
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
    JSON.stringify(mergedResult, null, 2),
    "utf-8",
  );

  console.log(
    `[qwenAI] askQwenAboutReferenceVideo(${jobId}): đã lưu "${filePath}" (key: ${Object.keys(mergedResult).join(", ")}).`,
  );

  return {
    downloadedFiles: [filePath],
  };
}

// Text CHÍNH XÁC báo hiệu model đã gửi HẾT các item của mảng JSON — giữ
// ĐÚNG cùng chuỗi INLINE_CONTENT_DONE_MARKER trong chatAI.ts (2 hàm độc lập
// hoàn toàn — dùng chung text để dễ đối chiếu log giữa 2 luồng ChatGPT/Qwen
// khi debug).
const ARRAY_PARTS_DONE_MARKER = "Đã hoàn thành";

/**
 * Bản CLONE của askChatAI/askChatAIWithInlineContent (chatAI.ts) — theo yêu
 * cầu người dùng, dùng cho CẢ 2 luồng "chatAI" (prompt tuỳ ý + file đính kèm
 * tuỳ chọn) VÀ "Tạo kịch bản mới" (GenerateScriptJob — xem docstring trong
 * queue.ts, cùng gọi askChatAI ở nhánh else của processChatAIQueue) — 2 luồng
 * này vốn đã dùng CHUNG 1 hàm askChatAI bên ChatGPT, nên cũng dùng chung 1
 * hàm askQwen ở đây.
 *
 * KHÁC askQwenAboutReferenceVideo (schema kết quả là 1 OBJECT, merge theo
 * key): output ở đây LUÔN là 1 JSON ARRAY phẳng (đúng schema JSON B — xem
 * prompt_generate_script.txt dòng "Root là ARRAY phẳng", và hướng dẫn
 * INLINE_RESULT_INSTRUCTION trong askChatAIWithInlineContent) — mỗi lượt gửi
 * 1 PHẦN các item TIẾP THEO của mảng, bot nối (concat) các phần lại thành 1
 * mảng hoàn chỉnh, đúng nguyên bản chiến lược đã CHỨNG MINH hoạt động ổn
 * định của askChatAIWithInlineContent.
 *
 * KHÔNG upload file đính kèm nào — nếu có promptAttachmentPath, đọc THẲNG
 * nội dung text rồi dán vào đầu prompt (giống cách askChatAIWithInlineContent
 * làm khi dùng làm fallback), vì OpenRouter/Qwen ở đây chỉ nhận text (+
 * video_url/input_audio khi cần, không dùng ở hàm này).
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

  const instruction = `QUAN TRỌNG: Trả kết quả JSON TRỰC TIẾP trong tin nhắn trả lời, bọc trong khối \`\`\`json ... \`\`\` — không có công cụ tạo file nào ở đây.

Kết quả PHẢI là 1 JSON ARRAY. Nếu toàn bộ kết quả quá dài để gửi trong 1 lượt, hãy CHIA THÀNH NHIỀU LƯỢT trả lời — mỗi lượt gửi 1 khối code chứa 1 JSON ARRAY là 1 PHẦN các item TIẾP THEO (không lặp lại item đã gửi, không bọc thêm object nào khác ngoài mảng). Ở CUỐI tin nhắn của lượt CUỐI CÙNG (khi đã gửi hết toàn bộ, không còn item nào nữa), viết rõ nguyên văn "${ARRAY_PARTS_DONE_MARKER}". TUYỆT ĐỐI KHÔNG viết "${ARRAY_PARTS_DONE_MARKER}" ở các lượt CHƯA gửi hết.`;

  const initialPrompt = fileContent
    ? `${fileContent}\n\n${prompt}\n\n${instruction}`
    : `${prompt}\n\n${instruction}`;

  const messages: OpenRouterMessage[] = [
    { role: "user", content: initialPrompt },
  ];

  const allItems: unknown[] = [];
  let done = false;

  for (let turn = 1; turn <= MAX_PART_TURNS; turn++) {
    const turnLabel = `lượt ${turn}/${MAX_PART_TURNS}`;
    console.log(
      `[qwenAI] askQwen(${jobId}): ${turnLabel} — gọi OpenRouter (model=${config.qwenOmniModel})...`,
    );
    const { text } = await callOpenRouterWithProviderRetry(
      messages,
      jobId,
      turnLabel,
    );
    console.log(
      `[qwenAI] askQwen(${jobId}): ${turnLabel} xong, độ dài text=${text.length}.`,
    );

    let chunkItemCount = 0;
    const jsonPartText = extractJsonFromText(text);
    if (jsonPartText) {
      const parsed = JSON.parse(jsonPartText);
      if (Array.isArray(parsed)) {
        chunkItemCount = parsed.length;
        allItems.push(...parsed);
      } else {
        console.warn(
          `[qwenAI] askQwen(${jobId}): lượt ${turn} — JSON trả về KHÔNG PHẢI array, bỏ qua (theo đúng yêu cầu, mỗi phần phải là array).`,
        );
      }
    }

    done = text.includes(ARRAY_PARTS_DONE_MARKER);
    console.log(
      `[qwenAI] askQwen(${jobId}): lượt ${turn} — nhận ${chunkItemCount} item mới (tổng ${allItems.length}), marker "${ARRAY_PARTS_DONE_MARKER}": ${done ? "CÓ" : "chưa"}.`,
    );

    if (done) break;

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `Tiếp tục gửi phần tiếp theo của mảng JSON (khối code, chỉ chứa các item CHƯA gửi) — chỉ viết "${ARRAY_PARTS_DONE_MARKER}" khi đã gửi hết toàn bộ.`,
    });
  }

  if (!done) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) chưa gửi "${ARRAY_PARTS_DONE_MARKER}" sau ${MAX_PART_TURNS} lượt — kết quả có thể chưa đầy đủ (đã nhận ${allItems.length} item).`,
    );
  }
  if (allItems.length === 0) {
    throw new QwenAIError(
      `Qwen (job ${jobId}) báo đã hoàn thành nhưng không có item JSON nào.`,
    );
  }

  await fs.promises.mkdir(config.chatAIResultsDir, { recursive: true });
  const baseName = promptFileName
    ? path.basename(promptFileName, path.extname(promptFileName))
    : `qwen-${jobId}`;
  const filePath = path.join(config.chatAIResultsDir, `${baseName}.json`);
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(allItems, null, 2),
    "utf-8",
  );
  console.log(
    `[qwenAI] askQwen(${jobId}): đã lưu "${filePath}" (${allItems.length} item).`,
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
