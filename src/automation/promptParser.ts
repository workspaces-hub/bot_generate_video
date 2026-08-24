export interface ParsedPrompt {
  text: string;
  resolution?: string;
  model?: string;
  /** Thời lượng video (tuỳ chọn), đã chuẩn hoá về dạng "Ns" (vd "6s"). */
  duration?: string;
}

const RESOLUTION_LINE = /^resolution\s*:\s*(.+)$/i;
const MODEL_LINE = /^model\s*:\s*(.+)$/i;
const DURATION_LINE = /^duration\s*:\s*(.+)$/i;
export const DEFAULT_MODEL = "";

/**
 * Tách nội dung prompt user gửi thành phần text + tuỳ chọn Resolution/Model/
 * Duration, theo format:
 *   video xe thể thao đi
 *   Resolution: 1080
 *   Duration: 6
 */
export function parsePromptMessage(raw: string): ParsedPrompt {
  const promptLines: string[] = [];
  let resolution: string | undefined;
  let model: string | undefined;
  let duration: string | undefined;

  for (const line of raw.split("\n")) {
    const resolutionMatch = line.match(RESOLUTION_LINE);
    const modelMatch = line.match(MODEL_LINE);
    const durationMatch = line.match(DURATION_LINE);

    if (resolutionMatch) {
      resolution = normalizeResolution(resolutionMatch[1].trim());
    } else if (modelMatch) {
      model = modelMatch[1].trim();
    } else if (durationMatch) {
      duration = normalizeDuration(durationMatch[1].trim());
    } else {
      promptLines.push(line);
    }
  }

  return {
    text: promptLines.join("\n").trim(),
    resolution,
    model: model || "",
    duration,
  };
}

function normalizeResolution(value: string): string {
  const digits = value.match(/\d{3,4}/);
  return digits ? `${digits[0]}p` : value;
}

/** "6" hoặc "6s" đều chuẩn hoá về "6s" — khớp đúng nhãn chip trên site (durationChipCandidates). */
function normalizeDuration(value: string): string {
  const digits = value.match(/\d{1,2}/);
  return digits ? `${digits[0]}s` : value;
}
