import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import twilio from 'twilio';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-haiku-4-5'; // đổi 'claude-sonnet-4-6' qua Railway Variables nếu muốn demo thông minh hơn

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
    CREATE TABLE IF NOT EXISTS milestones (
      business_key TEXT, kind TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (business_key, kind)
    );
    CREATE TABLE IF NOT EXISTS weekly_log (
      week_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT now()
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
- Eight thousand square foot luxury salon. Vietnamese-speaking staff. Crypto payments accepted. Walk-ins welcome, appointments preferred.
- Complimentary drinks included with every service: wine, champagne, mimosas, cocktails, Vietnamese coffee, and non-alcoholic options. Must be twenty one and over for alcohol. Limit two drinks per person.
- Closed Sundays so the team can rest and attend church.
- First-time guests receive twenty percent off select services.

PRICE LIST (state these prices when asked):
Pedicures: Classic forty. Milk and Honey fifty five. Paris Pearl seventy five. Bitcoin Twenty Four K Gold ninety nine. President Seven Star four hundred ninety nine (ultimate royal package, includes premium manicure or full set plus champagne). Add gel polish twenty. Extra massage two dollars per minute.
Manicures: Classic twenty five. Deluxe thirty five. Gel Shellac forty five. Milk and Honey fifty. Gel polish change thirty. Gel remover ten.
Acrylic full set: with polish fifty. Shellac sixty. White or Pear Tip fifty five. Color Powder sixty. Ombre seventy. Pink and White seventy. Ombre two color sixty five, three color seventy five.
Acrylic fill: with polish forty. Shellac fifty. Tip forty. Color Powder fifty. Ombre sixty. Pink and White sixty.
Dipping: powder fifty two. With tip sixty. Pink and White seventy. Ombre seventy. Add manicure twenty, cuticle care ten.
Gel services: Builder Gel natural set sixty five, with tip seventy. Gel-X full set sixty five, refill fifty five.
Kids: pedicure twenty five, manicure fifteen, polish ten, gel add-on fifteen.
Waxing (starting prices): eyebrow fifteen, lip ten, chin fifteen, full face forty five, underarms twenty five, full arms forty, full legs sixty, back forty five, bikini forty five, Brazilian sixty.
Add-ons: paraffin wax fifteen, collagen sock or gloves fifteen, hot stone ten and up, nail design seven and up, nail repair seven and up, take off with service ten, without service twenty.

CONVERSATION QUALITY:
- Vary your openings — never start two replies the same way. Sound like a warm, sharp human, not a script.
- If you did not clearly hear something important (name, service, time), politely ask once to repeat it instead of guessing.
- Before ending a booking, confirm it back in one short sentence: name, service, day and time.
- Never repeat a sentence you already said in this call.

RULES:
- State prices as listed above when asked. For add-ons with "and up" pricing, say starting price and note final price depends on the service.
- For appointments: collect name, service, preferred day and time — say team will call to confirm. Phone is captured automatically.
- Complimentary drinks: yes we offer wine, champagne, cocktails, and non-alcoholic drinks. Must be twenty one and over for alcohol, limit two per person.
- If caller is upset or wants a real person: say a staff member will call back shortly.
- Never make up information or make promises the salon cannot keep.

DEMO MODE — IMPORTANT:
Some callers are SALON OWNERS testing this AI before buying it for their own salon. Signs: they ask "are you an AI", "how does this work", "I want this for my salon", "how much is this system", they mention NEXORA, or they ask questions about the technology instead of nail services.
When you detect a salon owner prospect:
- Own it proudly: "Yes — I'm the NEXORA TOUCH AI receptionist, and you're hearing me live, answering a real salon right now."
- Briefly pitch: answers every call twenty four seven, books appointments, texts customers back, sends Google review requests — and the salon keeps its own phone number. Setup within one day.
- Pricing if asked: plans start at ninety nine dollars a month, most salons choose Pro at one ninety nine. Fourteen day free trial, no credit card.
- Then CAPTURE THE LEAD: ask for their name, their salon name, and say the NEXORA team will reach out — or they can sign up at nexora touch dot com.
- If they speak Vietnamese: warmly say a Vietnamese-speaking team member will call them right back, and take their name and salon name.
- Stay friendly and confident — you ARE the product demo. Every question they ask, answer it the way the best salesperson would: honest, specific, no pressure.`,
    smsPrompt: `You are a friendly SMS receptionist for Bitcoin Nail Bar at 9793 Westheimer Rd Suite A, Houston TX. Hours: Mon-Sat 9:30am-7pm, closed Sunday. Crypto payments, Vietnamese staff, walk-ins welcome. Reply in 1-2 sentences. For appointments: collect name, service, day/time and say team will call to confirm.`,
    extractPrompt: `Read a nail salon call transcript. Return ONLY raw JSON:
{"is_booking":true/false,"is_prospect":true/false,"name":string|null,"salon":string|null,"service":string|null,"preferred_time":string|null,"notes":string|null}
is_booking=true only if caller wanted to schedule an appointment.
is_prospect=true if the caller is a SALON OWNER interested in the NEXORA AI system itself (asked how it works, pricing of the AI, wants it for their salon). salon=their salon name if mentioned.`,
    promoSms: `💅 Thanks for calling Bitcoin Nail Bar! First-time guests get 10% off. Show this text at checkout. Book: bitcoinnailbar.com`,
    reviewSms: `Thanks for calling Bitcoin Nail Bar! 💜 Please leave us a Google review: ${GOOGLE_REVIEW_LINK}`,
    ownerNotifySms: (l) => `📅 NEW BOOKING — Bitcoin Nail Bar\nName: ${l.name||'?'}\nService: ${l.service||'?'}\nTime: ${l.time||'?'}\nPhone: ${l.phone||'?'}`,
    services: ['Gel Manicure', 'Dipping Powder', 'Pedicure', 'Full Set Acrylic', 'Nail Art', 'Other']
  },

  // ── 2) BITCOIN NAIL BAR — Lễ tân tiệm nail ──────────────────
  '+18329795559': {
    key: 'nexora-touch',
    name: 'NEXORA TOUCH',
    type: 'support',
    twilioFrom: '+18329795559',
    voice: 'Joanna-Generative',
    language: 'en-US',
    ttsProvider: undefined,
    switchToVietnamese: false,
    welcome: 'Thank you for calling Nexora Touch. This is your virtual support agent. How can I help you today?',
    systemPrompt: `You are a friendly and knowledgeable female support agent for Nexora Touch — a complete nail salon management platform connecting all essential tools for both technicians and salon owners.
This conversation WILL BE READ ALOUD. Follow these rules:

VOICE RULES:
- Write ALL numbers as words. No emojis, bullets, or special symbols.
- Two to three short natural sentences per turn.
- Speak English by default. If the caller speaks Vietnamese, reply in Vietnamese.

WHAT NEXORA TOUCH IS:
Nexora Touch is an all-in-one nail salon platform. Everything in one system.

FULL FEATURE SET:
- Smart Check-in: customers check in digitally when they arrive, no pen and paper.
- Smart Check-out: fast checkout with tip and review built in.
- Turn Management: fairly and transparently tracks each technician's service turns.
- AI Phone Booking: answers calls twenty four seven, takes appointments, captures leads automatically.
- QR Tip: technicians receive tips via QR code, fast, cashless, lower card fees.
- QR Payment: customers scan the salon QR code, select their invoice, and pay directly. Money goes to the salon bank account. Every transaction is recorded: who paid, how much, what date, what service, which technician, tip amount, revenue, and payment method, all visible in the Smart Salon Dashboard. No more manual bookkeeping or end of day cash confusion. Export clear reports for your accountant or tax filing.
- Bank Deposit Reporting: automated deposit reports, clear and accurate.
- Google Review Reminder: automatically prompts customers to leave a Google review after each visit, boosting reputation and attracting new clients.
- AI Service Quality Analysis: AI analyzes service quality to help owners improve customer experience.
- Payroll and Payout Management: smart transparent pay management for every technician.
- AI Tax IQ: smart tax solution for both technicians and owners. Tracks receipts, mileage, payouts, and supports accurate tax filing. At year end, export clear reports instead of sorting through paper receipts.
- Smart Salon Dashboard: real time overview of all salon activity including revenue, customers, technician performance, tips, expenses, and everything needed for accounting or taxes.

SUPPORT RULES:
- For account issues, billing, bugs, or setup help: collect caller's name and salon name, say a specialist will follow up shortly.
- For demo requests: take their name, salon name, and phone, say the team will reach out to schedule.
- Never invent specific pricing, contract terms, or technical specs.
- Caller's phone is captured automatically.`,
        smsPrompt: `Bạn là nhân viên hỗ trợ SMS thân thiện của NEXORA TOUCH — nền tảng số hóa tip, đánh giá và tích điểm cho tiệm nail, thuộc hệ sinh thái VLINKGROUP. Trả lời ngắn gọn trong một đến hai câu. Xưng hô anh/chị – em. Nếu khách nói tiếng Anh thì trả lời tiếng Anh. Vấn đề kỹ thuật hoặc tài khoản: hỏi tên và tên tiệm, nói chuyên viên sẽ liên hệ lại.`,
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


// ── TRIAL RESULTS ENGINE ─────────────────────────────────────
const AVG_TICKET = Number(process.env.AVG_TICKET || 47); // ước tính doanh thu/booking

// Trả về true nếu milestone này CHƯA từng xảy ra (và đánh dấu luôn)
async function firstTime(bizKey, kind) {
  if (!pool) return false;
  try {
    const r = await pool.query(
      `INSERT INTO milestones (business_key, kind) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING kind`, [bizKey, kind]);
    return r.rowCount === 1;
  } catch { return false; }
}

// Wow-moment: cuộc gọi đầu tiên AI trả lời
async function wowFirstCall(biz, callerPhone) {
  if (!OWNER_PHONE) return;
  if (await firstTime(biz.key, 'first_call')) {
    await sendSms(OWNER_PHONE,
      `🎉 ${biz.name}: AI vừa trả lời CUỘC GỌI ĐẦU TIÊN!\nKhách: ${callerPhone||'?'}\nHệ thống chính thức trực máy 24/7 cho tiệm từ giờ phút này.`,
      biz.twilioFrom);
  }
}

// Wow-moment: booking đầu tiên AI chốt
async function wowFirstBooking(biz, j, callerPhone) {
  if (!OWNER_PHONE) return;
  if (await firstTime(biz.key, 'first_booking')) {
    await sendSms(OWNER_PHONE,
      `🏆 BOOKING ĐẦU TIÊN AI chốt cho ${biz.name}!\n${j.name||'?'} · ${j.service||j.topic||'?'} · ${j.preferred_time||''}\nKhông có AI, cuộc gọi này có thể đã mất vào tay tiệm khác.`,
      biz.twilioFrom);
  }
}

// Báo Cáo Tuần — thứ Hai 8:00 sáng giờ Texas
function chicagoNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}
async function sendWeeklyReports() {
  if (!pool || !OWNER_PHONE) return;
  for (const biz of Object.values(BUSINESSES)) {
    try {
      const c = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE outcome <> 'missed')   AS answered,
          COUNT(*) FILTER (WHERE outcome = 'missed')    AS missed,
          COUNT(*) FILTER (WHERE is_new_caller)         AS newc
        FROM calls
        WHERE business_key=$1 AND created_at > now()-interval '7 days'`, [biz.key]);
      const l = await pool.query(
        `SELECT COUNT(*) AS bookings FROM leads
         WHERE business_key=$1 AND created_at > now()-interval '7 days'`, [biz.key]);
      const a = Number(c.rows[0].answered||0), m = Number(c.rows[0].missed||0),
            n = Number(c.rows[0].newc||0), b = Number(l.rows[0].bookings||0);
      if (a + m + b === 0) continue; // tuần không có hoạt động thì bỏ qua
      const rev = b * AVG_TICKET;
      await sendSms(OWNER_PHONE,
        `📊 BÁO CÁO TUẦN — ${biz.name}\n☎️ ${a} cuộc AI trả lời\n📅 ${b} booking ≈ $${rev.toLocaleString('en-US')}\n📵 ${m} cuộc nhỡ được cứu bằng text\n🆕 ${n} khách mới\nTắt AI, các con số này về 0. 💜`,
        biz.twilioFrom);
    } catch (e) { console.error('Weekly report error:', biz.key, e.message); }
  }
  console.log('📊 Weekly reports sent.');
}
async function weeklyTick() {
  if (!pool) return;
  const now = chicagoNow();
  if (now.getDay() !== 1 || now.getHours() !== 8) return; // chỉ thứ Hai 8h sáng
  const key = now.toISOString().slice(0,10);
  try {
    const r = await pool.query(
      `INSERT INTO weekly_log (week_key) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING week_key`, [key]);
    if (r.rowCount === 1) await sendWeeklyReports();
  } catch (e) { console.error('weeklyTick:', e.message); }
}
setInterval(weeklyTick, 15 * 60 * 1000); // kiểm tra mỗi 15 phút

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
  const lang = biz.language || 'en-US';
  const voice = biz.voice || 'Joanna-Generative';
  const ttsAttr = biz.ttsProvider ? `ttsProvider="${biz.ttsProvider}" ` : '';
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}"
      welcomeGreeting="${biz.welcome}"
      ${ttsAttr}voice="${voice}"
      language="${lang}"
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

        // Chuyển sang giọng tiếng Việt Neural2 sau câu chào tiếng Anh
        if (biz.switchToVietnamese) {
          setTimeout(() => {
            try {
              socket.send(JSON.stringify({
                type: 'language',
                ttsLanguage: 'vi-VN',
                transcriptionLanguage: 'vi-VN',
                voice: 'vi-VN-Neural2-A',
                ttsProvider: 'Google',
              }));
              // Câu chào tiếng Việt sau khi đã chuyển giọng
              socket.send(JSON.stringify({
                type: 'text',
                token: 'Xin chào, em có thể giúp gì cho anh chị ạ?',
                last: true,
              }));
            } catch {}
          }, 1500); // đợi 1.5 giây sau câu chào tiếng Anh
        }

        // Promo SMS cho khách mới
        if (isNew && callerPhone && biz.promoSms) {
          await sendSms(callerPhone, biz.promoSms, biz.twilioFrom);
        }
        return;
      }

      if (msg.type === 'prompt') {
        const text = (msg.voicePrompt || '').trim();
        // Chống nhiễu: bỏ qua prompt rỗng, quá ngắn, hoặc trùng với câu vừa nói
        if (!text || text.length < 2) return;
        const lastUser = [...history].reverse().find(m => m.role === 'user');
        if (lastUser && lastUser.content === text) return; // trùng -> bỏ qua, tránh lặp
        history.push({ role: 'user', content: text });
        try {
          let full = '';
          currentStream = anthropic.messages.stream({
            model: MODEL, max_tokens: 150,
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
          // 🔥 Chủ tiệm gọi thử demo và quan tâm mua NEXORA
          if (j.is_prospect && OWNER_PHONE) {
            outcome = 'prospect';
            await saveLead({
              source: 'call', bizKey: 'nexora-touch', phone: callerPhone,
              name: j.name, service: 'DEMO PROSPECT', time: null,
              notes: `Salon: ${j.salon||'?'} | ${j.notes||''}`,
            });
            await sendSms(OWNER_PHONE,
              `🔥 HOT LEAD từ số demo!\nChủ tiệm vừa gọi nghe thử AI và quan tâm.\nTên: ${j.name||'?'}\nTiệm: ${j.salon||'?'}\nSĐT: ${callerPhone||'?'}\nGọi lại NGAY khi còn nóng!`,
              biz.twilioFrom);
            console.log(`🔥 Prospect: ${j.name||'?'} — ${j.salon||'?'}`);
          }
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
            if (outcome === 'booking') await wowFirstBooking(biz, j, callerPhone);
          }
        } catch (err) { console.error('Extract error:', err.message); }
      }

      await saveCall({ bizKey: biz.key, phone: callerPhone, duration, outcome, isNew });
      if (outcome !== 'missed') await wowFirstCall(biz, callerPhone);
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
