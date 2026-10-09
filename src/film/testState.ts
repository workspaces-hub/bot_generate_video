/**
 * Trạng thái 1 lần "Test prompt remake phim" — lưu storage/films/<phim>/tests/<testId>/state.json
 * sau MỖI bước, để bot crash/restart (job còn trong chatai-queue.json) hoặc
 * job dừng vì lỗi ("tiếp") chạy lại đúng từ bước dở thay vì làm lại từ đầu
 * (phân tích lại, tạo thêm 1 bản remake, archive mất ảnh/clip đã gen...).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./llm";
import { filmDirFor } from "./pipeline";

export interface FilmTestState {
  testId: string;
  filmId: string;
  episodes: number[];
  note?: string;
  /** Chế độ remake của lần test (giống gốc / đổi thế giới). */
  style?: "replica" | "faithful" | "transform";
  status: "running" | "failed" | "done";
  /** Bước đang/vừa làm — chỉ để hiển thị. */
  step: string;
  /** Đã phân tích xong các tập test. */
  analyzed?: boolean;
  /** Tên bản remake của lần test — chốt TRƯỚC khi viết, để chạy lại không tạo thêm bản mới. */
  remakeName?: string;
  /** Đã viết đủ JSON các tập test. */
  remakeDone?: boolean;
  /** storage/generated/<bản remake>/ — tạo (archive cũ) ĐÚNG 1 lần; chạy lại dùng nguyên, không archive. */
  genRoot?: string;
  /** Đã copy JSON vào generated/, đồng bộ asset ledger, gửi JSON cho user. */
  jsonPrepared?: boolean;
  /** Tập → video tập đã ghép. */
  finals: Record<string, string>;
  /** Video remake hoàn chỉnh (nối các tập). */
  fullPath?: string;
  error?: string;
  updatedAt: string;
}

export function testDirFor(filmId: string, testId: string): string {
  return path.join(filmDirFor(filmId), "tests", testId);
}

export function newTestId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function readTestState(filmId: string, testId: string): Promise<FilmTestState | null> {
  return readJson<FilmTestState>(path.join(testDirFor(filmId, testId), "state.json"));
}

export async function saveTestState(state: FilmTestState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(path.join(testDirFor(state.filmId, state.testId), "state.json"), state);
}

/**
 * Lần test CHƯA XONG gần nhất của phim (để "tiếp"). Thư mục test cũ (trước
 * khi có state.json) chưa có báo cáo so sánh cũng tính — số tập lấy từ các
 * file goc_tap<N> đã sao lưu.
 */
export async function findResumableTest(
  filmId: string,
): Promise<{ testId: string; episodes: number[]; note?: string; step: string } | null> {
  const root = path.join(filmDirFor(filmId), "tests");
  const ids = (await fsp.readdir(root).catch(() => [] as string[])).sort().reverse();
  for (const testId of ids) {
    const dir = path.join(root, testId);
    const state = await readTestState(filmId, testId);
    if (state) {
      if (state.status !== "done") return { testId, episodes: state.episodes, note: state.note, step: state.step };
      continue;
    }
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    if (files.some((f) => f.endsWith("_so_sanh.md"))) continue;
    const episodes = files
      .map((f) => Number(f.match(/^goc_tap(\d+)\./)?.[1]))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
    if (episodes.length > 0 && fs.existsSync(dir)) return { testId, episodes, step: "(lần test cũ, chưa có state)" };
  }
  return null;
}
