# Voice AI Lễ Tân cho Tiệm Nail — Hướng dẫn từ A đến Z

Khách gọi vào số tiệm → Claude trả lời bằng giọng nói như lễ tân thật, song ngữ Việt/Anh, biết giờ mở cửa, bảng giá, và thu thập thông tin đặt lịch.

```
Khách gọi ──> Twilio (số điện thoại)
                 │  /twiml
                 ▼
        ConversationRelay  ──(nghe→chữ, chữ→giọng nói, canh lượt)
                 │  WebSocket /ws
                 ▼
        Server Railway (server.js) ──> Claude API
```
ConversationRelay lo hết phần audio. Server của anh chỉ trao đổi *chữ* với Claude.

---

## Cần chuẩn bị (đều có bản miễn phí để bắt đầu)
1. Tài khoản **Twilio** + một số điện thoại có Voice
2. **Anthropic API key** (`sk-ant-...`) — anh đã có từ phần SMS
3. Tài khoản **Railway** (railway.app) để host server
4. Đã cài **Node.js** trên máy (để chạy lệnh) — hoặc deploy thẳng từ GitHub

---

## BƯỚC 1 — Deploy server lên Railway

**Cách dễ nhất (qua CLI):**
```bash
cd nexora-voice
npm install
npm i -g @railway/cli
railway login
railway init          # đặt tên project
railway up            # deploy
```
Sau khi deploy, vào railway.app → project → tab **Settings → Networking → Generate Domain**.
Anh sẽ có domain dạng: `nexora-voice-production.up.railway.app`. **Ghi nhớ domain này.**

**Thêm biến môi trường:** Railway → project → tab **Variables**, thêm:

| Tên biến | Giá trị |
|---|---|
| `ANTHROPIC_API_KEY` | key `sk-ant-...` |
| `PRIMARY_LANGUAGE` | `en-US` (hoặc `vi-VN` nếu khách chủ yếu nói tiếng Việt) |
| `TTS_VOICE` | `en-US-Standard-C` (đổi theo ngôn ngữ) |

Lưu xong Railway tự deploy lại.

> Mẹo: Anh cũng có thể push code lên GitHub rồi bấm "Deploy from GitHub" trên Railway — khỏi dùng dòng lệnh.

---

## BƯỚC 2 — Nối số Twilio vào server
Twilio Console → Phone Numbers → chọn số của anh → mục **Voice & Fax → "A call comes in"**:
- Chọn **Webhook** · **HTTP POST**
- Dán: `https://nexora-voice-production.up.railway.app/twiml`
  (thay bằng domain Railway thật của anh)
- Bấm **Save**.

---

## BƯỚC 3 — Gọi thử 🎉
Lấy điện thoại gọi vào số Twilio. Claude sẽ chào và nói chuyện với anh như lễ tân.
Thử hỏi: *"Tiệm mở cửa mấy giờ?"*, *"Làm gel bao nhiêu tiền?"*, *"Tôi muốn đặt lịch"*.

---

## Chỉnh nội dung tiệm
Mở `server.js`, sửa khối `BUSINESS` (tên, giờ, địa chỉ, **bảng giá**) và câu chào `WELCOME`.
**Quan trọng:** viết số bằng chữ (vd "ba mươi lăm đô la") để máy đọc cho đúng và tự nhiên.

## Đổi sang giọng/ngôn ngữ tiếng Việt
- Đặt `PRIMARY_LANGUAGE=vi-VN`
- Chọn `TTS_VOICE` là giọng tiếng Việt (xem danh sách trong tài liệu ConversationRelay của Twilio: phần Voices).

## Chi phí (tham khảo — tự xác minh giá mới nhất)
- Twilio Voice: phí số/tháng + phí phút gọi + phí ConversationRelay/phút
- Claude Haiku: rất rẻ mỗi cuộc. Đổi `claude-sonnet-4-6` trong `server.js` nếu cần thông minh hơn (đắt hơn, hơi chậm hơn).

---

## Đã có sẵn trong bản này (Bước 1 + 2 của lộ trình)
- ✅ Gọi vào là Claude chào và trò chuyện được
- ✅ Lễ tân tiệm nail: giờ, giá, địa chỉ + guardrails
- ✅ Song ngữ Việt/Anh trong câu trả lời
- ✅ Chỉ báo giá thật, không tự xác nhận lịch, chuyển người thật khi cần
- ✅ Stream giọng nói ngay khi Claude vừa "nói" (giảm độ trễ)
- ✅ Khách chen ngang thì Claude dừng lắng nghe

## Bước tiếp theo (khi anh sẵn sàng)
- **Bước 3 — Chuyển cuộc gọi cho nhân viên thật** (dùng Twilio TaskRouter / `<Dial>`)
- **Bước 4 — Nhớ khách quen + đặt lịch tự động** nối vào hệ NEXORA (thêm Redis lưu lịch sử theo số gọi + API booking)
