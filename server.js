import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import twilio from 'twilio';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

// ── Twilio ────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const OWNER_PHONE = process.env.OWNER_PHONE || null;
const GOOGLE_REVIEW_LINK = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_PLACE_ID/review';
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

// ── Database ──────────────────────────────────────────────────
const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('.railway.internal')
        ? false : { rejectUnauthorized: false },
    })
  : null;

async function initDb() {
  if (!pool) { console.log('⚠️  No database.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS callers (
      phone TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT now(),
      visit_count INT DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      source TEXT, business_key TEXT,
      customer_phone TEXT, customer_name TEXT,
      service TEXT, preferred_time TEXT,
      notes TEXT, status TEXT DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      business_key TEXT, caller_phone TEXT,
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
  console.log('✅ Database ready.');
}

async function checkAndLogCaller(phone) {
  if (!pool || !phone) return true;
  const r = await pool.query(
    `INSERT INTO callers (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET visit_count = callers.visit_count + 1
     RETURNING visit_count`, [phone]
  );
  return r.rows[0].visit_count === 1;
}

async function saveLead(l) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO leads (source, business_key, customer_phone, customer_name, service, preferred_time, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [l.source, l.bizKey||null, l.phone||null, l.name||null,
     l.service||null, l.time||null, l.notes||null]
  );
}

async function saveCall(c) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO calls (business_key, caller_phone, duration_seconds, outcome, is_new_caller)
     VALUES ($1,$2,$3,$4,$5)`,
    [c.bizKey||null, c.phone||null, c.duration||0, c.outcome||'unknown', c.isNew||false]
  );
}

async function getAnalytics(bizKey) {
  if (!pool) return null;
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > now()-interval '1 day')  AS calls_today,
      COUNT(*) FILTER (WHERE created_at > now()-interval '7 days') AS calls_week,
      COUNT(*) FILTER (WHERE outcome='booking' AND created_at > now()-interval '7 days') AS bookings_week,
      COUNT(*) FILTER (WHERE is_new_caller AND created_at > now()-interval '7 days')     AS new_week
    FROM calls WHERE business_key=$1`, [bizKey]
  );
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

async function sendSms(to, body, from) {
  if (!twilioClient || !to) return;
  try {
    await twilioClient.messages.create({ from: from || '+18327865576', to, body });
    console.log(`📱 SMS → ${to}`);
  } catch (e) { console.error('SMS error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
// BUSINESSES — mỗi số Twilio là 1 doanh nghiệp riêng
// Thêm doanh nghiệp mới: copy 1 block, đổi key = số Twilio
// ══════════════════════════════════════════════════════════════
const BUSINESSES = {

  // ── 1) NEXORA TOUCH — Tổng đài hỗ trợ sản phẩm ─────────────
  '+18327865576': {
    key: 'bitcoin-nail-bar',
    name: 'Bitcoin Nail Bar',
    type: 'salon',
    twilioFrom: '+18327865576',
    voice: 'Joanna-Generative',
    welcome: 'Thank you for calling Bitcoin Nail Bar. How can I help you today?',
    systemPrompt: `You are a friendly female receptionist for Bitcoin Nail Bar, a luxury nail salon in Houston, Texas.
This conversation WILL BE READ ALOUD. Follow these rules:

VOICE RULES:
- Write ALL numbers as words ("thirty five dollars", never "$35"). No emojis, bullets, or special symbols.
- Two to three short natural sentences per turn. English only.

SALON INFO:
- Hours: Monday through Saturday, nine thirty A M to seven P M. Closed on Sundays.
- Address: nine seven nine three Westheimer Road, Suite A, Houston, Texas, seven seven zero four two.
- Phone: three four six, eight zero two, four nine zero six.
- Website: bitcoin nail bar dot com.
- Vietnamese-speaking staff available. Crypto payments accepted. Walk-ins welcome.
- Closed Sundays so the team can rest and attend church.

OFFERINGS (do NOT state specific prices — say staff will confirm):
- Membership plan with perks for regular guests.
- Custom Gift Cards in flexible amounts — great for gifts.
- Prepaid Card — load money in advance toward any service.
- Crypto Card — pay or load value using cryptocurrency.

RULES:
- No specific service prices. Say staff will confirm pricing in person.
- For appointments: collect name, service, preferred day and time — say team will call to confirm. Phone is captured automatically.
- If caller is upset or wants a real person: say a staff member will call back shortly.
- Never make up information or make promises the salon cannot keep.`,
    smsPrompt: `You are a friendly SMS receptionist for Bitcoin Nail Bar at 9793 Westheimer Rd Suite A, Houston TX. Hours: Mon-Sat 9:30am-7pm, closed Sunday. Crypto payments, Vietnamese staff, walk-ins welcome. Reply in 1-2 sentences. For appointments: collect name, service, day/time and say team will call to confirm.`,
    extractPrompt: `Read a nail salon call transcript. Return ONLY raw JSON:
{"is_booking":true/false,"name":string|null,"service":string|null,"preferred_time":string|null,"notes":string|null}
is_booking=true only if caller wanted to schedule an appointment.`,
    promoSms: `💅 Thanks for calling Bitcoin Nail Bar! First-time guests get 10% off. Show this text at checkout. Book: bitcoinnailbar.com`,
    reviewSms: `Thanks for calling Bitcoin Nail Bar! 💜 Please leave us a Google review: ${GOOGLE_REVIEW_LINK}`,
    ownerNotifySms: (l) => `📅 NEW BOOKING — Bitcoin Nail Bar\nName: ${l.name||'?'}\nService: ${l.service||'?'}\nTime: ${l.time||'?'}\nPhone: ${l.phone||'?'}`,
    services: ['Gel Manicure', 'Dipping Powder', 'Pedicure', 'Full Set Acrylic', 'Nail Art', 'Other']
  },

  // ── 2) BITCOIN NAIL BAR — Lễ tân tiệm nail ──────────────────
  '+18327995559': {
    key: 'nexora-touch',
    name: 'NEXORA TOUCH',
    type: 'support',
    twilioFrom: '+18327995559',
    voice: 'Joanna-Generative',
    welcome: 'Thank you for calling NEXORA TOUCH. This is your virtual support agent. How can I help you today?',
    systemPrompt: `You are a friendly female support agent for NEXORA TOUCH — a digital tipping, review, and loyalty platform built for nail salons, powered by VLINKPAY and AI.
This conversation WILL BE READ ALOUD. Follow these rules:

VOICE RULES:
- Write ALL numbers as words. No emojis, bullets, or special symbols.
- Two to three short natural sentences per turn. English only.

WHAT NEXORA TOUCH DOES:
- Helps nail salons collect tips digitally via QR code — no cash needed.
- Automates Google and Yelp review requests after each visit.
- Runs a loyalty program: customers earn points and redeem rewards.
- Supports both regular card payments and cryptocurrency.
- Gives salon owners a real-time dashboard to track tips, reviews, and loyalty activity.
- Integrates with VLINKPAY for payments and gift card campaigns.
- Part of the VLINKGROUP ecosystem alongside VLINKPAY and NailHub AI.

WHAT YOU CAN HELP WITH:
- Explaining what NEXORA TOUCH is and how it benefits nail salons.
- General feature questions about tips, reviews, loyalty, QR code, crypto, and the dashboard.
- Helping callers get started or request a live demo.

SUPPORT RULES:
- For account issues, billing, bugs, or setup help: collect caller's name and salon name — say a specialist will follow up shortly.
- For demo requests: take their name, salon name, and phone — say the team will reach out to schedule.
- Never invent specific pricing, contract terms, or technical specs. Say a specialist will provide details.
- Caller's phone is captured automatically.`,
    smsPrompt: `You are a friendly SMS support agent for NEXORA TOUCH — a digital tip, review, and loyalty platform for nail salons, part of VLINKGROUP. Reply in 1-2 sentences. English only. For account or technical issues, collect name and salon name and say a specialist will follow up.`,
    extractPrompt: `Read a NEXORA TOUCH support call. Return ONLY raw JSON:
{"is_ticket":true/false,"name":string|null,"salon":string|null,"topic":string|null,"notes":string|null}
is_ticket=true if caller raised any issue or request needing follow-up.`,
    promoSms: null,
    reviewSms: null,
    ownerNotifySms: (l) => `📋 NEXORA TOUCH TICKET\nName: ${l.name||'?'}\nSalon: ${l.salon||'?'}\nTopic: ${l.topic||'?'}\nPhone: ${l.phone||'?'}`,
    services: [],
  },

  // ── 3) VLINKPAY — Payments infrastructure ───────────────────
  '+18322349979': {
    key: 'vlinkpay',
    name: 'VLINKPAY',
    type: 'fintech',
    twilioFrom: '+18322349979',
    voice: 'Joanna-Generative',
    welcome: 'Thank you for calling VLINKPAY Gift Card Center. How can I help you today?',
    systemPrompt: `You are a friendly and knowledgeable female support agent for VLINKPAY — a comprehensive payment super app that integrates e-gift cards, e-vouchers, cashback programs, and crypto payments, powered by AI and blockchain technology.
This conversation WILL BE READ ALOUD. Follow these rules:

VOICE RULES:
- Write ALL numbers as words. No emojis, bullets, or special symbols.
- Two to three short natural sentences per turn. English only.

ABOUT VLINKPAY:
VLINKPAY is a super app available on the App Store, Google Play, and at v l i n k p a y dot com. It serves both individual customers and business owners.

FOR CUSTOMERS, VLINKPAY offers:
- Purchasing e-gift cards and e-vouchers from partner businesses instantly.
- Cashback programs — earn money back on purchases.
- A digital wallet to manage gift cards, vouchers, and rewards all in one place.
- Crypto payment options for supported merchants.

FOR BUSINESSES (the Gift Card Center), VLINKPAY offers:
- Create and customize your own branded e-gift card and voucher campaigns.
- Launch promotions and track performance through real-time analytics.
- Accept gift card payments from customers in-store or online.
- Grow customer loyalty with cashback and rewards programs built into the platform.
- Manage business accounts, multiple currencies, and integrate with existing payment methods.

HOW TO GET STARTED:
- Customers: download the app from the App Store or Google Play, or visit v l i n k p a y dot com and register.
- Businesses: visit v l i n k p a y dot com to apply as a merchant partner.

SUPPORT RULES:
- For account login, password issues, or payment problems: collect caller's name and say a specialist will follow up.
- For businesses wanting to create a gift card campaign: take their name, business name, and phone — say a team member will reach out to walk them through setup.
- Never invent specific pricing, fees, or contract terms. Say a specialist will provide exact details.
- Caller's phone is captured automatically.`,
    smsPrompt: `You are a friendly SMS support agent for VLINKPAY — a super app for e-gift cards, e-vouchers, cashback, and crypto payments. Available at vlinkpay.com and on App Store/Google Play. Reply in 1-2 sentences. For account issues or business inquiries, collect name and say a specialist will follow up.`,
    extractPrompt: `Read a VLINKPAY support call. Return ONLY raw JSON:
{"is_ticket":true/false,"name":string|null,"company":string|null,"topic":string|null,"notes":string|null}
is_ticket=true if caller had an issue or request needing follow-up.`,
    promoSms: null,
    reviewSms: null,
    ownerNotifySms: (l) => `💳 VLINKPAY INQUIRY\nName: ${l.name||'?'}\nCompany: ${l.company||'?'}\nTopic: ${l.topic||'?'}\nPhone: ${l.phone||'?'}`,
    services: [],
  },

};

const DEFAULT_BIZ = Object.values(BUSINESSES)[0];

function getBiz(toNumber) {
  if (!toNumber) return { biz: DEFAULT_BIZ, key: null };
  const num = toNumber.startsWith('+') ? toNumber : `+${toNumber}`;
  const biz = BUSINESSES[num] || DEFAULT_BIZ;
  return { biz, key: biz.key };
}

// ── Fastify ───────────────────────────────────────────────────
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
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── TwiML ─────────────────────────────────────────────────────
fastify.all('/twiml', async (req, reply) => {
  const body = parseForm(req.body);
  const { biz, key } = getBiz(body.To);
  const bizParam = encodeURIComponent(biz.twilioFrom);
  const host = process.env.PUBLIC_HOST || req.headers.host;
  const wsUrl = `wss://${host}/ws?biz=${bizParam}`;
  console.log(`📞 ${body.From||'?'} → ${biz.name}`);
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}"
      welcomeGreeting="${biz.welcome}"
      voice="${biz.voice}"
      language="en-US"
      record="true" />
  </Connect>
</Response>`
  );
});

// ── WebSocket ─────────────────────────────────────────────────
fastify.register(async (f) => {
  f.get('/ws', { websocket: true }, (socket, req) => {
    const bizNum = decodeURIComponent(req.query?.biz || '');
    const biz = BUSINESSES[bizNum] || DEFAULT_BIZ;
    const history = [];
    let callerPhone = null;
    let isNew = false;
    let currentStream = null;
    const startTime = Date.now();

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'setup') {
        callerPhone = msg.from || null;
        isNew = await checkAndLogCaller(callerPhone);
        console.log(`${biz.name} | ${callerPhone} | ${isNew?'🆕 NEW':'🔁 RETURNING'}`);
        // Promo SMS cho khách mới (chỉ tiệm nail)
        if (isNew && callerPhone && biz.promoSms) {
          await sendSms(callerPhone, biz.promoSms, biz.twilioFrom);
        }
        return;
      }

      if (msg.type === 'prompt') {
        const text = msg.voicePrompt || '';
        if (!text.trim()) return;
        history.push({ role: 'user', content: text });
        try {
          let full = '';
          currentStream = anthropic.messages.stream({
            model: MODEL, max_tokens: 220,
            system: biz.systemPrompt, messages: history,
          });
          currentStream.on('text', (d) => {
            full += d;
            socket.send(JSON.stringify({ type: 'text', token: d, last: false }));
          });
          await currentStream.finalMessage();
          socket.send(JSON.stringify({ type: 'text', token: '', last: true }));
          history.push({ role: 'assistant', content: full });
        } catch (err) {
          console.error('Claude error:', err?.message);
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

    socket.on('close', async () => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`📵 ${biz.name} | ${duration}s`);

      // Missed call
      if (duration < 15 && callerPhone) {
        await sendSms(callerPhone,
          `Hi! Sorry we missed your call at ${biz.name}. How can we help? Reply here anytime.`,
          biz.twilioFrom
        );
        await saveCall({ bizKey: biz.key, phone: callerPhone, duration, outcome: 'missed', isNew });
        return;
      }

      // Review SMS (chỉ tiệm nail)
      if (callerPhone && biz.reviewSms) {
        await sendSms(callerPhone, biz.reviewSms, biz.twilioFrom);
      }

      let outcome = 'inquiry';
      if (pool && history.length > 0) {
        try {
          const transcript = history.map(m=>`${m.role}: ${m.content}`).join('\n');
          const r = await anthropic.messages.create({
            model: MODEL, max_tokens: 300,
            system: biz.extractPrompt,
            messages: [{ role: 'user', content: transcript }],
          });
          const txt = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
          const j = JSON.parse(txt.replace(/```json|```/g,'').trim());
          const hasAction = j.is_booking || j.is_ticket;
          if (hasAction) {
            outcome = j.is_booking ? 'booking' : 'ticket';
            await saveLead({
              source: 'call', bizKey: biz.key, phone: callerPhone,
              name: j.name, service: j.service || j.topic,
              time: j.preferred_time, notes: j.notes,
            });
            if (OWNER_PHONE && biz.ownerNotifySms) {
              await sendSms(OWNER_PHONE,
                biz.ownerNotifySms({ ...j, phone: callerPhone }),
                biz.twilioFrom
              );
            }
            console.log(`✅ ${outcome} lưu: ${j.name||'?'}`);
          }
        } catch (err) { console.error('Extract error:', err.message); }
      }

      await saveCall({ bizKey: biz.key, phone: callerPhone, duration, outcome, isNew });
    });
  });
});

// ── Two-way SMS ───────────────────────────────────────────────
fastify.post('/sms', async (req, reply) => {
  const body = parseForm(req.body);
  const from = body.From || '';
  const toNum = body.To || '';
  const inbound = (body.Body || '').trim();
  const { biz } = getBiz(toNum);

  let replyText = `Thanks for reaching out to ${biz.name}! Our team will get back to you shortly.`;
  if (inbound && from) {
    try {
      const history = await getSmsHistory(from);
      history.push({ role: 'user', content: inbound });
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 200,
        system: biz.smsPrompt,
        messages: history.slice(-10),
      });
      replyText = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim() || replyText;
      history.push({ role: 'assistant', content: replyText });
      await saveSmsHistory(from, history.slice(-20));
    } catch (err) { console.error('SMS Claude error:', err.message); }
  }

  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<MessagingResponse><Message>${esc(replyText)}</Message></MessagingResponse>`
  );
});

// ── Booking /book ─────────────────────────────────────────────
fastify.get('/book', async (req, reply) => {
  const bizNum = req.query?.for || '+18327995559';
  const { biz } = getBiz(bizNum);
  if (biz.type !== 'salon') {
    reply.redirect('/book?for=+18327995559');
    return;
  }
  const opts = biz.services.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  reply.type('text/html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book · ${esc(biz.name)}</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:440px;background:#191430;border-radius:20px;padding:28px}
.logo{font-weight:800;font-size:22px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;text-align:center}
.sub{text-align:center;color:#9ca3af;font-size:13px;margin:4px 0 22px}
label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
input,select,textarea{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2d2750;background:#120e26;color:#fff;font-size:15px}
button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(90deg,#a855f7,#ec4899)}</style></head><body>
<form class="card" method="POST" action="/book">
<input type="hidden" name="biz" value="${esc(biz.twilioFrom)}">
<div class="logo">${esc(biz.name)}</div>
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
  const { biz } = getBiz(p.biz);
  await saveLead({ source: 'web', bizKey: biz.key,
    phone: p.phone, name: p.name, service: p.service, time: p.time, notes: p.notes });
  if (p.phone) {
    await sendSms(p.phone,
      `Hi ${p.name||'there'}! We got your booking request at ${biz.name}. Our team will call to confirm. 💅`,
      biz.twilioFrom
    );
  }
  if (OWNER_PHONE) {
    await sendSms(OWNER_PHONE,
      `📅 WEB BOOKING — ${biz.name}\nName: ${p.name||'?'}\nService: ${p.service||'?'}\nTime: ${p.time||'?'}\nPhone: ${p.phone||'?'}`,
      biz.twilioFrom
    );
  }
  reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Thank you</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}
.t{font-size:24px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}a{color:#22d3ee}</style></head><body><div>
<div class="t">Thank you! 💜</div>
<p>We sent you a text. Our team will call shortly to confirm.</p>
<p><a href="/book?for=${esc(biz.twilioFrom)}">Book another</a></p>
</div></body></html>`);
});

// ── Dashboard /leads ──────────────────────────────────────────
fastify.get('/leads', async (req, reply) => {
  const key = req.query.key || '';
  if (key !== ADMIN_KEY) {
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Login</title>
<style>body{margin:0;font-family:sans-serif;background:#0f0c1d;color:#fff;height:100vh;display:flex;align-items:center;justify-content:center}
form{background:#191430;padding:28px;border-radius:18px;width:300px;text-align:center}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #2d2750;background:#120e26;color:#fff;margin-top:10px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer}</style>
</head><body><form method="GET" action="/leads">
<b style="font-size:16px">NEXORA · Dashboard</b>
<input name="key" type="password" placeholder="Password" autofocus>
<button>Open</button></form></body></html>`);
    return;
  }

  let leads = [], bizStats = [];
  if (pool) {
    leads = (await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500')).rows;
    for (const biz of Object.values(BUSINESSES)) {
      const s = await getAnalytics(biz.key);
      if (s) bizStats.push({ name: biz.name, ...s });
    }
  }

  const statHtml = bizStats.map(s => `
    <div class="bizstat">
      <div class="biztitle">${esc(s.name)}</div>
      <div class="statrow">
        <span><b>${s.calls_today||0}</b> today</span>
        <span><b>${s.calls_week||0}</b> this week</span>
        <span><b>${s.bookings_week||0}</b> bookings</span>
        <span><b>${s.new_week||0}</b> new callers</span>
      </div>
    </div>`).join('');

  const bizColors = { 'nexora-touch': '#a855f7', 'bitcoin-nail-bar': '#ec4899', 'vlinkpay': '#22d3ee' };
  const items = leads.map(l => `
    <div class="lead ${l.status==='done'?'done':''}">
      <div class="top">
        <span class="src ${l.source}">${l.source==='call'?'📞':'🌐'}</span>
        <span class="biz" style="color:${bizColors[l.business_key]||'#94a3b8'}">${esc(l.business_key||'—')}</span>
        <span class="time">${new Date(l.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div class="name">${esc(l.customer_name)||'(no name)'}${l.customer_phone?` · <a href="tel:${esc(l.customer_phone)}">${esc(l.customer_phone)}</a>`:''}</div>
      <div class="svc">${esc(l.service)||'—'}${l.preferred_time?' · '+esc(l.preferred_time):''}</div>
      ${l.notes?`<div class="notes">${esc(l.notes)}</div>`:''}
      ${l.status!=='done'
        ?`<form method="POST" action="/leads/done"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${l.id}"><button>✓ Done</button></form>`
        :'<span class="badge">✓ Done</span>'}
    </div>`).join('');

  reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXORA Dashboard</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0c1d;color:#fff;padding:16px;max-width:680px;margin:0 auto}
h1{font-size:20px;background:linear-gradient(90deg,#a855f7,#22d3ee,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:16px}
.bizstat{background:#191430;border-radius:12px;padding:14px;margin-bottom:10px;border:1px solid #1e1a3a}
.biztitle{font-weight:700;font-size:14px;margin-bottom:8px;color:#e2e8f0}
.statrow{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#64748b}.statrow b{color:#fff;font-size:18px;display:block}
.lead{background:#191430;border-radius:14px;padding:14px;margin-bottom:12px;border:1px solid #1e1a3a}.lead.done{opacity:.5}
.top{display:flex;gap:8px;align-items:center;font-size:11px;color:#64748b;margin-bottom:6px;flex-wrap:wrap}
.src{font-size:14px}.biz{font-weight:700;font-size:11px}
.name{font-weight:700;font-size:15px}.name a{color:#22d3ee;text-decoration:none}
.svc{color:#cbd5e1;font-size:13px;margin-top:3px}.notes{color:#94a3b8;font-size:12px;margin-top:6px;font-style:italic}
button{margin-top:10px;padding:9px 14px;border:0;border-radius:9px;font-weight:700;color:#fff;background:linear-gradient(90deg,#a855f7,#ec4899);cursor:pointer;font-size:13px}
.badge{display:inline-block;margin-top:8px;font-size:12px;color:#34d399}
.empty{color:#64748b;text-align:center;margin-top:40px;font-size:14px}
.section{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin:20px 0 10px}</style></head><body>
<h1>NEXORA · Dashboard</h1>
<div class="section">Analytics by product</div>
${statHtml || '<div class="empty">No calls yet.</div>'}
<div class="section">All leads (${leads.length})</div>
${items || '<div class="empty">No leads yet. Calls and bookings will appear here.</div>'}
</body></html>`);
});

fastify.post('/leads/done', async (req, reply) => {
  const p = parseForm(req.body);
  if (p.key !== ADMIN_KEY) { reply.code(403).send('Forbidden'); return; }
  if (pool) await pool.query(`UPDATE leads SET status='done' WHERE id=$1`, [p.id]);
  reply.redirect(`/leads?key=${encodeURIComponent(ADMIN_KEY)}`);
});

// ── Start ─────────────────────────────────────────────────────
await initDb();
const port = process.env.PORT || 8080;
fastify.listen({ port, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`✅ NEXORA multi-tenant server chạy tại ${addr}`);
  Object.values(BUSINESSES).forEach(b =>
    console.log(`   📞 ${b.twilioFrom} → ${b.name}`)
  );
});
