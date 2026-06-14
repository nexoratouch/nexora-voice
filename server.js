import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ──────────────────────────────────────────────────────────────
// THÔNG TIN TIỆM — chỉnh phần này cho đúng tiệm của anh
// ──────────────────────────────────────────────────────────────
const BUSINESS = {
  name: 'Bitcoin Nail Bar',
  // Đọc thành tiếng nên viết số bằng chữ.
  hours: 'Monday through Saturday, nine thirty A M to seven P M. Closed on Sunday.',
  address: 'nine seven nine three Westheimer Road, Suite A, Houston, Texas, seven seven zero four two',
  phone: 'three four six, eight zero two, four nine zero six',
};

// Giọng & ngôn ngữ chính. Khách chủ yếu nói tiếng Anh -> en-US (giọng mặc định).
const PRIMARY_LANGUAGE = process.env.PRIMARY_LANGUAGE || 'en-US';

const WELCOME = `Thank you for calling Bitcoin Nail Bar. This is our virtual assistant. How can I help you today?`;

const SYSTEM_PROMPT = `You are the phone receptionist for a nail salon called "${BUSINESS.name}".
This conversation WILL BE READ ALOUD to the caller, so follow these rules strictly:

VOICE RULES:
- Write ALL numbers as words (for example "thirty five dollars", never "$35").
- Do NOT use emojis, bullet points, asterisks, or special symbols.
- Keep replies short and natural, like a real person. Two to three sentences max per turn.
- Speak English by default. If the caller speaks Vietnamese, switch and reply in Vietnamese.

SALON INFO:
- Hours: ${BUSINESS.hours}
- Address: ${BUSINESS.address}
- Phone number: ${BUSINESS.phone}
- We have Vietnamese-speaking staff, accept crypto payments, and welcome walk-ins.

BUSINESS RULES:
- Do NOT quote specific prices. We do not have a price list loaded yet. If asked about price, say our staff will give exact pricing when they arrive, or offer to have a team member call them back.
- Do NOT confirm a booking as final. Collect the caller's name, the service they want, and their preferred day and time, then say the salon will call back to confirm the appointment.
- If the caller is upset, has a complaint, asks something you don't know, or wants a real person, say you will have a staff member call them back shortly. Do not try to handle it yourself.
- Never make up information and never promise anything the salon cannot control.`;

const fastify = Fastify();
await fastify.register(fastifyWs);

// Twilio gửi dữ liệu dạng form (application/x-www-form-urlencoded).
// Mình không cần đọc nội dung form cho webhook /twiml, nên chỉ cần
// bảo Fastify "chấp nhận" kiểu dữ liệu này thay vì từ chối (lỗi 415).
fastify.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (req, body, done) => done(null, body)
);

// 1) Endpoint TwiML — Twilio gọi vào đây khi có cuộc gọi đến
fastify.all('/twiml', async (req, reply) => {
  const host = process.env.PUBLIC_HOST || req.headers.host;
  const wsUrl = `wss://${host}/ws`;
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="${WELCOME}" />
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
