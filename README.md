# Hailuo Telegram Bot

Bot Telegram (Telegraf) được add làm admin của 1 group cố định
(`GROUP_CHAT_ID`). Trong group, gõ `/start` để hiện menu với nút
**📝 Prompt**. Bấm nút → bot hỏi nội dung prompt ngay trong group → gõ
prompt → bot tự động điền vào hailuoai.video, bấm generate, chờ video tạo
xong, tải về và đăng vào group. Nếu có lỗi ở bất kỳ bước nào, bot gửi `404`
vào group.

## Kiến trúc

- `src/index.ts` — khởi động bot Telegraf.
- `src/bot/` — xử lý nút bấm + hội thoại nhận prompt.
- `src/queue.ts` — hàng đợi xử lý tuần tự (1 video một lúc, tránh 2 tab cùng
  thao tác trên hailuoai.video).
- `src/automation/` — Playwright: đăng nhập, điền prompt, generate, chờ, tải
  video.
  - `selectors.ts` — nơi tập trung mọi CSS/role selector. **Đây là phần
    nhiều khả năng cần chỉnh sau lần chạy thử đầu tiên**, vì trang tạo video
    nằm sau đăng nhập nên không thể xác định chính xác DOM trước khi chạy
    thật.
- `scripts/login.ts` — mở Chromium thật để bạn đăng nhập tay 1 lần, lưu lại
  session (cookies/localStorage) cho bot dùng lại.

## Cài đặt

```bash
npm install
npm run playwright:install   # tải Chromium cho Playwright
cp .env.example .env
```

Điền vào `.env`:
- `BOT_TOKEN`: lấy từ [@BotFather](https://t.me/BotFather) (`/newbot`).
- `GROUP_CHAT_ID` (**bắt buộc**): group cố định để đăng video/`404` kết quả.
- `ADMINS` (**bắt buộc**): danh sách Telegram user id được phép dùng bot.

## Thêm bot vào group

1. Thêm bot vào group Telegram, lấy `GROUP_CHAT_ID` bằng cách thêm bot
   @userinfobot vào group (chat id group thường là số âm).
2. Vào **Group settings → Administrators → Add Admin**, chọn bot, cấp ít
   nhất quyền **Send Messages**. Việc gửi video/kết quả vào group không bắt
   buộc phải là admin, nhưng theo yêu cầu ban đầu, thêm làm admin để có thể
   mở rộng quyền (pin, xoá tin...) sau này.
3. **Tắt Privacy Mode của bot** qua BotFather (`/setprivacy` → chọn bot →
   Disable). Bắt buộc, vì nội dung prompt được gõ trực tiếp trong group —
   nếu không tắt, Telegram sẽ giấu các tin nhắn thường (không phải lệnh
   `/...`) khỏi bot, prompt sẽ không nhận được. Đổi Privacy Mode chỉ có
   hiệu lực với những group thêm bot vào SAU khi đổi — nếu bot đã ở trong
   group từ trước, hãy kick rồi add lại bot.

## Đăng nhập hailuoai.video (1 lần)

```bash
npm run login
```

Một cửa sổ Chrome thật sẽ mở ra → đăng nhập tay vào hailuoai.video (kể cả
nếu có captcha/OTP thì bạn tự xử lý) → quay lại terminal, nhấn Enter. Session
được lưu vào `storage/session.json`. Khi session hết hạn, chạy lại lệnh này.

**Lỗi "Couldn't sign you in — This browser or app may not be secure" khi
đăng nhập bằng Google:** Google chủ động chặn đăng nhập trong trình duyệt bị
điều khiển tự động (phát hiện qua CDP/automation flag). Project đã cấu hình
sẵn để dùng **Google Chrome thật** (`BROWSER_CHANNEL=chrome` trong `.env`,
yêu cầu máy đã cài Google Chrome) thay vì Chromium bundled của Playwright,
kèm gỡ cờ `--enable-automation` — cách này khắc phục được phần lớn trường
hợp. Nếu vẫn bị chặn:
- Thử đăng nhập hailuoai.video bằng **email/password** thay vì Google, nếu
  trang hỗ trợ.
- Hoặc đăng nhập Google vào hailuoai.video bằng trình duyệt Chrome bình
  thường (không qua script), sau đó dùng extension như "Cookie-Editor" để
  export cookie của domain hailuoai.video (không cần cookie của
  accounts.google.com) và ghép thủ công vào `storage/session.json` theo
  đúng format `storageState` của Playwright.

## Chạy bot

```bash
npm run dev     # chạy trực tiếp bằng tsx, tự reload khi sửa code
# hoặc
npm run build && npm run start
```

Trong group đã cấu hình ở `GROUP_CHAT_ID`, gõ `/start` để hiện menu với nút
**📝 Prompt**. Bấm nút → bot hỏi nội dung prompt → gõ prompt ngay trong
group. Video (hoặc `404` nếu lỗi) sẽ được đăng lại vào group đó.

## Khi automation lỗi / cần chỉnh selector

Mỗi lần một job lỗi, bot tự lưu:
- `storage/debug/<jobId>.png` — screenshot toàn trang tại thời điểm lỗi.
- `storage/debug/<jobId>.html` — HTML lúc đó.

Mở 2 file này để biết chính xác giao diện thật của hailuoai.video, rồi sửa
danh sách `*Candidates` tương ứng trong `src/automation/selectors.ts`
(ô nhập prompt, nút Generate, nút Download, thẻ `<video>`...). Vì đây là
web bên thứ ba không có API chính thức, selector có thể lệch khi họ đổi
giao diện — đây là điểm cần bảo trì định kỳ.

`HEADLESS=false` trong `.env` giúp bạn xem trực tiếp trình duyệt đang thao
tác gì trong lúc debug; đổi sang `true` khi đã ổn định và muốn chạy trên máy
chủ không có màn hình (cần thêm Xvfb nếu chạy trên Linux server headless
thật sự và trang vẫn chặn `headless: true`).

## Chạy trên VPS

VPS thường không có màn hình (GUI), trong khi bước đăng nhập Google cần
trình duyệt hiển thị thật để né bị chặn. Cách làm:

1. **Đăng nhập trên máy có GUI (máy Mac/laptop của bạn)** như hướng dẫn ở
   trên (`npm run login` với `BROWSER_CHANNEL=chrome`). Bước này chỉ cần làm
   khi lần đầu hoặc khi session hết hạn.
2. **Copy session sang VPS:**
   ```bash
   scp storage/session.json user@your-vps:/path/to/generate_video/storage/session.json
   ```
3. **Trên VPS**, cài dependencies và Chromium bundled của Playwright (không
   cần cài Google Chrome vì VPS không tự đăng nhập Google):
   ```bash
   npm install
   npx playwright install --with-deps chromium
   ```
4. Trong `.env` trên VPS:
   ```
   BROWSER_CHANNEL=chromium
   HEADLESS=true
   ```
   Vì lúc này bot chỉ tái sử dụng session đã đăng nhập sẵn (không chạy lại
   OAuth của Google trên VPS), chạy headless bình thường không bị chặn.
5. Chạy nền bằng `pm2` hoặc `systemd`, ví dụ với pm2:
   ```bash
   npm run build
   npx pm2 start dist/index.js --name hailuo-bot
   npx pm2 save
   ```
6. Nếu Chrome báo lỗi sandbox (`No usable sandbox`, thường gặp khi chạy
   trong container hoặc user root), đặt `CHROME_NO_SANDBOX=true` trong
   `.env` — chỉ bật khi thực sự cần vì nó giảm cô lập bảo mật của Chrome.

**Khi session hết hạn:** đăng nhập lại ở máy có GUI (bước 1), rồi copy đè
`storage/session.json` sang VPS (bước 2) và khởi động lại bot (không cần
cài lại gì khác).

## Giới hạn cần biết

- hailuoai.video có thể có cơ chế chống bot (Cloudflare, rate limit); script
  này không cố tình né các cơ chế đó, chỉ tự động hoá thao tác của một
  người dùng đã đăng nhập hợp lệ.
- Việc tự động hoá giao diện web bên thứ ba có thể vi phạm điều khoản dịch
  vụ của họ — hãy kiểm tra Điều khoản sử dụng của hailuoai.video trước khi
  chạy bot với tần suất cao.
- Xử lý tuần tự (1 video/lần) theo thiết kế, để tránh 2 tab cùng lúc gây
  xung đột trên cùng tài khoản. Nếu cần xử lý song song, cần nhiều tài
  khoản/session riêng.
