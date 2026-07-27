export interface ParsedPrompt {
  text: string;
  resolution?: string;
  model?: string;
}

const RESOLUTION_LINE = /^resolution\s*:\s*(.+)$/i;
const MODEL_LINE = /^model\s*:\s*(.+)$/i;

/**
 * Tách nội dung prompt user gửi thành phần text + tuỳ chọn Resolution/Model,
 * theo format:
 *   video xe thể thao đi
 *   Resolution: 1080
 *   Model: Hailuo 2.0
 */
export function parsePromptMessage(raw: string): ParsedPrompt {
  const promptLines: string[] = [];
  let resolution: string | undefined;
  let model: string | undefined;

  for (const line of raw.split("\n")) {
    const resolutionMatch = line.match(RESOLUTION_LINE);
    const modelMatch = line.match(MODEL_LINE);

    if (resolutionMatch) {
      resolution = normalizeResolution(resolutionMatch[1].trim());
    } else if (modelMatch) {
      model = modelMatch[1].trim();
    } else {
      promptLines.push(line);
    }
  }

  return {
    text: promptLines.join("\n").trim(),
    resolution,
    model: model || "Hailuo 2.0",
  };
}

function normalizeResolution(value: string): string {
  const digits = value.match(/\d{3,4}/);
  return digits ? `${digits[0]}p` : value;
}
