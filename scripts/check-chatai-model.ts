import { config } from "../src/config";
import {
  dismissCloudflareChallengeIfPresent,
  getChatAIBrowserContext,
} from "../src/automation/chatAIBrowser";
import {
  assistantTextMessageLocator,
  modelSelectorButtonCandidates,
  promptTextareaCandidates,
  sendButtonCandidates,
  signInIndicatorCandidates,
  stopGeneratingButtonCandidates,
} from "../src/automation/chatAISelectors";
import { firstVisible } from "../src/automation/selectors";
import { captureErrorSnapshot } from "../src/automation/aiVideo";

/**
 * Kiểm tra ChatAI hiện đang chạy model gì — gửi 1 prompt cực ngắn
 * ("ping") rồi đọc attribute "data-message-model-slug" trên tin nhắn trả
 * lời thật (DOM thật xác nhận, job b38b1151: giá trị vd "gpt-5-6-thinking")
 * — đáng tin cậy hơn hẳn chỉ đọc nhãn hiển thị trên nút chọn model ở toolbar
 * (nhãn đó chỉ là mức độ suy luận "Medium"/"Fast"..., không phải tên model
 * đầy đủ, và không đảm bảo phản ánh đúng model THẬT SỰ xử lý câu trả lời nếu
 * đang để "Auto").
 *
 * Cách dùng: npm run check-chatai-model
 */
async function main(): Promise<void> {
  const context = await getChatAIBrowserContext();
  const page = await context.newPage();
  const jobId = "check-chatai-model";
  try {
    await page.goto(config.chatAIBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await dismissCloudflareChallengeIfPresent(page);

    const signedOut = await firstVisible(signInIndicatorCandidates(page), 5000)
      .then(() => true)
      .catch(() => false);
    if (signedOut) {
      console.log("❌ Chưa đăng nhập ChatAI hoặc session đã hết hạn. Chạy: npm run login-chatai");
      process.exit(1);
    }

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    // Đọc nhãn hiển thị trên nút chọn model TRƯỚC khi gửi gì cả — best-effort,
    // chỉ mang tính tham khảo (xem comment modelSelectorButtonCandidates).
    const selectorLabel = await firstVisible(modelSelectorButtonCandidates(page), 5000)
      .then((el) => el.innerText())
      .catch(() => null);
    if (selectorLabel) {
      console.log(`Nhãn mức suy luận đang chọn trên toolbar: "${selectorLabel.trim()}"`);
    } else {
      console.log("Không đọc được nhãn trên nút chọn model (không ảnh hưởng tới kết quả bên dưới).");
    }

    console.log('\nĐang gửi prompt thử ("ping") để xác định model thật...');
    const textarea = await firstVisible(promptTextareaCandidates(page), 20_000);
    await textarea.click();
    await page.keyboard.insertText("ping");

    const sendButton = await firstVisible(sendButtonCandidates(page), 10_000);
    await sendButton.click();

    await firstVisible(stopGeneratingButtonCandidates(page), 10_000).catch(() => {});
    // Chờ tới khi nút Stop biến mất — ChatAI trả lời xong ("ping" luôn là phản
    // hồi cực ngắn nên không cần cơ chế debounce phức tạp như askChatAI thật).
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const stillGenerating = await firstVisible(stopGeneratingButtonCandidates(page), 500)
        .then(() => true)
        .catch(() => false);
      if (!stillGenerating) break;
      await page.waitForTimeout(1000);
    }

    const messages = assistantTextMessageLocator(page);
    const count = await messages.count();
    if (count === 0) {
      console.log("❌ Không tìm thấy tin nhắn trả lời nào để đọc model — thử lại hoặc kiểm tra debug snapshot.");
      process.exit(1);
    }

    const modelSlug = await messages.last().getAttribute("data-message-model-slug");
    if (modelSlug) {
      console.log(`\n✅ Model thật đang xử lý: "${modelSlug}"`);
    } else {
      console.log(
        "\n⚠️  Tin nhắn trả lời không có attribute data-message-model-slug — có thể ChatAI đã đổi cấu trúc DOM, cần cập nhật lại src/automation/chatAISelectors.ts.",
      );
    }
  } catch (err) {
    await captureErrorSnapshot(page, jobId, err);
    console.error("Script thất bại:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await page.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
