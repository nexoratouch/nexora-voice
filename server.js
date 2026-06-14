import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5'; // đổi 'claude-sonnet-4-6' nếu muốn khôn hơn

// ──────────────────────────────────────────────────────────────
// DATABASE (Railway PostgreSQL)
// ──────────────────────────────────────────────────────────────
const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('.railway.internal')
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

async function initDb() {
  if (!pool) {
    console.log('⚠️  CHƯA nối database (thiếu DATABASE_URL) — phiếu hỗ trợ sẽ KHÔNG được lưu.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      source TEXT,
      customer_phone TEXT,
      customer_name TEXT,
      service TEXT,
      preferred_time TEXT,
      notes TEXT,
      status TEXT DEFAULT 'new'
    )
  `);
  console.log('✅ Database sẵn sàng (bảng leads).');
}

async function saveTicket(t) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO leads (source, customer_phone, customer_name, service, preferred_time, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [t.source, t.phone || null, t.name || null, t.topic || null, t.salon || null, t.notes || null]
  );
}

// ──────────────────────────────────────────────────────────────
// NEXORA TOUCH — chỉnh nội dung sản phẩm ở đây
// ──────────────────────────────────────────────────────────────
const PRODUCT = {
  name: 'NEXORA TOUCH',
  // Mô tả ngắn để AI giới thiệu. Anh sửa cho đúng sản phẩm.
  about:
    'NEXORA TOUCH is a tipping, review, and loyalty platform for nail salons that supports both regular payments and crypto.',
  supportEmail: 'support@nexoratouch.com',
};

// Mật khẩu mở dashboard (đặt biến ADMIN_KEY trên Railway)
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

// Câu chào (đọc bằng giọng nữ tiếng Anh)
const WELCOME = `Thank you for calling NEXORA TOUCH support. For Vietnamese, press one. How can I help you today?`;

const SYSTEM_PROMPT = `You are a friendly female customer support agent for "${PRODUCT.name}".
${PRODUCT.about}
This conversation WILL BE READ ALOUD, so follow these rules strictly:

VOICE RULES:
- Write ALL numbers as words (for example "twenty four seven", not "24/7").
- No emojis, bullet points, asterisks, or special symbols.
- Keep replies short and natural, two to three sentences per turn.
- Speak English by default. If the caller speaks Vietnamese, reply in Vietnamese with a warm "anh/chị – em" tone.

WHAT YOU CAN DO:
- Explain at a high level what NEXORA TOUCH is and how it generally helps nail salons (tips, reviews, loyalty, crypto and regular payments).
- Answer only general questions you are confident about.

IMPORTANT SUPPORT RULES:
- For anything account-specific, billing, technical bugs, setup, or details you are not sure about, do NOT guess. Collect the caller's name, their salon name, and a short description of the issue, then tell them the NEXORA TOUCH support team will follow up shortly. (Their phone number is captured automatically.)
- If the caller is upset or urgent, reassure them and say a specialist will follow up soon.
- Never invent prices, policies, steps, or features. Never promise anything the team cannot control.`;

const EXTRACT_PROMPT = `You read a transcript of a support call to NEXORA TOUCH and extract a support ticket.
Return ONLY raw JSON, no markdown, in this exact shape:
{"is_ticket": true/false, "name": string or null, "salon": string or null, "topic": string or null, "notes": string or null}
Set is_ticket true if the caller raised any issue, request, or question that needs follow-up.
"topic" = a few words (e.g. "billing", "setup help", "crypto payout"). "notes" = one-line summary for the support team. Keep everything brief.`;

// ──────────────────────────────────────────────────────────────
const fastify = Fastify();
await fastify.register(fastifyWs);

fastify.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (req, body, done) => done(null, body)
);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 1) TwiML — giọng nữ tiếng Anh mặc định, có sẵn giọng nữ tiếng Việt khi bấm 1
fastify.all('/twiml', async (req, reply) => {
  const host = process.env.PUBLIC_HOST || req.headers.host;
  const wsUrl = `wss://${host}/ws`;
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="${WELCOME}" voice="Joanna-Generative" language="en-US">
      <Language code="vi-VN" ttsProvider="Google" voice="vi-VN-Wavenet-A" />
    </ConversationRelay>
  </Connect>
</Response>`
  );
});

// 2) WebSocket
fastify.register(async (f) => {
  f.get('/ws', { websocket: true }, (socket) => {
    const history = [];
    let callerPhone = null;
    let currentStream = null;

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'setup') {
        callerPhone = msg.from || null;
        console.log('Cuộc gọi mới từ:', callerPhone);
        return;
      }

      // Bấm phím 1 -> chuyển sang tiếng Việt (giọng nữ vi-VN)
      if (msg.type === 'dtmf' && msg.digit === '1') {
        try {
          socket.send(JSON.stringify({ type: 'language', ttsLanguage: 'vi-VN', transcriptionLanguage: 'vi-VN' }));
          socket.send(JSON.stringify({ type: 'text', token: 'Dạ, em xin chuyển sang tiếng Việt. Em có thể giúp gì cho mình ạ?', last: true }));
        } catch {}
        return;
      }

      if (msg.type === 'prompt') {
        const userText = msg.voicePrompt || '';
        if (!userText.trim()) return;
        history.push({ role: 'user', content: userText });
        try {
          let full = '';
          currentStream = anthropic.messages.stream({
            model: MODEL,
            max_tokens: 220,
            system: SYSTEM_PROMPT,
            messages: history,
          });
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
            token: 'Sorry, our system is a little busy. Please try again shortly.',
            last: true,
          }));
        }
      }

      if (msg.type === 'interrupt' && currentStream) {
        try { currentStream.abort(); } catch {}
      }
    });

    // Cúp máy -> rút phiếu hỗ trợ và lưu
    socket.on('close', async () => {
      console.log('Cuộc gọi kết thúc.');
      if (!pool || history.length === 0) return;
      try {
        const transcript = history.map((m) => `${m.role}: ${m.content}`).join('\n');
        const r = await anthropic.messages.create({
          model: MODEL, max_tokens: 300, system: EXTRACT_PROMPT,
          messages: [{ role: 'user', content: transcript }],
        });
        const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        const j = JSON.parse(text.replace(/```json|```/g, '').trim());
        if (j.is_ticket) {
          await saveTicket({ source: 'call', phone: callerPhone, name: j.name, salon: j.salon, topic: j.topic, notes: j.notes });
          console.log('✅ Đã lưu phiếu hỗ trợ:', j.topic || '(không rõ)');
        }
      } catch (err) {
        console.error('Không rút được phiếu:', err.message);
      }
    });
  });
});

// 3) TRANG GỬI YÊU CẦU HỖ TRỢ (public)
fastify.get('/contact', async (req, reply) => {
  reply.type('text/html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Support · ${esc(PRODUCT.name)}</title>
<style>
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{width:100%;max-width:440px;background:#191430;border-radius:20px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .logo{font-weight:800;font-size:22px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;text-align:center}
  .sub{text-align:center;color:#9ca3af;font-size:13px;margin:4px 0 22px}
  label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
  input,textarea{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2d2750;background:#120e26;color:#fff;font-size:15px}
  button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(90deg,#a855f7,#ec4899)}
</style></head><body>
<form class="card" method="POST" action="/contact">
  <div class="logo">${esc(PRODUCT.name)} Support</div>
  <div class="sub">Send us a message — our team will follow up</div>
  <label>Your name</label><input name="name" required>
  <label>Salon name</label><input name="salon">
  <label>Phone number</label><input name="phone" type="tel" required>
  <label>How can we help?</label><textarea name="notes" rows="3" required></textarea>
  <button type="submit">Submit Request</button>
</form></body></html>`);
});

fastify.post('/contact', async (req, reply) => {
  const p = new URLSearchParams(req.body || '');
  await saveTicket({ source: 'web', phone: p.get('phone'), name: p.get('name'), salon: p.get('salon'), topic: 'web form', notes: p.get('notes') });
  reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Thank you</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}
.box{max-width:420px}.t{font-size:24px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}a{color:#22d3ee}</style></head><body><div class="box">
<div class="t">Thank you! 💜</div><p>We received your request. The NEXORA TOUCH team will follow up shortly.</p>
<p><a href="/contact">Send another</a></p></div></body></html>`);
});

// 4) DASHBOARD phiếu hỗ trợ (cần mật khẩu ?key=)
fastify.get('/leads', async (req, reply) => {
  const key = req.query.key || '';
  if (key !== ADMIN_KEY) {
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Đăng nhập</title>
<style>body{margin:0;font-family:sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center}
form{background:#191430;padding:28px;border-radius:18px;width:300px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #2d2750;background:#120e26;color:#fff;margin-top:10px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer}</style>
</head><body><form method="GET" action="/leads"><b>NEXORA TOUCH · Support</b><input name="key" type="password" placeholder="Mật khẩu" autofocus><button>Mở</button></form></body></html>`);
    return;
  }
  let rows = [];
  if (pool) rows = (await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500')).rows;
  const items = rows.map((l) => `
    <div class="lead ${l.status === 'done' ? 'done' : ''}">
      <div class="top"><span class="src ${l.source}">${l.source === 'call' ? '📞 Gọi' : '🌐 Web'}</span><span class="time">${new Date(l.created_at).toLocaleString('vi-VN')}</span></div>
      <div class="name">${esc(l.customer_name) || '(không tên)'} ${l.customer_phone ? `· <a href="tel:${esc(l.customer_phone)}">${esc(l.customer_phone)}</a>` : ''}</div>
      <div class="svc">${esc(l.service) || '—'}${l.preferred_time ? ' · Tiệm: ' + esc(l.preferred_time) : ''}</div>
      ${l.notes ? `<div class="notes">${esc(l.notes)}</div>` : ''}
      ${l.status !== 'done' ? `<form method="POST" action="/leads/done"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${l.id}"><button>✓ Đã xử lý</button></form>` : '<span class="badge">Đã xử lý</span>'}
    </div>`).join('');
  reply.type('text/html').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>NEXORA TOUCH · Support</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;padding:16px}
h1{font-size:20px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{background:#191430;border-radius:14px;padding:14px;margin-bottom:12px;border:1px solid #2d2750}.lead.done{opacity:.5}
.top{display:flex;justify-content:space-between;font-size:12px;color:#9ca3af;margin-bottom:6px}.src.call{color:#22d3ee}.src.web{color:#ec4899}
.name{font-weight:700;font-size:16px}.name a{color:#22d3ee;text-decoration:none}.svc{color:#cbd5e1;font-size:14px;margin-top:2px}.notes{color:#94a3b8;font-size:13px;margin-top:6px;font-style:italic}
button{margin-top:10px;padding:9px 14px;border:0;border-radius:9px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer}
.badge{display:inline-block;margin-top:10px;font-size:12px;color:#34d399}.empty{color:#9ca3af;text-align:center;margin-top:40px}</style></head><body>
<h1>NEXORA TOUCH · Phiếu hỗ trợ (${rows.length})</h1>
${items || '<div class="empty">Chưa có phiếu nào. Khi khách gọi hoặc gửi qua trang /contact, phiếu sẽ hiện ở đây.</div>'}
</body></html>`);
});

fastify.post('/leads/done', async (req, reply) => {
  const p = new URLSearchParams(req.body || '');
  if (p.get('key') !== ADMIN_KEY) { reply.code(403).send('Forbidden'); return; }
  if (pool) await pool.query(`UPDATE leads SET status='done' WHERE id=$1`, [p.get('id')]);
  reply.redirect(`/leads?key=${encodeURIComponent(ADMIN_KEY)}`);
});

// ──────────────────────────────────────────────────────────────
await initDb();
const port = process.env.PORT || 8080;
fastify.listen({ port, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`NEXORA TOUCH support agent đang chạy tại ${addr}`);
});
