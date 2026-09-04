import { config } from "../src/config";
import { getPolloBrowserContext } from "../src/automation/polloBrowser";
import { captureErrorSnapshot } from "../src/automation/aiVideo";
import { dismissBlockingOverlays } from "../src/automation/pollo";

async function inspectPage(page: import("playwright").Page, url: string, label: string): Promise<void> {
  console.log(`\n\n########## ${label} (${url}) ##########`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await dismissBlockingOverlays(page);

  const buttons = await page.locator("[data-button-name]").all();
  console.log(`Found ${buttons.length} elements with [data-button-name]:`);
  for (const btn of buttons) {
    const name = await btn.getAttribute("data-button-name").catch(() => null);
    const text = await btn.innerText().catch(() => "");
    console.log(`  data-button-name="${name}" text="${text.replace(/\n/g, " | ").slice(0, 100)}"`);
  }

  // Tìm mọi text trông giống độ dài video: "5s", "6s", "10s", "Duration" v.v.
  const durationLike = await page
    .locator("button, [role='button'], span")
    .filter({ hasText: /^\d{1,2}s$|duration/i })
    .all();
  console.log(`Found ${durationLike.length} elements matching duration-like text:`);
  for (const el of durationLike.slice(0, 20)) {
    const text = await el.innerText().catch(() => "");
    const tag = await el.evaluate((e) => e.tagName).catch(() => "?");
    console.log(`  <${tag}> text="${text.replace(/\n/g, " | ").slice(0, 60)}"`);
  }
}

async function main(): Promise<void> {
  const context = await getPolloBrowserContext();
  const page = await context.newPage();
  const jobId = "inspect-pollo-duration2";
  try {
    await inspectPage(
      page,
      new URL(
        "/reference-to-video?target=reference-to-video&modelName=minimax-hailuo-03",
        config.polloBaseUrl,
      ).toString(),
      "Reference to Video + MiniMax H3",
    );

    await inspectPage(page, new URL("/video", config.polloBaseUrl).toString(), "Default /video page");
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
    process.exit(0);
  }
}

main();
