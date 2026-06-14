import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ──────────────────────────────────────────────────────────────
// THÔNG TIN TIỆM — chỉnh phần này cho đúng tiệm của anh
// ──────────────────────────────────────────────────────────────
const BUSINESS = {
  name: 'Bitcoin Nail Bar',
  hours: 'Thứ Hai đến Thứ Bảy, chín giờ rưỡi sáng đến bảy giờ rưỡi tối. Chủ Nhật, mười một giờ sáng đến năm giờ chiều.',
  address: 'một hai ba đường Main, thành phố ABC',
  phone: 'không không không, không không không, không không không không',
  // Bảng giá — Claude CHỈ báo giá trong danh sách này.
  priceList: `
- Gel manicure: ba mươi lăm đô la
- Dipping powder: bốn mươi lăm đô la
- Pedicure spa: bốn mươi đô la
- Full set acrylic: từ năm mươi đô la`,
};

// Giọng đọc & ngôn ngữ chính. Khách chủ yếu nói tiếng Việt thì đổi language="vi-VN".
const PRIMARY_LANGUAGE = process.env.PRIMARY_LANGUAGE || 'en-US';
const TTS_VOICE = process.env.TTS_VOICE || 'en-US-Standard-C'; // xem danh sách giọng trong docs ConversationRelay

const WELCOME = `Xin chào, cảm ơn quý khách đã gọi ${BUSINESS.name}. Em là trợ lý ảo, em có thể giúp gì cho mình ạ?`;

const SYSTEM_PROMPT = `Bạn là lễ tân trả lời điện thoại của tiệm nail "${BUSINESS.name}".
Cuộc nói chuyện này SẼ ĐƯỢC ĐỌC THÀNH TIẾNG cho khách nghe, nên hãy tuân thủ tuyệt đối:

QUY TẮC GIỌNG NÓI:
- Viết MỌI con số bằng chữ (ví dụ "ba mươi lăm đô la", không viết "$35").
- KHÔNG dùng emoji, dấu gạch đầu dòng, dấu hoa thị, ký hiệu đặc biệt.
- Câu ngắn, nói tự nhiên như người thật, mỗi lượt tối đa hai đến ba câu.
- Tự nhận diện khách đang nói tiếng Anh hay tiếng Việt và trả lời đúng ngôn ngữ đó.

THÔNG TIN TIỆM:
- Giờ mở cửa: ${BUSINESS.hours}
- Địa chỉ: ${BUSINESS.address}
- Số điện thoại: ${BUSINESS.phone}
- Bảng giá:${BUSINESS.priceList}

QUY TẮC NGHIỆP VỤ:
- CHỈ báo giá có trong bảng giá trên. Dịch vụ khác thì nói tiệm sẽ báo giá chính xác khi khách tới.
- KHÔNG tự xác nhận đã đặt lịch. Hãy hỏi tên, dịch vụ muốn làm, và ngày giờ mong muốn, rồi nói tiệm sẽ gọi lại xác nhận.
- Nếu khách bực bội, khiếu nại, hỏi điều ngoài hiểu biết, hoặc muốn gặp người thật, hãy nói sẽ chuyển cho nhân viên gọi lại ngay, đừng cố tự xử lý.
- Tuyệt đối không bịa thông tin, không hứa điều tiệm không kiểm soát được.`;

const fastify = Fastify();
await fastify.register(fastifyWs);

// 1) Endpoint TwiML — Twilio gọi vào đây khi có cuộc gọi đến
fastify.all('/twiml', async (req, reply) => {
  const host = process.env.PUBLIC_HOST || req.headers.host;
  const wsUrl = `wss://${host}/ws`;
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}"
      welcomeGreeting="${WELCOME}"
      language="${PRIMARY_LANGUAGE}"
      voice="${TTS_VOICE}"
      transcriptionProvider="google" />
  </Connect>
</Response>`
  );
});

// 2) WebSocket — ConversationRelay trò chuyện với Claude qua đây
fastify.register(async (f) => {
  f.get('/ws', { websocket: true }, (socket) => {
    const history = []; // lịch sử hội thoại trong 1 cuộc gọi
    let currentStream = null;

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'setup') {
        console.log('Cuộc gọi mới từ:', msg.from);
        return;
      }

      // Khách nói xong một lượt
      if (msg.type === 'prompt') {
        const userText = msg.voicePrompt || '';
        if (!userText.trim()) return;
        history.push({ role: 'user', content: userText });

        try {
          let full = '';
          currentStream = anthropic.messages.stream({
            model: 'claude-haiku-4-5-20251001', // nhanh, rẻ, hợp voice. Đổi 'claude-sonnet-4-6' nếu cần khôn hơn.
            max_tokens: 200,
            system: SYSTEM_PROMPT,
            messages: history,
          });

          // Stream token về Twilio ngay khi Claude vừa nói (giảm độ trễ)
          currentStream.on('text', (delta) => {
            full += delta;
            socket.send(JSON.stringify({ type: 'text', token: delta, last: false }));
          });

          await currentStream.finalMessage();
          socket.send(JSON.stringify({ type: 'text', token: '', last: true }));
          history.push({ role: 'assistant', content: full });
        } catch (err) {
          console.error('Lỗi Claude:', err);
          socket.send(JSON.stringify({
            type: 'text',
            token: 'Xin lỗi, hệ thống đang bận một chút. Mình vui lòng gọi lại sau giúp em nha.',
            last: true,
          }));
        }
      }

      // Khách chen ngang khi Claude đang nói -> dừng lại lắng nghe
      if (msg.type === 'interrupt' && currentStream) {
        try { currentStream.abort(); } catch {}
      }
    });

    socket.on('close', () => console.log('Cuộc gọi kết thúc.'));
  });
});

const port = process.env.PORT || 8080;
fastify.listen({ port, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Voice agent đang chạy tại ${addr}`);
});
