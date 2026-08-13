import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";

/**
 * Ghép cookie + localStorage export thủ công (từ Chrome bình thường, KHÔNG
 * qua Playwright/proxy) thành đúng format storageState mà Playwright dùng,
 * ghi vào STORAGE_STATE_PATH. Dùng khi npm run login gặp vấn đề (proxy chặn
 * Google OAuth) — xem hướng dẫn export ở README mục "Export session thủ công".
 *
 * Input:
 *   storage/manual-cookies.json      — export bằng extension Cookie-Editor
 *   storage/manual-localstorage.json — copy từ Console:
 *     copy(JSON.stringify(Object.entries(localStorage).map(([name, value]) => ({name, value}))))
 */

const COOKIES_INPUT = path.resolve("./storage/manual-cookies.json");
const LOCAL_STORAGE_INPUT = path.resolve("./storage/manual-localstorage.json");

interface CookieEditorCookie {
  domain: string;
  expirationDate?: number;
  hostOnly?: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite?: string;
  secure: boolean;
  session?: boolean;
  value: string;
}

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

function mapSameSite(value: string | undefined): "Strict" | "Lax" | "None" {
  switch ((value ?? "").toLowerCase()) {
    case "strict":
      return "Strict";
    case "no_restriction":
    case "none":
      return "None";
    default:
      return "Lax";
  }
}

function convertCookie(cookie: CookieEditorCookie): PlaywrightCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: mapSameSite(cookie.sameSite),
  };
}

function main(): void {
  if (!fs.existsSync(COOKIES_INPUT)) {
    throw new Error(`Không tìm thấy ${COOKIES_INPUT}. Export cookie bằng Cookie-Editor rồi lưu vào đây.`);
  }
  if (!fs.existsSync(LOCAL_STORAGE_INPUT)) {
    throw new Error(
      `Không tìm thấy ${LOCAL_STORAGE_INPUT}. Chạy snippet Console lấy localStorage rồi lưu vào đây.`,
    );
  }

  const rawCookies: CookieEditorCookie[] = JSON.parse(fs.readFileSync(COOKIES_INPUT, "utf-8"));
  const localStorageEntries: Array<{ name: string; value: string }> = JSON.parse(
    fs.readFileSync(LOCAL_STORAGE_INPUT, "utf-8"),
  );

  const storageState = {
    cookies: rawCookies.map(convertCookie),
    origins: [
      {
        origin: config.aiVideoBaseUrl,
        localStorage: localStorageEntries,
      },
    ],
  };

  fs.mkdirSync(path.dirname(config.storageStatePath), { recursive: true });
  fs.writeFileSync(config.storageStatePath, JSON.stringify(storageState, null, 2), "utf-8");
  console.log(`Đã ghi ${storageState.cookies.length} cookie + ${localStorageEntries.length} localStorage entry`);
  console.log(`vào ${config.storageStatePath}`);
}

main();
