import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import twilio from 'twilio';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

// ── Twilio ──────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_PHONE || '+18327865576';
const OWNER_PHONE = process.env.OWNER_PHONE || null; // số anh nhận thông báo

// ── Database ─────────────────────────────────────────────────
const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('.railway.internal')
        ? false : { rejectUnauthorized: false },
    })
  : null;

async function initDb() {
  if (!pool) { console.log('⚠️  Chưa nối database.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS callers (
      phone TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT now(),
      visit_count INT DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      source TEXT, location_key TEXT,
      customer_phone TEXT, customer_name TEXT,
      service TEXT, preferred_time TEXT,
      notes TEXT, status TEXT DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      location_key TEXT, caller_phone TEXT,
      duration_seconds INT DEFAULT 0,
      outcome TEXT DEFAULT 'unknown',
      is_new_caller BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS sms_threads (
      phone TEXT PRIMARY KEY,
      history JSONB DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✅ Database sẵn sàng.');
}

// ── DB helpers ───────────────────────────────────────────────
async function checkAndLogCaller(phone) {
  if (!pool || !phone) return true;
  const r = await pool.query(
    `INSERT INTO callers (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET visit_count = callers.visit_count + 1
     RETURNING visit_count`,
    [phone]
  );
  return r.rows[0].visit_count === 1;
}

async function saveLead(l) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO leads (source, location_key, customer_phone, customer_name, service, preferred_time, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [l.source, l.locKey||null, l.phone||null, l.name||null,
     l.service||null, l.time||null, l.notes||null]
  );
}

async function saveCall(c) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO calls (location_key, caller_phone, duration_seconds, outcome, is_new_caller)
     VALUES ($1,$2,$3,$4,$5)`,
    [c.locKey||null, c.phone||null, c.duration||0, c.outcome||'unknown', c.isNew||false]
  );
}

async function getAnalytics() {
  if (!pool) return null;
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > now()-interval '1 day')   AS calls_today,
      COUNT(*) FILTER (WHERE created_at > now()-interval '7 days')  AS calls_week,
      COUNT(*) FILTER (WHERE outcome='booking' AND created_at > now()-interval '7 days') AS bookings_week,
      COUNT(*) FILTER (WHERE is_new_caller AND created_at > now()-interval '7 days')     AS new_callers_week
    FROM calls
  `);
  return r.rows[0];
}

async function getSmsHistory(phone) {
  if (!pool) return [];
  const r = await pool.query(`SELECT history FROM sms_threads WHERE phone=$1`, [phone]);
  return r.rows[0]?.history || [];
}

async function saveSmsHistory(phone, history) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO sms_threads (phone, history, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (phone) DO UPDATE SET history=$2, updated_at=now()`,
    [phone, JSON.stringify(history)]
  );
}

// ── SMS helpers ──────────────────────────────────────────────
async function sendSms(to, body) {
  if (!twilioClient || !to) return;
  try {
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body });
    console.log(`📱 SMS → ${to}`);
  } catch (e) { console.error('SMS error:', e.message); }
}

const GOOGLE_REVIEW_LINK = process.env.GOOGLE_REVIEW_LINK
  || 'https://g.page/r/YOUR_PLACE_ID/review';

// ── MULTI-TENANT LOCATIONS ───────────────────────────────────
// Thêm tiệm mới: copy 1 block, đổi key = số Twilio của tiệm đó
const LOCATIONS = {
  '+18327865576': {
    name: 'Bitcoin Nail Bar', label: 'Location 1',
    hours: 'Monday through Saturday, nine thirty A M to seven P M. Closed on Sunday.',
    address: 'nine seven nine three Westheimer Road, Suite A, Houston, Texas, seven seven zero four two',
    phone: 'three four six, eight zero two, four nine zero six',
  },
  '+1XXXXXXXXXX': {        // ⚠️ thay bằng số Twilio tiệm 2 vừa mua
    name: 'Bitcoin Nail Bar', label: 'Location 2',
    hours: 'Monday through Saturday, nine thirty A M to seven P M. Closed on Sunday.',
    address: 'nine seven nine three Westheimer Road, Suite A, Houston, Texas, seven seven zero four two',
    phone: 'three four six, eight zero two, four nine zero six',
  },
};
const DEFAULT_LOCATION = Object.values(LOCATIONS)[0];
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const SERVICES = ['Gel Manicure', 'Dipping Powder', 'Pedicure', 'Full Set Acrylic', 'Nail Art', 'Other'];

// ── Prompts ──────────────────────────────────────────────────
function getWelcome(loc) {
  return `Thank you for calling ${loc.name}. How can I help you today?`;
}

function getVoicePrompt(loc) {
  return `You are a friendly female receptionist for a nail salon called "${loc.name}" (${loc.label}).
This conversation WILL BE READ ALOUD, so follow these rules:

VOICE RULES:
- Write ALL numbers as words ("thirty five dollars", never "$35").
- No emojis, bullet points, asterisks, or special symbols.
- Two to three short natural sentences per turn. Speak English only.

SALON INFO:
- Hours: ${loc.hours}
- Address: ${loc.address}
- Phone: ${loc.phone}
- Vietnamese-speaking staff, crypto payments accepted, walk-ins welcome.
- Closed on Sundays so the team can rest and attend church.

OFFERINGS (do NOT state specific prices — say staff will share details):
- Membership plan with perks for regular guests.
- Custom Gift Cards in flexible amounts.
- Prepaid Card — load money in advance toward any service.
- Crypto Card — pay or load value using cryptocurrency.

RULES:
- No specific service prices. Say staff will confirm pricing in person.
- For appointments: collect name, service, preferred day and time — say team will call to confirm.
- Caller's phone is captured automatically, no need to ask.
- If caller is upset or wants a real person: say a staff member will call back shortly.
- Never make up information or make promises the salon cannot keep.`;
}

function getSmsPrompt(loc) {
  return `You are a friendly SMS receptionist for ${loc.name} (${loc.label}).
Reply via text message — be concise, warm, under 2 sentences.
Use English only.

SALON INFO:
- Hours: ${loc.hours}
- Address: ${loc.address}
- Phone: ${loc.phone}
- Vietnamese-speaking staff, crypto payments, walk-ins welcome.
- Closed Sundays (team attends church).

OFFERINGS (no specific prices — say staff will confirm):
Membership, Custom Gift Cards, Prepaid Card, Crypto Card.

RULES:
- For bookings: collect name, service, day/time — say team will call to confirm.
- Unknown questions: say a team member will follow up shortly.
- Never invent prices, policies, or promises.`;
}

const EXTRACT_PROMPT = `Read a nail salon call transcript and extract an appointment lead.
Return ONLY raw JSON:
{"is_booking":true/false,"name":string|null,"service":string|null,"preferred_time":string|null,"notes":string|null}
is_booking=true only if caller wanted to schedule. notes=one-line summary for staff.`;

// ── Fastify ──────────────────────────────────────────────────
const fastify = Fastify();
await fastify.register(fastifyWs);
fastify.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (req, body, done) => done(null, body)
);

function parseForm(raw) {
  const p = new URLSearchParams(typeof raw === 'string' ? raw : '');
  return Object.fromEntries(p.entries());
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function locFromNumber(to) {
  if (!to) return { loc: DEFAULT_LOCATION, key: null };
  const key = to.startsWith('+') ? to : `+${to}`;
  return { loc: LOCATIONS[key] || DEFAULT_LOCATION, key };
}

// ── 1) TwiML — inbound voice ─────────────────────────────────
fastify.all('/twiml', async (req, reply) => {
  const body = parseForm(req.body);
  const { loc, key } = locFromNumber(body.To);
  const locParam = encodeURIComponent(key || 'default');
  const host = process.env.PUBLIC_HOST || req.headers.host;
  const wsUrl = `wss://${host}/ws?loc=${locParam}`;
  console.log(`📞 Gọi tới ${key || '?'} → ${loc.label}`);
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}"
      welcomeGreeting="${getWelcome(loc)}"
      voice="Joanna-Generative"
      language="en-US"
      record="true" />
  </Connect>
</Response>`
  );
});

// ── 2) WebSocket — voice conversation ────────────────────────
fastify.register(async (f) => {
  f.get('/ws', { websocket: true }, (socket, req) => {
    const locKey = decodeURIComponent(req.query?.loc || 'default');
    const loc = LOCATIONS[locKey] || DEFAULT_LOCATION;
    const SYSTEM_PROMPT = getVoicePrompt(loc);
    const history = [];
    let callerPhone = null;
    let isNew = false;
    let currentStream = null;
    const startTime = Date.now();

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── Setup (call starts) ──
      if (msg.type === 'setup') {
        callerPhone = msg.from || null;
        isNew = await checkAndLogCaller(callerPhone);
        console.log(`${callerPhone} | ${loc.label} | ${isNew ? '🆕 NEW' : '🔁 RETURNING'}`);
        if (isNew && callerPhone) {
          await sendSms(callerPhone,
            `💅 Thanks for calling ${loc.name}! First-time guests get 10% off any service. Show this text at checkout. Book: bitcoinnailbar.com`
          );
        }
        return;
      }

      // ── Caller speaks ──
      if (msg.type === 'prompt') {
        const text = msg.voicePrompt || '';
        if (!text.trim()) return;
        history.push({ role: 'user', content: text });
        try {
          let full = '';
          currentStream = anthropic.messages.stream({
            model: MODEL, max_tokens: 220,
            system: SYSTEM_PROMPT, messages: history,
          });
          currentStream.on('text', (delta) => {
            full += delta;
            socket.send(JSON.stringify({ type: 'text', token: delta, last: false }));
          });
          await currentStream.finalMessage();
          socket.send(JSON.stringify({ type: 'text', token: '', last: true }));
          history.push({ role: 'assistant', content: full });
        } catch (err) {
          console.error('Claude error:', err?.message || err);
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

    // ── Call ends ────────────────────────────────────────────
    socket.on('close', async () => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`📵 Cuộc gọi kết thúc | ${duration}s | ${loc.label}`);

      // Missed call: dưới 15 giây, chưa nói chuyện được gì
      if (duration < 15 && callerPhone) {
        await sendSms(callerPhone,
          `Hi! Sorry we missed your call at ${loc.name}. How can we help? Reply here or call us back at ${loc.phone.replace(/[a-z ,]+/gi, '').trim()}.`
        );
        await saveCall({ locKey, phone: callerPhone, duration, outcome: 'missed', isNew });
        return;
      }

      // Gửi SMS xin Google review
      if (callerPhone) {
        await sendSms(callerPhone,
          `Thanks for calling ${loc.name}! 💜 We'd love your feedback: ${GOOGLE_REVIEW_LINK}`
        );
      }

      // Rút lead từ transcript
      let outcome = 'inquiry';
      if (pool && history.length > 0) {
        try {
          const transcript = history.map(m => `${m.role}: ${m.content}`).join('\n');
          const r = await anthropic.messages.create({
            model: MODEL, max_tokens: 300,
            system: EXTRACT_PROMPT,
            messages: [{ role: 'user', content: transcript }],
          });
          const text = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
          const j = JSON.parse(text.replace(/```json|```/g,'').trim());
          if (j.is_booking) {
            outcome = 'booking';
            await saveLead({ source: 'call', locKey, phone: callerPhone,
              name: j.name, service: j.service, time: j.preferred_time, notes: j.notes });

            // SMS thông báo cho chủ tiệm
            if (OWNER_PHONE) {
              await sendSms(OWNER_PHONE,
                `📅 NEW BOOKING | ${loc.label}\nName: ${j.name||'?'}\nService: ${j.service||'?'}\nTime: ${j.preferred_time||'?'}\nPhone: ${callerPhone||'?'}`
              );
            }
            console.log(`✅ Booking lưu: ${j.name||'?'} — ${j.service||'?'}`);
          }
        } catch (err) { console.error('Extract error:', err.message); }
      }

      await saveCall({ locKey, phone: callerPhone, duration, outcome, isNew });
    });
  });
});

// ── 3) Two-way SMS — khách nhắn tin, Claude trả lời ─────────
fastify.post('/sms', async (req, reply) => {
  const body = parseForm(req.body);
  const from = body.From || '';
  const toNum = body.To || '';
  const inbound = (body.Body || '').trim();
  const { loc, key: locKey } = locFromNumber(toNum);

  let replyText = `Thanks for reaching out to ${loc.name}! Our team will get back to you shortly.`;

  if (inbound && from) {
    try {
      const history = await getSmsHistory(from);
      history.push({ role: 'user', content: inbound });
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 200,
        system: getSmsPrompt(loc),
        messages: history.slice(-10), // giữ 10 tin gần nhất
      });
      replyText = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim()
        || replyText;
      history.push({ role: 'assistant', content: replyText });
      await saveSmsHistory(from, history.slice(-20));
    } catch (err) { console.error('SMS Claude error:', err.message); }
  }

  // TwiML reply
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<MessagingResponse>
  <Message>${esc(replyText)}</Message>
</MessagingResponse>`
  );
});

// ── 4) Trang đặt lịch /book ──────────────────────────────────
fastify.get('/book', async (req, reply) => {
  const opts = SERVICES.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  reply.type('text/html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book · Bitcoin Nail Bar</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:440px;background:#191430;border-radius:20px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.logo{font-weight:800;font-size:22px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;text-align:center}
.sub{text-align:center;color:#9ca3af;font-size:13px;margin:4px 0 22px}
label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
input,select,textarea{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2d2750;background:#120e26;color:#fff;font-size:15px}
button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(90deg,#a855f7,#ec4899)}</style></head><body>
<form class="card" method="POST" action="/book">
<div class="logo">Bitcoin Nail Bar</div>
<div class="sub">Book your appointment — we'll call to confirm 💅</div>
<label>Your name</label><input name="name" required>
<label>Phone number</label><input name="phone" type="tel" required>
<label>Service</label><select name="service">${opts}</select>
<label>Preferred day & time</label><input name="time" placeholder="e.g. Saturday 2pm">
<label>Notes (optional)</label><textarea name="notes" rows="2"></textarea>
<button type="submit">Request Appointment</button>
</form></body></html>`);
});

fastify.post('/book', async (req, reply) => {
  const p = parseForm(req.body);
  await saveLead({ source: 'web', phone: p.phone, name: p.name,
    service: p.service, time: p.time, notes: p.notes });
  if (p.phone) {
    await sendSms(p.phone,
      `Hi ${p.name||'there'}! We got your request at Bitcoin Nail Bar. Our team will call to confirm. 💅`
    );
  }
  if (OWNER_PHONE) {
    await sendSms(OWNER_PHONE,
      `📅 WEB BOOKING\nName: ${p.name||'?'}\nService: ${p.service||'?'}\nTime: ${p.time||'?'}\nPhone: ${p.phone||'?'}`
    );
  }
  reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}
.t{font-size:24px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}a{color:#22d3ee}</style></head><body><div>
<div class="t">Thank you! 💜</div><p>We sent you a text confirmation. Our team will call shortly.</p>
<p><a href="/book">Book another</a></p></div></body></html>`);
});

// ── 5) Dashboard /leads + analytics ─────────────────────────
fastify.get('/leads', async (req, reply) => {
  const key = req.query.key || '';
  if (key !== ADMIN_KEY) {
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Login</title>
<style>body{margin:0;font-family:sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center}
form{background:#191430;padding:28px;border-radius:18px;width:300px;text-align:center}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #2d2750;background:#120e26;color:#fff;margin-top:10px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer}</style>
</head><body><form method="GET" action="/leads">
<b style="font-size:16px">Bitcoin Nail Bar · Dashboard</b>
<input name="key" type="password" placeholder="Password" autofocus>
<button>Open</button></form></body></html>`);
    return;
  }

  let leads = [], stats = null;
  if (pool) {
    leads = (await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500')).rows;
    stats = await getAnalytics();
  }

  const bookingUrl = `https://${process.env.PUBLIC_HOST || 'nexora-voice-production.up.railway.app'}/book`;

  const statCards = stats ? `
    <div class="stats">
      <div class="stat"><b>${stats.calls_today||0}</b>Calls today</div>
      <div class="stat"><b>${stats.calls_week||0}</b>Calls this week</div>
      <div class="stat"><b>${stats.bookings_week||0}</b>Bookings this week</div>
      <div class="stat"><b>${stats.new_callers_week||0}</b>New callers this week</div>
      <div class="stat"><b>${stats.calls_week>0?Math.round((stats.bookings_week/stats.calls_week)*100):0}%</b>Booking rate</div>
    </div>` : '';

  const items = leads.map(l => `
    <div class="lead ${l.status==='done'?'done':''}">
      <div class="top">
        <span class="src ${l.source}">${l.source==='call'?'📞 Call':'🌐 Web'}</span>
        <span class="loc">${esc(l.location_key||'—')}</span>
        <span class="time">${new Date(l.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div class="name">${esc(l.customer_name)||'(no name)'}${l.customer_phone?` · <a href="tel:${esc(l.customer_phone)}">${esc(l.customer_phone)}</a>`:''}</div>
      <div class="svc">${esc(l.service)||'—'}${l.preferred_time?' · '+esc(l.preferred_time):''}</div>
      ${l.notes?`<div class="notes">${esc(l.notes)}</div>`:''}
      ${l.status!=='done'
        ?`<form method="POST" action="/leads/done"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${l.id}"><button>✓ Called back</button></form>`
        :'<span class="badge">✓ Done</span>'}
    </div>`).join('');

  reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Bitcoin Nail Bar · Dashboard</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;padding:16px;max-width:600px;margin:0 auto}
h1{font-size:20px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:4px}
.book-link{font-size:12px;color:#22d3ee;text-decoration:none;display:block;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px;margin-bottom:20px}
.stat{background:#191430;border-radius:12px;padding:12px;text-align:center;font-size:11px;color:#64748b;border:1px solid #1e1a3a}
.stat b{display:block;font-size:22px;color:#fff;margin-bottom:2px}
.lead{background:#191430;border-radius:14px;padding:14px;margin-bottom:12px;border:1px solid #1e1a3a}.lead.done{opacity:.5}
.top{display:flex;gap:8px;align-items:center;font-size:11px;color:#64748b;margin-bottom:6px;flex-wrap:wrap}
.src.call{color:#22d3ee}.src.web{color:#ec4899}.loc{color:#a855f7;font-weight:600}
.name{font-weight:700;font-size:15px}.name a{color:#22d3ee;text-decoration:none}
.svc{color:#cbd5e1;font-size:13px;margin-top:3px}.notes{color:#94a3b8;font-size:12px;margin-top:6px;font-style:italic}
button{margin-top:10px;padding:9px 14px;border:0;border-radius:9px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer;font-size:13px}
.badge{display:inline-block;margin-top:8px;font-size:12px;color:#34d399}
.empty{color:#64748b;text-align:center;margin-top:40px;font-size:14px}</style></head><body>
<h1>Bitcoin Nail Bar · Dashboard</h1>
<a class="book-link" href="${esc(bookingUrl)}" target="_blank">🔗 Booking page: ${esc(bookingUrl)}</a>
${statCards}
${items||'<div class="empty">No leads yet.<br>Calls and web bookings will appear here.</div>'}
</body></html>`);
});

fastify.post('/leads/done', async (req, reply) => {
  const p = parseForm(req.body);
  if (p.key !== ADMIN_KEY) { reply.code(403).send('Forbidden'); return; }
  if (pool) await pool.query(`UPDATE leads SET status='done' WHERE id=$1`, [p.id]);
  reply.redirect(`/leads?key=${encodeURIComponent(ADMIN_KEY)}`);
});

// ── Start ────────────────────────────────────────────────────
await initDb();
const port = process.env.PORT || 8080;
fastify.listen({ port, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`✅ Bitcoin Nail Bar AI chạy tại ${addr}`);
  console.log(`📊 Dashboard: ${addr}/leads`);
  console.log(`📅 Booking:   ${addr}/book`);
  console.log(`💬 SMS:       ${addr}/sms`);
});
