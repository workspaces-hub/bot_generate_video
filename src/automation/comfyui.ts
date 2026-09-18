import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config";
import { GenerationError } from "./aiVideo";

/**
 * Provider MỚI: ComfyUI (self-host, workflow LTX-2 image-to-video ghép
 * start/end frame — file JSON gốc người dùng cung cấp lưu ở
 * comfyuiWorkflows/ltx2-frame-to-video.json). KHÁC HẲN 2 provider kia
 * (AIVideo/pollo.ai): gọi THẲNG REST API của ComfyUI, không dùng
 * Playwright/trình duyệt, không cần session đăng nhập (ComfyUI mặc định
 * không có auth).
 *
 * Các node id cố định trong template (đã xác nhận qua đọc JSON gốc, xem
 * node graph):
 * - "300" (LoadImage)                = ảnh frame ĐẦU  (firstFrame)
 * - "301" (LoadImage)                = ảnh frame CUỐI  (lastFrame)
 * - "298:297" (PrimitiveStringMultiline) = prompt
 * - "298:294" (PrimitiveInt)         = duration (giây)
 * - "298:291" (PrimitiveInt)         = width (mặc định 1280, xem resolveWidthHeight)
 * - "298:292" (PrimitiveInt)         = height (mặc định 720, xem resolveWidthHeight)
 * - "298:296" (PrimitiveInt)         = frame rate (fps)
 * - "298:274" (RandomNoise.noise_seed)   = seed — random mỗi lần gọi
 * - "299" (SaveVideo)                = node xuất video cuối cùng
 */

const WORKFLOW_TEMPLATE_PATH = path.resolve(
  __dirname,
  "comfyuiWorkflows/ltx2-frame-to-video.json",
);

const FIRST_FRAME_NODE_ID = "300";
const LAST_FRAME_NODE_ID = "301";
const PROMPT_NODE_ID = "298:297";
const DURATION_NODE_ID = "298:294";
const WIDTH_NODE_ID = "298:291";
const HEIGHT_NODE_ID = "298:292";
const FRAME_RATE_NODE_ID = "298:296";
const NOISE_SEED_NODE_ID = "298:274";

export type ComfyAspectRatio = "9:16" | "16:9";

const DEFAULT_ASPECT_RATIO: ComfyAspectRatio = "16:9";
const DEFAULT_FRAME_RATE = 24;

/**
 * Quy đổi aspectRatio ("9:16"/"16:9", xem format_output.txt) sang width/height
 * cụ thể cho node PrimitiveInt của workflow. Dùng ĐÚNG cặp số 1280x720 đã có
 * sẵn trong template gốc (không bịa số mới) — "16:9" giữ nguyên
 * width=1280/height=720, "9:16" chỉ hoán đổi thành width=720/height=1280 (giữ
 * nguyên tổng số pixel).
 */
function resolveWidthHeight(aspectRatio: ComfyAspectRatio): {
  width: number;
  height: number;
} {
  return aspectRatio === "9:16"
    ? { width: 720, height: 1280 }
    : { width: 1280, height: 720 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ComfyWorkflow = Record<string, any>;

let cachedTemplate: ComfyWorkflow | null = null;

function loadWorkflowTemplate(): ComfyWorkflow {
  if (!cachedTemplate) {
    const raw = fs.readFileSync(WORKFLOW_TEMPLATE_PATH, "utf-8");
    cachedTemplate = JSON.parse(raw);
  }
  // Deep clone — mỗi lần gọi generate cần 1 bản độc lập để chỉnh
  // firstFrame/lastFrame/prompt/duration/seed mà không ảnh hưởng template gốc.
  return JSON.parse(JSON.stringify(cachedTemplate));
}

interface ComfyUploadImageResponse {
  name: string;
  subfolder: string;
  type: string;
}

/**
 * Upload 1 ảnh local lên ComfyUI (POST /upload/image, multipart) — trả về
 * tên file phía server để gán vào input "image" của node LoadImage. ComfyUI
 * quy ước: nếu subfolder khác rỗng thì giá trị "image" cần ghép dạng
 * "<subfolder>/<name>" (CHƯA xác nhận qua lỗi thật với bản ComfyUI cụ thể
 * của người dùng — mặc định /upload/image không set subfolder nên thường
 * subfolder rỗng, nhưng vẫn xử lý phòng hờ).
 */
async function uploadImage(filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append(
    "image",
    new Blob([fileBuffer]),
    path.basename(filePath),
  );
  form.append("overwrite", "true");

  const res = await fetch(`${config.comfyUIBaseUrl}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new GenerationError(
      `ComfyUI upload ảnh thất bại (${filePath}): HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as ComfyUploadImageResponse;
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

interface ComfySubmitPromptResponse {
  prompt_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node_errors?: Record<string, any>;
}

async function submitPrompt(
  workflow: ComfyWorkflow,
  clientId: string,
): Promise<string> {
  const res = await fetch(`${config.comfyUIBaseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new GenerationError(
      `ComfyUI từ chối queue prompt: HTTP ${res.status} ${bodyText}`,
    );
  }
  let data: ComfySubmitPromptResponse;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new GenerationError(
      `ComfyUI trả về response /prompt không phải JSON hợp lệ: ${bodyText}`,
    );
  }
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new GenerationError(
      `ComfyUI báo lỗi node trong workflow: ${JSON.stringify(data.node_errors)}`,
    );
  }
  if (!data.prompt_id) {
    throw new GenerationError(
      `ComfyUI không trả về prompt_id sau khi queue: ${bodyText}`,
    );
  }
  return data.prompt_id;
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

const VIDEO_FILENAME_PATTERN = /\.(mp4|webm|mov)$/i;

/**
 * Quét ĐỆ QUY toàn bộ object "outputs" trong /history (KHÔNG giới hạn ở
 * SAVE_VIDEO_NODE_ID) tìm phần tử dạng {filename, subfolder, type} có
 * filename đuôi video — bất kể nằm ở node id nào/key nào ("videos"/"gifs"/
 * "images"/khác, SaveVideo của các bản/workflow ComfyUI khác nhau dùng node
 * id và tên key khác nhau). Cách quét này khớp với 1 script Node độc lập
 * người dùng đã tự chạy THẬT thành công trên server ComfyUI của họ (xem
 * hàm findVideo trong test.ts ở gốc project) — dùng lại đúng cách tiếp cận đã
 * xác nhận hoạt động, thay vì chỉ giới hạn ở 1 node id cố định như trước.
 */
function findOutputFile(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any,
): ComfyOutputFile | null {
  if (!obj || typeof obj !== "object") return null;
  if (
    typeof obj.filename === "string" &&
    VIDEO_FILENAME_PATTERN.test(obj.filename)
  ) {
    return {
      filename: obj.filename,
      subfolder: obj.subfolder ?? "",
      type: obj.type ?? "output",
    };
  }
  for (const value of Object.values(obj)) {
    const found = findOutputFile(value);
    if (found) return found;
  }
  return null;
}

async function pollHistoryUntilDone(
  promptId: string,
  timeoutMs: number,
): Promise<ComfyOutputFile> {
  const startedAt = Date.now();
  const pollIntervalMs = 3_000;
  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(`${config.comfyUIBaseUrl}/history/${promptId}`);
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const history: Record<string, any> = await res.json();
      const entry = history[promptId];
      if (entry) {
        const statusStr = entry.status?.status_str;
        if (statusStr === "error") {
          throw new GenerationError(
            `ComfyUI generate thất bại (prompt_id=${promptId}): ${JSON.stringify(entry.status?.messages ?? entry.status)}`,
          );
        }
        const outputFile = findOutputFile(entry.outputs);
        if (outputFile) {
          return outputFile;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new GenerationError(
    `ComfyUI generate quá thời gian chờ (${timeoutMs}ms) — prompt_id=${promptId}`,
  );
}

async function downloadOutputFile(
  outputFile: ComfyOutputFile,
  jobId: string,
): Promise<string> {
  const url = new URL(`${config.comfyUIBaseUrl}/view`);
  url.searchParams.set("filename", outputFile.filename);
  url.searchParams.set("subfolder", outputFile.subfolder);
  url.searchParams.set("type", outputFile.type);

  const res = await fetch(url);
  if (!res.ok) {
    throw new GenerationError(
      `ComfyUI tải video kết quả thất bại: HTTP ${res.status} (${url})`,
    );
  }
  await fs.promises.mkdir(config.downloadDir, { recursive: true });
  const ext = path.extname(outputFile.filename) || ".mp4";
  const filePath = path.join(config.downloadDir, `${jobId}${ext}`);
  const arrayBuffer = await res.arrayBuffer();
  await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
  return filePath;
}

export interface ComfyUIGenerateVideoResult {
  filePath: string;
  promptId: string;
}

/**
 * Gen video qua ComfyUI (workflow LTX-2 frame-to-video) — ghép ảnh
 * firstFrame làm khung hình đầu, lastFrame làm khung hình cuối, theo prompt
 * mô tả diễn biến, độ dài duration giây, tỉ lệ khung hình aspectRatio
 * ("9:16"/"16:9", mặc định "16:9" nếu không truyền — xem
 * DEFAULT_ASPECT_RATIO/resolveWidthHeight) và frameRate fps (mặc định 24 nếu
 * không truyền — xem DEFAULT_FRAME_RATE). aspectRatio/frameRate khớp đúng 2
 * field mới cùng tên trong VIDEO entry của format_output.txt.
 *
 * CHƯA test thật với server ComfyUI thật (không có server nào reachable từ
 * môi trường phát triển) — cần người dùng tự chạy thử với ComfyUI thật của
 * họ để xác nhận: (1) tên field "image" sau khi upload có cần ghép subfolder
 * không, (2) key chứa file kết quả trong outputs của node SaveVideo
 * ("videos"/"gifs"/"images"/khác), (3) định dạng /history đúng như giả định.
 */
export async function generateVideoComfyUI(
  firstFramePath: string,
  lastFramePath: string,
  prompt: string,
  duration: number,
  jobId: string,
  aspectRatio: ComfyAspectRatio = DEFAULT_ASPECT_RATIO,
  frameRate: number = DEFAULT_FRAME_RATE,
): Promise<ComfyUIGenerateVideoResult> {
  const workflow = loadWorkflowTemplate();

  const [firstFrameName, lastFrameName] = await Promise.all([
    uploadImage(firstFramePath),
    uploadImage(lastFramePath),
  ]);

  workflow[FIRST_FRAME_NODE_ID].inputs.image = firstFrameName;
  workflow[LAST_FRAME_NODE_ID].inputs.image = lastFrameName;
  workflow[PROMPT_NODE_ID].inputs.value = prompt;
  workflow[DURATION_NODE_ID].inputs.value = duration;

  const { width, height } = resolveWidthHeight(aspectRatio);
  workflow[WIDTH_NODE_ID].inputs.value = width;
  workflow[HEIGHT_NODE_ID].inputs.value = height;
  workflow[FRAME_RATE_NODE_ID].inputs.value = frameRate;
  // Random seed mỗi lần gọi — tránh ComfyUI trả cache kết quả cũ (cùng seed +
  // cùng input = cùng output do cơ chế cache node của ComfyUI).
  // crypto.randomInt chỉ nhận range <= 2^48-1 (281_474_976_710_655) —
  // Number.MAX_SAFE_INTEGER (2^53-1) vượt giới hạn này nên gây
  // ERR_OUT_OF_RANGE (xác nhận qua lỗi thật).
  workflow[NOISE_SEED_NODE_ID].inputs.noise_seed = crypto.randomInt(
    0,
    281_474_976_710_655,
  );

  const clientId = crypto.randomUUID();
  const promptId = await submitPrompt(workflow, clientId);
  const outputFile = await pollHistoryUntilDone(
    promptId,
    config.comfyUIGenerationTimeoutMs,
  );
  const filePath = await downloadOutputFile(outputFile, jobId);

  return { filePath, promptId };
}
