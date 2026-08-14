import { config } from "../src/config";
import { getBrowserContext } from "../src/automation/browser";
import { ensureLoggedIn, getGenerationFee } from "../src/automation/aiVideo";

const target = (process.argv[2] ?? "video").toLowerCase();
if (target !== "video" && target !== "image") {
  console.error(
    'Tham số phải là "video" hoặc "image" (mặc định "video"). Cách dùng: npm run check-fee -- image',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const createPath =
      target === "video"
        ? config.aiVideoCreateVideoPath
        : config.aiVideoCreateImagePath;
    const url = new URL(createPath, config.aiVideoBaseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ensureLoggedIn(page);

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    const fee = await getGenerationFee(page);
    if (fee === null) {
      throw new Error("Không tìm thấy/đọc được fee trên trang.");
    }

    console.log(`Fee tạo ${target === "video" ? "video" : "ảnh"}: ${fee}`);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "Không đọc được fee:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
