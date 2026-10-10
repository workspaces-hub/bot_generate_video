/**
 * Dựng file đính kèm cho job "Tạo kịch bản mới" (GENERATE_SCRIPT_BUTTON_LABEL):
 * master prompt config.promptGenerateScript + tên gợi ý + nội dung các file
 * JSON tham chiếu (trong config.chatAIResultsDir). Tách khỏi handlers.ts để
 * queue.ts dùng lại được — nút "Remake (all flow)" tự tạo job này ngay khi lô
 * "Tham chiếu video" xong (queue không import được handlers).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";

/** Prompt ngắn gửi kèm file đính kèm tổng hợp (nội dung thật nằm trong file). */
export const GENERATE_SCRIPT_ATTACHMENT_PROMPT =
  "Hãy đọc kỹ và thực hiện đúng yêu cầu trong file đính kèm sau (bao gồm cả các file JSON tham chiếu được ghép kèm theo trong đó)";

export class GenerateScriptAttachmentError extends Error {}

/**
 * Ghi file đính kèm tổng hợp vào config.uploadsDir, trả về path. fileNames là
 * tên file JSON tham chiếu trong config.chatAIResultsDir, ĐÚNG thứ tự tập.
 * Lỗi đọc master prompt/file tham chiếu → GenerateScriptAttachmentError (message
 * gửi thẳng cho user được).
 */
export async function writeGenerateScriptAttachment(
  remakeBaseName: string,
  fileNames: string[],
): Promise<string> {
  const masterPrompt = await fs.readFile(config.promptGenerateScript, "utf-8").catch((err) => {
    console.error(`[generateScript] Không đọc được master prompt "${config.promptGenerateScript}":`, err);
    throw new GenerateScriptAttachmentError("Không đọc được master prompt cho tính năng này.");
  });
  const sections: string[] = [
    masterPrompt,
    `\n\n## OUTPUT_BASENAME_GOI_Y\n${remakeBaseName}`,
    `\n\n## DANH SÁCH FILE JSON THAM CHIẾU (${fileNames.length} tập)`,
  ];
  for (const [i, fileName] of fileNames.entries()) {
    const content = await fs.readFile(path.join(config.chatAIResultsDir, fileName), "utf-8").catch((err) => {
      console.error(`[generateScript] Không đọc được file tham chiếu "${fileName}":`, err);
      throw new GenerateScriptAttachmentError(`Không đọc được file "${fileName}".`);
    });
    sections.push(`\n\n### TẬP ${i + 1}: ${fileName}\n\`\`\`json\n${content}\n\`\`\``);
  }
  await fs.mkdir(config.uploadsDir, { recursive: true });
  const attachmentPath = path.join(config.uploadsDir, `${randomUUID()}-generate-script.txt`);
  await fs.writeFile(attachmentPath, sections.join(""), "utf-8");
  return attachmentPath;
}

/**
 * Tên phim gốc từ tên video tham chiếu — bỏ đuôi file và số tập ("02_abc.mp4",
 * "abc_tap2.mp4", "abc-ep03.mp4" → "abc"). Dùng làm searchTerm / gốc tên remake.
 */
export function filmBaseNameFromVideo(videoFileName: string): string {
  const base = path.basename(videoFileName, path.extname(videoFileName));
  const stripped = base
    .replace(/(^|[\s._-])(?:t[aậ]p|ep(?:isode)?|e|part)[\s._-]*\d{1,4}(?=$|[\s._-])/gi, "$1")
    .replace(/^\d{1,4}[\s._-]+/, "")
    .replace(/[\s._-]+\d{1,4}$/, "")
    .replace(/^[\s._-]+|[\s._-]+$/g, "");
  return (stripped || base).replace(/\s+/g, "_");
}
