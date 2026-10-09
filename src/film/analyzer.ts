/**
 * Stage 3 — MULTIMODAL CLIP ANALYZER: Gemini xem 1 clip + nhận shot list
 * (segId, chỉ đọc), thoại Whisper (nếu có) và Story Memory hiện tại (bản rút
 * gọn) → trả MemoryDelta. Clip phân tích TUẦN TỰ: clip K thấy memory sau
 * clip K-1, nên dùng lại đúng id nhân vật/đạo cụ và nối được mạch truyện.
 */
import path from "node:path";
import { config } from "../config";
import { jsonSection, runFilmStage } from "./llm";
import { applyDelta, compactMemory, normalizeDelta, repairDelta, validateDelta } from "./memory";
import { formatSeconds } from "./timeline";
import type { ClipTranscript, GlobalTimeline, MemoryDelta, SourceClip, StoryMemory } from "./types";

export function buildAnalyzeContext(
  clip: SourceClip,
  tl: GlobalTimeline,
  transcript: ClipTranscript | null,
  memory: StoryMemory,
  /** Số tập gốc của clip phân tích ngay trước (null = chưa có tập nào). */
  previousEpisode: number | null = null,
): string {
  const placement = tl.clips.find((c) => c.clipId === clip.clipId)!;
  const segs = tl.segments.filter((s) => s.clipId === clip.clipId);
  const shotList = segs.map((s) => ({
    seg_id: s.segId,
    // Mốc trong FILE CLIP để định vị khi xem — CHỈ ĐỌC, không ghi lại vào kết quả.
    in_clip: `${formatSeconds(s.localStart)}–${formatSeconds(s.localEnd)}`,
    length_s: Math.round((s.localEnd - s.localStart) * 10) / 10,
  }));
  const tag = clip.clipId.replace(/^C/i, "");
  // Tập gốc trước đó chưa phân tích (gửi tập 2 khi chưa có tập 1, hoặc nhảy 3 → 6):
  // báo Gemini rằng phim KHÔNG bắt đầu ở đây, để không hiểu nhầm quan hệ/bí mật
  // đã có từ trước thành chuyện mới xảy ra.
  const episode = clip.sourceEpisode;
  const firstMissing = (previousEpisode ?? 0) + 1;
  const gapNote =
    episode !== null && episode > firstMissing
      ? `\n\n## CÁC TẬP TRƯỚC CHƯA ĐƯỢC PHÂN TÍCH\nĐây là TẬP GỐC ${episode}, nhưng tập ${firstMissing === episode - 1 ? firstMissing : `${firstMissing}–${episode - 1}`} KHÔNG có trong dữ liệu (chưa gửi)${previousEpisode ? `; memory bên dưới dừng ở tập ${previousEpisode}` : ""}. Phim KHÔNG bắt đầu ở clip này: nhân vật, quan hệ, bí mật và xung đột có thể đã được thiết lập ở các tập đó.
- Điều video cho thấy là ĐÃ CÓ TỪ TRƯỚC (vd đã là vợ chồng, đã thù nhau, đã biết bí mật) → ghi vào description/role/relations của nhân vật và vào knowledge (known_by.since_event = event ĐẦU TIÊN trong clip này thể hiện điều đó). KHÔNG tạo event như thể chuyện đó vừa xảy ra.
- Câu hỏi treo từ trước mà clip nhắc tới → mở thread với setup_events là event đầu tiên nhắc tới nó trong clip này.
- Đoạn recap/"previously" đầu tập (nếu có) là nguồn tốt nhất để hiểu các tập thiếu — đánh dấu kind "recap" nhưng dùng nội dung của nó để điền bối cảnh trên.`
      : "";
  return [
    `## CLIP ĐANG PHÂN TÍCH\nclip_id: ${clip.clipId} — ${episode !== null ? `TẬP GỐC ${episode}, ` : ""}clip thứ ${tl.clips.indexOf(placement) + 1} đã phân tích của phim (đợt ${clip.batch}).`,
    placement.trimHead > 0
      ? `\nBỎ QUA ${placement.trimHead}s đầu video (lặp lại đuôi clip trước) — shot list dưới đây đã bắt đầu sau đoạn đó.`
      : "",
    `\nId mới trong clip này: event E${tag}_<n>, fact F${tag}_<n>, thread T${tag}_<n>, reinterpretation R${tag}_<n>.`,
    gapNote,
    jsonSection(`SHOT LIST (${segs.length} segment — mô tả ĐỦ TẤT CẢ, tham chiếu bằng seg_id)`, shotList),
    transcript?.available && transcript.lines.length > 0
      ? jsonSection(
          "THOẠI NHẬN DẠNG TỰ ĐỘNG (Whisper — có thể sai chữ, đối chiếu với âm thanh; người nói tự xác định)",
          transcript.lines.map((l) => ({ segId: l.segId, text: l.text })),
        )
      : "\n\n## THOẠI\nKhông có bản nhận dạng tự động — tự nghe thoại trong video.",
    memory.analyzed_clips.length > 0
      ? jsonSection("STORY MEMORY HIỆN TẠI (các clip trước — DÙNG LẠI id đã có cho cùng nhân vật/đạo cụ/bối cảnh)", compactMemory(memory))
      : `\n\n## STORY MEMORY HIỆN TẠI\nMemory rỗng (clip đầu tiên được phân tích${episode !== null && episode > 1 ? `, nhưng là TẬP ${episode} — xem mục các tập trước chưa phân tích` : ""}) — khai báo mọi nhân vật/đạo cụ/bối cảnh.`,
  ].join("");
}

/** Phân tích 1 clip → memory mới (đã kiểm tra + merge). Kết quả delta lưu analysis/<clipId>.json. */
export async function analyzeClip(opts: {
  jobId: string;
  filmDir: string;
  clip: SourceClip;
  tl: GlobalTimeline;
  transcript: ClipTranscript | null;
  memory: StoryMemory;
  /** Số tập gốc của clip phân tích ngay trước (null = chưa có). */
  previousEpisode?: number | null;
  clipIndex: number;
  clipCount: number;
  onStatus?: (text: string) => Promise<void>;
}): Promise<StoryMemory> {
  const { clip, tl, memory } = opts;
  const delta: MemoryDelta = await runFilmStage({
    jobId: opts.jobId,
    name: `analyze_${clip.clipId}`,
    label: `[3/7] Phân tích clip ${clip.clipId} (${opts.clipIndex}/${opts.clipCount}) với story memory`,
    promptPath: config.promptFilmAnalyze,
    context: buildAnalyzeContext(clip, tl, opts.transcript, memory, opts.previousEpisode ?? null),
    videoPath: clip.path,
    outPath: path.join(opts.filmDir, "analysis", `${clip.clipId}.json`),
    parse: (raw) => {
      const { delta, fixes } = repairDelta(memory, normalizeDelta(raw, clip.clipId), tl, clip.clipId);
      if (fixes.length > 0) console.warn(`[film] (${opts.jobId}) ${clip.clipId}: tự sửa ${fixes.length} lỗi vặt:\n- ${fixes.join("\n- ")}`);
      return delta;
    },
    validate: (d) => validateDelta(memory, d, tl, clip.clipId),
    onStatus: opts.onStatus,
  });
  return applyDelta(memory, delta, tl, clip.clipId, clip.batch);
}
