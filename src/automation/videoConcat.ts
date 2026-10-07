import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class VideoConcatError extends Error {}

interface VideoProfile {
  codec: string;
  width: string;
  height: string;
  frameRate: string;
  pixelFormat: string;
  hasAudio: boolean;
}

/**
 * Đọc thông số stream video (qua ffprobe) — dùng để QUYẾT ĐỊNH TRƯỚC có nên
 * ghép bằng stream copy hay không (xem concatVideos), KHÔNG phải để dò lỗi
 * SAU khi ffmpeg đã chạy.
 *
 * XÁC NHẬN QUA TEST THẬT (2 clip 320x240 và 640x480): ffmpeg concat demuxer
 * với "-c copy" KHÔNG hề báo lỗi/exit code khác 0 khi các clip khác
 * resolution — nó vẫn "thành công" (file output không rỗng) nhưng ra 1 file
 * HỎNG THẬT SỰ (ffprobe xác nhận: frame vừa 320x240 vừa 640x480 lẫn lộn
 * ngay trong CÙNG 1 file, kèm cảnh báo "non monotonically increasing dts"
 * khi decode lại). Nghĩa là KHÔNG THỂ dựa vào "ffmpeg -c copy không throw"
 * để biết ghép đúng hay sai — phải kiểm tra ĐỘ TƯƠNG THÍCH của các clip
 * TRƯỚC, rồi mới quyết định dùng stream copy hay bắt buộc re-encode.
 *
 * SỬA (xác nhận qua test thật): `-of csv=p=0` KHÔNG giữ đúng thứ tự field
 * đã liệt kê trong `-show_entries stream=...` — ffprobe tự sắp lại theo thứ
 * tự nội bộ riêng (test thật: yêu cầu "codec_name,width,height,r_frame_rate,
 * pix_fmt" nhưng trả về đúng thứ tự "codec_name,width,height,pix_fmt,
 * r_frame_rate" — 2 field cuối bị ĐẢO NGƯỢC). Destructure theo VỊ TRÍ như
 * bản đầu ĐỌC SAI GIÁ TRỊ (frameRate/pixelFormat bị hoán đổi cho nhau) mà
 * KHÔNG hề báo lỗi gì — âm thầm sai, cực nguy hiểm. Chuyển hẳn sang `-of
 * json`, đọc theo TÊN field (a.width, a.pix_fmt...), không phụ thuộc thứ tự
 * trả về của ffprobe nữa.
 */
interface FfprobeStreamsJson {
  streams?: Array<{
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    pix_fmt?: string;
  }>;
}

async function probeVideoProfile(videoPath: string): Promise<VideoProfile> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,pix_fmt",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed: FfprobeStreamsJson = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream || !stream.codec_name || !stream.width || !stream.height) {
    throw new VideoConcatError(
      `ffprobe không đọc được thông số video stream của "${videoPath}".`,
    );
  }

  const { stdout: audioOut } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    videoPath,
  ]);

  return {
    codec: stream.codec_name,
    width: String(stream.width),
    height: String(stream.height),
    frameRate: stream.r_frame_rate ?? "",
    pixelFormat: stream.pix_fmt ?? "",
    hasAudio: audioOut.trim().length > 0,
  };
}

function sameProfile(a: VideoProfile, b: VideoProfile): boolean {
  return (
    a.codec === b.codec &&
    a.width === b.width &&
    a.height === b.height &&
    a.frameRate === b.frameRate &&
    a.pixelFormat === b.pixelFormat &&
    a.hasAudio === b.hasAudio
  );
}

/**
 * Ghép nhiều clip video NGẮN theo ĐÚNG THỨ TỰ trong videoPaths thành 1 file
 * video duy nhất tại destPath — dùng ffmpeg (đã có sẵn trong môi trường, xem
 * extractAudioForQwen/compressVideoForQwen trong qwenAI.ts).
 *
 * Đọc profile (codec/resolution/fps/pixel format/có audio hay không) của
 * TỪNG clip qua ffprobe TRƯỚC (probeVideoProfile) rồi mới chọn cách ghép —
 * xem docstring probeVideoProfile để biết TẠI SAO không thể "cứ thử stream
 * copy rồi bắt lỗi sau":
 * - Mọi clip CÙNG profile → "stream copy" (-c copy, KHÔNG re-encode) — rất
 *   nhanh, không mất chất lượng. Đây là trường hợp phổ biến nhất (mọi clip
 *   do CÙNG 1 pipeline gen video tạo ra — vd cùng model/cùng cấu hình
 *   ComfyUI/pollo.ai cho 1 storyboard).
 * - Có ít nhất 1 clip khác profile → RE-ENCODE qua filter "concat"
 *   (-filter_complex) — chậm hơn (decode+encode lại toàn bộ) nhưng luôn ra
 *   kết quả đúng, tự chuẩn hoá mọi clip về cùng 1 profile.
 */
export async function concatVideos(
  videoPaths: string[],
  destPath: string,
): Promise<void> {
  if (videoPaths.length === 0) {
    throw new VideoConcatError(
      "Danh sách video rỗng — không có gì để ghép.",
    );
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  if (videoPaths.length === 1) {
    await fs.promises.copyFile(videoPaths[0], destPath);
    return;
  }

  const profiles = await Promise.all(videoPaths.map(probeVideoProfile));
  const allSameProfile = profiles.every((p) => sameProfile(p, profiles[0]));

  if (allSameProfile) {
    await concatByStreamCopy(videoPaths, destPath);
  } else {
    console.warn(
      `[videoConcat] Các clip không đồng nhất codec/resolution/fps/audio — ghép bằng re-encode (chậm hơn nhưng đảm bảo đúng).`,
    );
    await concatByReencode(videoPaths, destPath, profiles[0]);
  }
}

async function concatByStreamCopy(
  videoPaths: string[],
  destPath: string,
): Promise<void> {
  const listPath = `${destPath}.concat-list.txt`;
  // ffmpeg concat demuxer: mỗi dòng "file '<path>'" — escape dấu nháy đơn
  // trong path (hiếm gặp nhưng an toàn hơn) theo đúng cú pháp shell-style mà
  // ffmpeg tự đọc file này (KHÔNG phải shell thật, nhưng ffmpeg áp dụng cùng
  // quy tắc escape).
  const listContent = videoPaths
    .map(
      (p) => `file '${path.resolve(p).replace(/'/g, String.raw`'\''`)}'`,
    )
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      destPath,
    ]);
  } catch (err) {
    throw new VideoConcatError(
      `ffmpeg (stream copy) thất bại: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await fs.promises.unlink(listPath).catch(() => {});
  }

  const stat = await fs.promises.stat(destPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new VideoConcatError(
      "ffmpeg (stream copy) không tạo được file output hợp lệ.",
    );
  }
}

/**
 * SỬA (xác nhận qua test thật: 2 clip 320x240 và 640x480): filter "concat"
 * của ffmpeg đòi hỏi MỌI input đã CÙNG resolution/SAR khi tới filter đó —
 * KHÔNG tự scale — nối thẳng "[i:v:0][i:a:0]...concat" như bản đầu chỉ hoạt
 * động khi resolution ĐÃ giống nhau sẵn (tức lại đúng trường hợp mà stream
 * copy đã xử lý được rồi, vô nghĩa). Test thật với clip khác resolution báo
 * lỗi ngay: "Input link in0:v0 parameters (size 640x480...) do not match
 * the corresponding output link in0:v0 parameters (320x240...)". Phải chuẩn
 * hoá (scale/pad/fps/format) TỪNG input về ĐÚNG 1 profile chung (lấy theo
 * clip ĐẦU TIÊN, target) TRƯỚC khi đưa vào concat — dùng
 * "scale=...force_original_aspect_ratio=decrease" + "pad" (letterbox/
 * pillarbox thay vì kéo méo hình) cho trường hợp lệch tỉ lệ khung hình,
 * "fps"/"format"/"setsar=1" cho các thuộc tính còn lại. Audio cũng chuẩn
 * hoá riêng (aformat) — concat cũng đòi audio cùng sample rate/channel
 * layout, không chỉ video.
 */
async function concatByReencode(
  videoPaths: string[],
  destPath: string,
  target: VideoProfile,
): Promise<void> {
  const withAudio = target.hasAudio;
  const inputArgs = videoPaths.flatMap((p) => ["-i", p]);

  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  const normalizeFilters = videoPaths.map((_, i) => {
    const vLabel = `v${i}`;
    videoLabels.push(vLabel);
    const videoFilter =
      `[${i}:v:0]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,` +
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=${target.frameRate},format=${target.pixelFormat},setsar=1[${vLabel}]`;
    if (!withAudio) return videoFilter;

    const aLabel = `a${i}`;
    audioLabels.push(aLabel);
    const audioFilter = `[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[${aLabel}]`;
    return `${videoFilter};${audioFilter}`;
  });

  const concatInputs = withAudio
    ? videoLabels.map((v, i) => `[${v}][${audioLabels[i]}]`).join("")
    : videoLabels.map((v) => `[${v}]`).join("");
  const concatFilter = `${concatInputs}concat=n=${videoPaths.length}:v=1:a=${withAudio ? 1 : 0}[outv]${withAudio ? "[outa]" : ""}`;

  const filter = [...normalizeFilters, concatFilter].join(";");

  const mapArgs = withAudio
    ? ["-map", "[outv]", "-map", "[outa]"]
    : ["-map", "[outv]"];

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs,
      "-filter_complex",
      filter,
      ...mapArgs,
      destPath,
    ]);
  } catch (err) {
    throw new VideoConcatError(
      `ffmpeg (re-encode concat) thất bại: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const stat = await fs.promises.stat(destPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new VideoConcatError(
      "ffmpeg (re-encode) không tạo được file output hợp lệ.",
    );
  }
}

/** Các fps chuẩn — fps đo được làm tròn về giá trị gần nhất (vd 29.97 → 30, 23.976 → 24). */
const STANDARD_FRAME_RATES = [24, 25, 30, 60];

/**
 * FPS của video (ffprobe, ưu tiên avg_frame_rate — đúng hơn với video VFR),
 * làm tròn về fps chuẩn gần nhất trong STANDARD_FRAME_RATES (bằng khoảng thì
 * lấy giá trị nhỏ hơn). null nếu không đọc được.
 */
export async function probeFrameRate(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      videoPath,
    ]);
    const stream = (
      JSON.parse(stdout) as { streams?: { avg_frame_rate?: string; r_frame_rate?: string }[] }
    ).streams?.[0];
    for (const raw of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
      const [num, den] = (raw ?? "").split("/").map(Number);
      const fps = den ? num / den : num;
      if (Number.isFinite(fps) && fps > 0) {
        return STANDARD_FRAME_RATES.reduce((best, candidate) =>
          Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best,
        );
      }
    }
  } catch {
    // ffprobe lỗi — để nơi gọi giữ nguyên giá trị cũ
  }
  return null;
}
