import { config } from "../src/config";
import { getPolloImageBrowserContext } from "../src/automation/polloBrowser";

/**
 * Test THẬT: poll thẳng API generationPolling.fetchRecordsStatus (không mở
 * page, không đụng DOM — chỉ dùng context.request với cookie session có sẵn)
 * cho 2 record đã biết từ lần trace trước (123893038 đang gần đầu hàng đợi
 * waitingIndex 9/284, và 123894368 job vừa tạo) — mục đích: xem status
 * chuyển từ "waiting" sang gì khi THẬT SỰ xong, để biết chính xác chuỗi
 * trạng thái terminal trước khi viết code chính thức (không đoán bừa).
 */
async function main(): Promise<void> {
  const context = await getPolloImageBrowserContext();
  const recordIds = [123893038, 123894368];
  const url = new URL(
    "/api/trpc/generationPolling.fetchRecordsStatus",
    config.polloBaseUrl,
  );
  url.searchParams.set("input", JSON.stringify({ json: { recordIds } }));

  const seenStatus = new Map<number, string>();
  const start = Date.now();
  const maxMs = 8 * 60_000;

  while (Date.now() - start < maxMs) {
    const res = await context.request.get(url.toString());
    const rawText = await res.text().catch(() => "(không đọc được text)");
    let body: any = null;
    try {
      body = JSON.parse(rawText);
    } catch {}
    if (!body) {
      console.log(`status=${res.status()} raw=`, rawText.slice(0, 500));
    }
    const records = body?.result?.data?.json;
    if (Array.isArray(records)) {
      for (const rec of records) {
        const prev = seenStatus.get(rec.id);
        const cur = JSON.stringify(rec);
        if (cur !== prev) {
          console.log(
            `[${new Date().toISOString()}] id=${rec.id} =>`,
            JSON.stringify(rec),
          );
          seenStatus.set(rec.id, cur);
        }
      }
    } else {
      console.log("Response không đúng dạng mong đợi:", JSON.stringify(body).slice(0, 500));
    }
    await new Promise((r) => setTimeout(r, 6000));
  }

  console.log("\n=== HẾT thời gian poll ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Lỗi:", err);
  process.exit(1);
});
