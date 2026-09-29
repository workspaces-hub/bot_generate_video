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

// SỬA (theo yêu cầu người dùng): đọc từ comfyuiWorkflows/ ở GỐC PROJECT
// (path.resolve CWD-relative, cùng quy ước với các path "./storage/..." khác
// trong config.ts) THAY VÌ src/automation/comfyuiWorkflows/ — sửa file JSON
// trực tiếp trên VPS không cần build lại (__dirname-relative trước đây trỏ
// vào dist/src/automation/, bắt buộc phải copy qua bước build mới thấy thay
// đổi).
const WORKFLOW_TEMPLATE_PATH = path.resolve(
  "./comfyuiWorkflows/ltx2-frame-to-video.json",
);

const FIRST_FRAME_NODE_ID = "300";
const LAST_FRAME_NODE_ID = "301";
const PROMPT_NODE_ID = "298:297";
const DURATION_NODE_ID = "298:294";
const WIDTH_NODE_ID = "298:291";
const HEIGHT_NODE_ID = "298:292";
const FRAME_RATE_NODE_ID = "298:296";
const NOISE_SEED_NODE_ID = "298:274";

/**
 * Workflow THỨ 2: MiniMax H3 "Reference to Video" (node MiniMaxH3ReferenceToVideo)
 * — KHÁC HẲN workflow LTX-2 ở trên (không có firstFrame/lastFrame, thay vào
 * đó nhận TỐI ĐA 9 ẢNH THAM CHIẾU, cùng khái niệm "Reference to Video" đã
 * dùng cho pollo.ai, xem MAX_REFERENCE_IMAGES trong pollo.ts). File JSON gốc
 * người dùng cung cấp lưu ở comfyuiWorkflows/minimax-h3-reference-to-video.json.
 *
 * Các node id cố định trong template (đã xác nhận qua đọc JSON gốc):
 * - "137","139","147"-"153" (LoadImage, ĐÚNG THỨ TỰ)  = 9 ảnh tham chiếu
 *   (ref_image_0..ref_image_8, xem MINIMAX_H3_REF_IMAGE_NODE_IDS)
 * - "138" (PrimitiveStringMultiline)  = prompt
 * - "132" (PrimitiveFloat)            = duration (giây — node "131" tự quy
 *   đổi sang số frame theo fps 24 cố định trong chính công thức, xem
 *   comment ở node đó trong file JSON)
 * - "129" (RandomNoise.noise_seed)    = seed — random mỗi lần gọi
 * - "115" (ResolutionSelector.aspect_ratio) = tỉ lệ khung hình (CHƯA xác
 *   nhận đầy đủ enum ngoài "16:9 (Widescreen)" đã thấy trong template gốc —
 *   xem MINIMAX_H3_ASPECT_RATIO_LABELS, cần người dùng xác nhận nhãn đúng
 *   cho "9:16" trên ComfyUI thật của họ)
 * - "92" (SaveVideo)                  = node xuất video cuối cùng
 */
const MINIMAX_H3_WORKFLOW_TEMPLATE_PATH = path.resolve(
  "./comfyuiWorkflows/minimax-h3-reference-to-video.json",
);

/** ĐÚNG THỨ TỰ ref_image_0..ref_image_8 trong node MiniMaxH3ReferenceToVideo (node "136") của template. */
const MINIMAX_H3_REF_IMAGE_NODE_IDS = [
  "137",
  "139",
  "147",
  "148",
  "149",
  "150",
  "151",
  "152",
  "153",
];
const MINIMAX_H3_REF_TO_VIDEO_NODE_ID = "136";
const MINIMAX_H3_PROMPT_NODE_ID = "138";
const MINIMAX_H3_DURATION_NODE_ID = "132";
const MINIMAX_H3_NOISE_SEED_NODE_ID = "129";
/** Node "115" ResolutionSelector — giữ CẢ aspect_ratio lẫn megapixels (xem generateVideoComfyMiniMaxH3). */
const MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID = "115";
/** Node "Int (Full)" — số sampling steps khi Lightning LoRA tắt (node "146" = false, xem generateVideoComfyMiniMaxH3). */
const MINIMAX_H3_STEPS_NODE_ID = "143";
/** Node "CreateVideo" — giữ fps xuất video cuối cùng (xem generateVideoComfyMiniMaxH3). */
const MINIMAX_H3_CREATE_VIDEO_NODE_ID = "130";
/**
 * Node "ComfyMathExpression" tính "length" (số frame) từ duration — hardcode
 * "24" (fps) NGAY TRONG CHÍNH chuỗi expression (không phải input riêng), xem
 * buildMiniMaxH3LengthExpression — phải re-build lại cả chuỗi expression mỗi
 * khi fps khác 24, không chỉ set 1 field số như các input khác.
 */
const MINIMAX_H3_DURATION_FORMULA_NODE_ID = "131";

/** Số ảnh tham chiếu tối đa mà workflow MiniMax H3 hỗ trợ (đúng số slot ref_image_0..8 có sẵn trong template). */
export const MAX_MINIMAX_H3_REFERENCE_IMAGES = MINIMAX_H3_REF_IMAGE_NODE_IDS.length;

/**
 * Nhãn "aspect_ratio" thật trên node ResolutionSelector — đã xác nhận qua
 * ảnh chụp dropdown thật trên ComfyUI của người dùng: "1:1 (Square)", "2:3
 * (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)", "4:3
 * (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)" — chỉ dùng
 * đúng 2 nhãn cần cho aspectRatio "9:16"/"16:9" của bot.
 */
const MINIMAX_H3_ASPECT_RATIO_LABELS: Record<ComfyAspectRatio, string> = {
  "16:9": "16:9 (Widescreen)",
  "9:16": "9:16 (Portrait Widescreen)",
};

export type ComfyAspectRatio = "9:16" | "16:9";

const DEFAULT_ASPECT_RATIO: ComfyAspectRatio = "16:9";
const DEFAULT_FRAME_RATE = 24;

/**
 * Workflow THỨ 3: MiniMax H3 "Text to Video" (node MiniMaxH3ImageToVideo —
 * tên class_type dễ gây nhầm, nhưng workflow KHÔNG hề wire LoadImage/ảnh đầu
 * vào nào cả) — dùng khi entry KHÔNG có ảnh tham chiếu nào (referenceImagePaths
 * rỗng), thay vì generateVideoComfyMiniMaxH3 (Reference to Video, luôn cần
 * ít nhất 1 ảnh). File JSON gốc lưu ở
 * comfyuiWorkflows/minimax-h3-text-to-video.json.
 *
 * SỬA (theo yêu cầu người dùng, cập nhật lại đúng workflow gốc mới nhất —
 * BẢN ĐẦU dùng width/height/length TĨNH đã LỖI THỜI, workflow thật của người
 * dùng dùng cấu trúc GIỐNG HỆT workflow Reference to Video):
 * - width/height: qua CHUNG node "115" ResolutionSelector với workflow
 *   Reference to Video (CÙNG node id, cùng ý nghĩa aspect_ratio/megapixels) —
 *   dùng lại nguyên MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID/
 *   MINIMAX_H3_ASPECT_RATIO_LABELS, KHÔNG cần logic width/height riêng nữa.
 * - length (số frame): qua node ComfyMathExpression THẬT ("140:132", cùng
 *   công thức "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) %
 *   17" như workflow Reference to Video) — chỉ cần set duration (giây) vào
 *   node PrimitiveFloat "140:133", KHÔNG cần tự tính lại công thức bằng JS
 *   nữa (đã bỏ hẳn computeMiniMaxH3FrameLength/properMod).
 * - steps: qua switch Full/Lightning LoRA THẬT ("140:135" model, "140:136"
 *   steps, "140:139" Enable Lightning LoRA boolean) — GIỐNG HỆT cấu trúc
 *   workflow Reference to Video, chỉ khác giá trị mặc định (Full=20,
 *   Lightning=8, thay vì 8/4) — vẫn tiêm qua CHUNG config.comfyUIMiniMaxH3Steps
 *   vào nhánh "Full" (node "140:137"), nhánh Lightning LoRA đang tắt
 *   (switch "140:139" = false) nên không đổi qua config này.
 * - prompt: input trực tiếp trên node "140:131" (MiniMaxH3ImageToVideo).
 * - seed: node "140:129" (RandomNoise.noise_seed).
 */
const MINIMAX_H3_T2V_WORKFLOW_TEMPLATE_PATH = path.resolve(
  "./comfyuiWorkflows/minimax-h3-text-to-video.json",
);
const MINIMAX_H3_T2V_NODE_ID = "140:131";
const MINIMAX_H3_T2V_DURATION_NODE_ID = "140:133";
const MINIMAX_H3_T2V_NOISE_SEED_NODE_ID = "140:129";
/** Node "Int" nhánh "Full" (khi Lightning LoRA tắt) — xem "140:139" Enable Lightning LoRA. */
const MINIMAX_H3_T2V_STEPS_NODE_ID = "140:137";
const MINIMAX_H3_T2V_CREATE_VIDEO_NODE_ID = "140:130";
const MINIMAX_H3_T2V_DURATION_FORMULA_NODE_ID = "140:132";

/**
 * Build lại chuỗi "expression" cho node ComfyMathExpression tính "length"
 * (số frame) từ duration — CÙNG công thức đã xác nhận trong cả 2 workflow
 * MiniMax H3 ("max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) %
 * 17"), chỉ thay "24" (fps) bằng giá trị fps thật truyền vào. "5" và "17"
 * KHÔNG đổi theo fps — đây là ràng buộc nội bộ của model (số frame tối
 * thiểu/hệ số nén thời gian), không liên quan tới fps.
 */
function buildMiniMaxH3LengthExpression(fps: number): string {
  return `max(5, round(a * ${fps})) + (5 - (max(5, round(a * ${fps})) % 17)) % 17`;
}

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

// SỬA: cache theo TỪNG path (Map) — giờ có 2 workflow khác nhau
// (LTX-2/MiniMax H3, xem WORKFLOW_TEMPLATE_PATH/MINIMAX_H3_WORKFLOW_TEMPLATE_PATH)
// cùng dùng chung hàm này, không còn 1 biến cache duy nhất như trước.
const cachedTemplates = new Map<string, ComfyWorkflow>();

function loadWorkflowTemplate(templatePath: string): ComfyWorkflow {
  let cached = cachedTemplates.get(templatePath);
  if (!cached) {
    const raw = fs.readFileSync(templatePath, "utf-8");
    cached = JSON.parse(raw);
    cachedTemplates.set(templatePath, cached!);
  }
  // Deep clone — mỗi lần gọi generate cần 1 bản độc lập để chỉnh
  // ảnh/prompt/duration/seed mà không ảnh hưởng template gốc.
  return JSON.parse(JSON.stringify(cached));
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
  const workflow = loadWorkflowTemplate(WORKFLOW_TEMPLATE_PATH);

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

/**
 * Gen video qua ComfyUI dùng workflow MiniMax H3 "Reference to Video" —
 * KHÁC HẲN generateVideoComfyUI (LTX-2, ghép start/end frame): nhận TỐI ĐA
 * MAX_MINIMAX_H3_REFERENCE_IMAGES (9) ẢNH THAM CHIẾU (referenceImagePaths,
 * cùng khái niệm "Reference to Video" đã dùng cho pollo.ai), theo prompt mô
 * tả diễn biến, độ dài duration giây, tỉ lệ khung hình aspectRatio
 * ("9:16"/"16:9", mặc định "16:9"). Số ảnh thực tế truyền vào có thể ÍT HƠN
 * 9 — các node LoadImage/khoá "ref_images.ref_image_N" dư ra trong node
 * MiniMaxH3ReferenceToVideo (node "136") bị XOÁ HẲN khỏi workflow trước khi
 * submit (không upload/gán ảnh giả cho slot không dùng tới).
 *
 * Nhãn "aspect_ratio" ("9:16 (Portrait Widescreen)"/"16:9 (Widescreen)", xem
 * MINIMAX_H3_ASPECT_RATIO_LABELS) đã xác nhận qua ảnh chụp dropdown thật.
 *
 * CHƯA test thật với server ComfyUI thật (không có server nào reachable từ
 * môi trường phát triển) — cần người dùng tự chạy thử để xác nhận: node
 * MiniMaxH3ReferenceToVideo có chấp nhận thiếu hẳn 1 số khoá
 * "ref_images.ref_image_N" (thay vì luôn đủ 9) hay không — nếu ComfyUI từ
 * chối vì thiếu input bắt buộc, cần đổi cách xử lý (vd giữ đủ 9 khoá nhưng
 * lặp lại ảnh cuối cùng cho các slot dư, thay vì
 * xoá khoá).
 */
export async function generateVideoComfyMiniMaxH3(
  referenceImagePaths: string[],
  prompt: string,
  duration: number,
  jobId: string,
  aspectRatio: ComfyAspectRatio = DEFAULT_ASPECT_RATIO,
  steps: number = config.comfyUIMiniMaxH3Steps,
  megapixels: number = config.comfyUIMiniMaxH3Megapixels,
  fps: number = DEFAULT_FRAME_RATE,
): Promise<ComfyUIGenerateVideoResult> {
  if (referenceImagePaths.length === 0) {
    throw new GenerationError(
      "generateVideoComfyMiniMaxH3 cần ít nhất 1 ảnh tham chiếu (referenceImagePaths rỗng).",
    );
  }
  if (referenceImagePaths.length > MAX_MINIMAX_H3_REFERENCE_IMAGES) {
    throw new GenerationError(
      `Quá nhiều ảnh tham chiếu (${referenceImagePaths.length}/${MAX_MINIMAX_H3_REFERENCE_IMAGES}) — workflow MiniMax H3 chỉ hỗ trợ tối đa ${MAX_MINIMAX_H3_REFERENCE_IMAGES} ảnh tham chiếu.`,
    );
  }

  const workflow = loadWorkflowTemplate(MINIMAX_H3_WORKFLOW_TEMPLATE_PATH);

  const uploadedNames = await Promise.all(
    referenceImagePaths.map((p) => uploadImage(p)),
  );

  const refToVideoInputs = workflow[MINIMAX_H3_REF_TO_VIDEO_NODE_ID].inputs;
  MINIMAX_H3_REF_IMAGE_NODE_IDS.forEach((loadImageNodeId, index) => {
    const refKey = `ref_images.ref_image_${index}`;
    if (index < uploadedNames.length) {
      workflow[loadImageNodeId].inputs.image = uploadedNames[index];
    } else {
      // Slot dư (không có ảnh tương ứng) — xoá HẲN cả node LoadImage lẫn khoá
      // ref_images.ref_image_N trỏ tới nó, không để lại tham chiếu treo/ảnh
      // giả (xem docstring hàm này).
      delete workflow[loadImageNodeId];
      delete refToVideoInputs[refKey];
    }
  });

  workflow[MINIMAX_H3_PROMPT_NODE_ID].inputs.value = prompt;
  workflow[MINIMAX_H3_DURATION_NODE_ID].inputs.value = duration;
  workflow[MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID].inputs.aspect_ratio =
    MINIMAX_H3_ASPECT_RATIO_LABELS[aspectRatio];
  // Độ phân giải đích (megapixel) — CÙNG node "115" ResolutionSelector với
  // aspect_ratio ở trên. Trước đây hardcode 0.4 trong chính file JSON
  // template (xác nhận qua lỗi thật: video 9:16 ra đúng 480x864, không đủ
  // nét cho nội dung premium) — giờ đọc qua config.comfyUIMiniMaxH3Megapixels
  // (env COMFYUI_MINIMAX_H3_MEGAPIXELS) để đổi được không cần sửa file JSON.
  workflow[MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID].inputs.megapixels = megapixels;
  // Số sampling steps — trước đây hardcode trong chính file JSON template
  // (node "143" "Int (Full)"), giờ đọc qua config.comfyUIMiniMaxH3Steps (env
  // COMFYUI_MINIMAX_H3_STEPS) để đổi được không cần sửa file JSON. Chỉ áp
  // dụng cho nhánh "Full" (node "146" Enable Lightning LoRA = false, xem
  // template) — nhánh Lightning LoRA (node "144") không đổi qua config này.
  workflow[MINIMAX_H3_STEPS_NODE_ID].inputs.value = steps;
  // fps — trước đây hardcode 24 (node "130" CreateVideo, và cả trong CHÍNH
  // chuỗi "expression" của node "131" ComfyMathExpression tính length — 2
  // chỗ, không chỉ 1). Giờ truyền được: set thẳng node "130", và REBUILD lại
  // cả chuỗi expression của node "131" qua buildMiniMaxH3LengthExpression
  // (không chỉ set 1 field số vì fps nằm ngay trong text công thức).
  workflow[MINIMAX_H3_CREATE_VIDEO_NODE_ID].inputs.fps = fps;
  workflow[MINIMAX_H3_DURATION_FORMULA_NODE_ID].inputs.expression =
    buildMiniMaxH3LengthExpression(fps);
  // Random seed mỗi lần gọi — cùng lý do đã giải thích ở generateVideoComfyUI
  // (tránh ComfyUI trả cache kết quả cũ, và cùng giới hạn range của
  // crypto.randomInt).
  workflow[MINIMAX_H3_NOISE_SEED_NODE_ID].inputs.noise_seed = crypto.randomInt(
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

/**
 * Gen video qua ComfyUI dùng workflow MiniMax H3 "Text to Video" — dùng khi
 * KHÔNG có ảnh tham chiếu nào (xem generateVideosForFileComfyUI trong
 * storyboardPipeline.ts: entry VIDEO không resolve được ref CHARACTER/
 * LOCATION nào thì gọi hàm này thay vì generateVideoComfyMiniMaxH3).
 *
 * width/height/length của node MiniMaxH3ImageToVideo ("140:131") đã được
 * WIRE SẴN tới ResolutionSelector ("115")/ComfyMathExpression ("140:132")
 * ngay trong template — hàm này CHỈ set giá trị đầu vào của 2 node đó
 * (aspect_ratio/megapixels, duration) chứ không tự set width/height/length
 * trực tiếp (khác bản đầu, đã lỗi thời — xem docstring khối const phía trên).
 *
 * CHƯA test thật với server ComfyUI thật — cần người dùng tự chạy thử để
 * xác nhận workflow chạy đúng khi không có ảnh tham chiếu nào.
 */
export async function generateVideoComfyMiniMaxH3TextToVideo(
  prompt: string,
  duration: number,
  jobId: string,
  aspectRatio: ComfyAspectRatio = DEFAULT_ASPECT_RATIO,
  steps: number = config.comfyUIMiniMaxH3Steps,
  megapixels: number = config.comfyUIMiniMaxH3Megapixels,
  fps: number = DEFAULT_FRAME_RATE,
): Promise<ComfyUIGenerateVideoResult> {
  const workflow = loadWorkflowTemplate(MINIMAX_H3_T2V_WORKFLOW_TEMPLATE_PATH);

  workflow[MINIMAX_H3_T2V_NODE_ID].inputs.prompt = prompt;
  workflow[MINIMAX_H3_T2V_DURATION_NODE_ID].inputs.value = duration;
  workflow[MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID].inputs.aspect_ratio =
    MINIMAX_H3_ASPECT_RATIO_LABELS[aspectRatio];
  workflow[MINIMAX_H3_RESOLUTION_SELECTOR_NODE_ID].inputs.megapixels =
    megapixels;
  workflow[MINIMAX_H3_T2V_STEPS_NODE_ID].inputs.value = steps;
  // fps — cùng lý do đã giải thích ở generateVideoComfyUI: phải set CẢ node
  // CreateVideo lẫn rebuild chuỗi expression của node ComfyMathExpression
  // (fps nằm ngay trong text công thức, không phải input riêng).
  workflow[MINIMAX_H3_T2V_CREATE_VIDEO_NODE_ID].inputs.fps = fps;
  workflow[MINIMAX_H3_T2V_DURATION_FORMULA_NODE_ID].inputs.expression =
    buildMiniMaxH3LengthExpression(fps);
  // Random seed mỗi lần gọi — cùng lý do đã giải thích ở generateVideoComfyUI.
  workflow[MINIMAX_H3_T2V_NOISE_SEED_NODE_ID].inputs.noise_seed =
    crypto.randomInt(0, 281_474_976_710_655);

  const clientId = crypto.randomUUID();
  const promptId = await submitPrompt(workflow, clientId);
  const outputFile = await pollHistoryUntilDone(
    promptId,
    config.comfyUIGenerationTimeoutMs,
  );
  const filePath = await downloadOutputFile(outputFile, jobId);

  return { filePath, promptId };
}
