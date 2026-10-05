/**
 * Mở 1 hội thoại Gemini (URL in trong log "[gemini] askGemini(...): url hội
 * thoại: ...") bằng session của bot (GEMINI_STORAGE_STATE_PATH) để xem lại.
 * Mở xong CHỜ nhấn Enter (để xem/thao tác trên trình duyệt trước, chạy với
 * HEADLESS=false) — nhấn Enter mới cuộn lên tải HẾT các lượt cũ, in tóm tắt
 * từng lượt (số khối code, JSON hợp lệ hay hỏng, có "ĐÃ HOÀN THÀNH" không),
 * lưu toàn bộ HTML + ảnh chụp vào storage/debug/ rồi đóng. --no-wait: lưu ngay.
 *
 *   npx tsx scripts/open-gemini.ts [url] [--no-wait]
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { getGeminiBrowserContext } from "../src/automation/geminiBrowser";

const DONE_MARKER = "ĐÃ HOÀN THÀNH";

async function main(): Promise<void> {
  // URL truyền qua tham số; không truyền thì dùng URL mặc định gán sẵn.
  const url =
    process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg)) ??
    'https://gemini.google.com/u/9/app/05dee6b46cfb2d1f';
  const noWait = process.argv.includes("--no-wait");
  if (!url || !/^https?:\/\//.test(url)) {
    console.error("Cách dùng: npx tsx scripts/open-gemini.ts <url hội thoại Gemini> [--no-wait]");
    process.exit(1);
  }

  const context = await getGeminiBrowserContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .locator("model-response")
    .first()
    .waitFor({ state: "attached", timeout: 60_000 })
    .catch(() => console.warn("⚠️ Chưa thấy lượt trả lời nào (sai URL/chưa đăng nhập?)."));

  // Theo yêu cầu người dùng: nhấn Enter mới lưu debug (xem/thao tác trên
  // trình duyệt trước).
  if (!noWait) {
    console.log("\nĐã mở hội thoại — nhấn Enter để lưu debug (HTML + ảnh chụp + tóm tắt) rồi đóng...");
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });
  }

  // Hội thoại dài chỉ render các lượt gần nhất — cuộn lên đầu tới khi số lượt
  // không tăng nữa để tải hết.
  let previous = -1;
  for (let i = 0; i < 50; i++) {
    const count = await page.locator("model-response").count();
    if (count === previous) break;
    previous = count;
    await page.evaluate(() => {
      const scroller = document.querySelector("#chat-history");
      if (scroller) scroller.scrollTop = 0;
    });
    await page.waitForTimeout(1500);
  }

  const turns = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".conversation-container")).map((turn) => ({
      user: (turn.querySelector("user-query .query-text")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      text: turn.querySelector("model-response message-content")?.textContent ?? "",
      codeBlocks: Array.from(
        turn.querySelectorAll('model-response code[data-test-id="code-content"], model-response pre code'),
      ).map((el) => el.textContent ?? ""),
    })),
  );

  console.log(`\nHội thoại có ${turns.length} lượt:\n`);
  for (const [i, turn] of turns.entries()) {
    const blocks = [...new Set(turn.codeBlocks)];
    const blockInfo = blocks.map((block) => {
      try {
        const value = JSON.parse(block.trim());
        const summary = Array.isArray(value)
          ? `array ${value.length} item`
          : `object [${Object.keys(value as object).join(", ")}]`;
        return `✅ hợp lệ (${summary})`;
      } catch {
        return `❌ HỎNG (${block.length} ký tự, đuôi: "${block.trim().slice(-60).replace(/\s+/g, " ")}")`;
      }
    });
    console.log(
      `Lượt ${i + 1}: user="${turn.user.slice(0, 70)}${turn.user.length > 70 ? "…" : ""}"`,
    );
    console.log(
      `  ${blocks.length} khối code${blockInfo.length ? ": " + blockInfo.join(" | ") : ""}; marker "${DONE_MARKER}": ${turn.text.includes(DONE_MARKER) ? "CÓ" : "không"}`,
    );
    if (blocks.length === 0) {
      console.log(`  text: "${turn.text.replace(/\s+/g, " ").trim().slice(0, 150)}"`);
    }
  }

  fs.mkdirSync(config.debugDir, { recursive: true });
  // Chỉ lấy id trong pathname — bỏ query (vd "?hl=vi") khỏi tên file.
  const conversationId = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "gemini";
  const htmlPath = path.join(config.debugDir, `gemini-${conversationId}.html`);
  const pngPath = path.join(config.debugDir, `gemini-${conversationId}.png`);
  fs.writeFileSync(htmlPath, await page.content(), "utf-8");
  await page.screenshot({ path: pngPath }).catch(() => {});
  console.log(`\nĐã lưu HTML: ${htmlPath}\nẢnh chụp: ${pngPath}`);
  await page.close().catch(() => {});
  await getGeminiBrowserContext.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await getGeminiBrowserContext.close().catch(() => {});
  process.exit(1);
});
