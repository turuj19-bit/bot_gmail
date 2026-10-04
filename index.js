/*
 * PEDIA PAY (versi Vercel) - Payment Gateway 1 file
 * ------------------------------------------------------------
 * Vercel tidak punya disk permanen, jadi data disimpan di Upstash Redis
 * dan teks bukti TF dibaca lewat OCR.space (gratis).
 *
 * ENV yang harus diisi di Vercel (Settings > Environment Variables):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *       (otomatis ada kalau pasang Upstash dari Vercel Marketplace.
 *        Nama KV_REST_API_URL / KV_REST_API_TOKEN juga didukung)
 *   OCR_SPACE_KEY   (daftar gratis di ocr.space/ocrapi)
 *   ADMIN_PASSWORD, API_KEY, NOTIF_SECRET
 *   RECEIVER_NAME   (nama toko DANA Bisnis seperti tampil di bukti TF)
 *   RECEIVER_PHONE  (opsional)
 *   REQUIRE_NOTIF=1 (opsional: lunas hanya jika bukti valid DAN notif HP masuk)
 *   ORDER_TTL_MIN   (opsional, default 15)
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');

const CFG = {
  PORT: +(process.env.PORT || 3000),
  BASE_URL: process.env.BASE_URL || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  API_KEY: process.env.API_KEY || '',
  NOTIF_SECRET: process.env.NOTIF_SECRET || '',
  OCR_KEY: process.env.OCR_SPACE_KEY || '',
  RECEIVER_NAME: (process.env.RECEIVER_NAME || '').toLowerCase().trim(),
  RECEIVER_PHONE: (process.env.RECEIVER_PHONE || '').replace(/\D/g, ''),
  REQUIRE_NOTIF: process.env.REQUIRE_NOTIF === '1',
  ORDER_TTL_MIN: +(process.env.ORDER_TTL_MIN || 15),
  MAX_ATTEMPTS: 5,
  TZ_OFFSET_H: 7, // WIB
};
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

/* ===================== REDIS (REST) ===================== */
async function R(...cmd) {
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' },
    body: JSON.stringify(cmd.map((x) => (typeof x === 'number' ? String(x) : x))),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ACTIVE = ['pending', 'notif_matched', 'proof_ok', 'flagged'];
const isActive = (o) => ACTIVE.includes(o.status);
const TTL_ORDER = 60 * 60 * 24 * 90;

async function getO(id) {
  if (!/^PAY-[A-F0-9]{10}$/.test(id)) return null;
  const s = await R('GET', 'order:' + id);
  return s ? JSON.parse(s) : null;
}
async function putO(o) {
  await R('SET', 'order:' + o.id, JSON.stringify(o), 'EX', TTL_ORDER);
  await R(isActive(o) ? 'SADD' : 'SREM', 'active', o.id);
}
async function mgetOrders(ids) {
  if (!ids || !ids.length) return [];
  const arr = await R('MGET', ...ids.map((i) => 'order:' + i));
  return arr.filter(Boolean).map((s) => JSON.parse(s));
}
const loadActive = async () => mgetOrders(await R('SMEMBERS', 'active'));

/* ===================== STATUS ORDER ===================== */
async function refresh(o) {
  if (['paid', 'rejected', 'expired'].includes(o.status)) return o;
  if (Date.now() > o.expires && !o.proof_ok && !o.flag) {
    o.status = 'expired';
    await putO(o);
    return o;
  }
  if (o.proof_ok && (!CFG.REQUIRE_NOTIF || o.notif)) {
    o.status = 'paid';
    o.paid_at = Date.now();
    o.via = o.notif ? 'bukti_tf+notif_hp' : 'bukti_tf';
    await putO(o);
    await sendCallback(o);
    return o;
  }
  const s = o.flag ? 'flagged' : o.proof_ok ? 'proof_ok' : o.notif ? 'notif_matched' : 'pending';
  if (s !== o.status) { o.status = s; await putO(o); }
  return o;
}

async function sendCallback(o) {
  if (!o.callback_url) return;
  const body = JSON.stringify({
    event: 'payment.paid', order_id: o.id, ref: o.ref, amount: o.amount,
    total: o.total, paid_at: o.paid_at, verified_by: o.via,
  });
  const sig = crypto.createHmac('sha256', CFG.API_KEY).update(body).digest('hex');
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(o.callback_url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig },
        body, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) { o.callback_ok = true; await putO(o); return; }
    } catch (e) {}
    await sleep(1000);
  }
  o.callback_ok = false;
  await putO(o);
}

/* ===================== OCR (OCR.space) ===================== */
async function ocrSpace(buf) {
  const fd = new FormData();
  fd.append('base64Image', 'data:image/jpeg;base64,' + buf.toString('base64'));
  fd.append('language', 'eng');
  fd.append('OCREngine', '2');
  fd.append('isOverlayRequired', 'false');
  const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: CFG.OCR_KEY }, body: fd, signal: AbortSignal.timeout(40000) });
  const j = await r.json();
  if (j.IsErroredOnProcessing || !j.ParsedResults) throw new Error('OCR gagal: ' + JSON.stringify(j.ErrorMessage || j));
  return j.ParsedResults.map((p) => p.ParsedText || '').join('\n');
}

/* ===================== PARSER BUKTI TF ===================== */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, ags: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
const TIME_RE = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?!\d)/;

function parseAmounts(t) {
  const out = new Set();
  const re = /(?:rp|idr)\.?\s*(\d[\d.,]*)/gi;
  let m;
  while ((m = re.exec(t))) {
    const s = m[1].replace(/[.,]$/, '').replace(/,\d{1,2}$/, '').replace(/[.,]/g, '');
    const v = parseInt(s, 10);
    if (v) out.add(v);
  }
  return [...out];
}
function parseDT(t) {
  let d = null, idx = 0, m;
  if ((m = t.match(/(\d{1,2})\s*(jan|feb|mar|apr|mei|may|jun|jul|agu|ags|aug|sep|okt|oct|nov|des|dec)[a-z]*\.?,?\s*(\d{4})/i))) {
    d = { y: +m[3], mo: MON[m[2].toLowerCase()], d: +m[1] }; idx = m.index;
  } else if ((m = t.match(/(\d{4})-(\d{2})-(\d{2})/))) {
    d = { y: +m[1], mo: +m[2], d: +m[3] }; idx = m.index;
  } else if ((m = t.match(/(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?!\d)/))) {
    d = { y: +m[3], mo: +m[2], d: +m[1] }; idx = m.index;
  }
  if (!d) return null;
  const tm = t.slice(idx).match(TIME_RE) || t.match(TIME_RE);
  if (!tm) return { d, t: null };
  return { d, t: { h: +tm[1], mi: +tm[2], s: +(tm[3] || 0) } };
}
function parseRefs(t) {
  const set = new Set();
  (t.match(/(?<![\d])\d{10,24}(?![\d])/g) || []).forEach((x) => {
    const phoneLike = /^(08|62)\d{8,12}$/.test(x) && x.length <= 14;
    if (!phoneLike && x !== CFG.RECEIVER_PHONE) set.add(x);
  });
  (t.match(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,}\b/g) || []).forEach((x) => set.add(x));
  return [...set].slice(0, 3);
}
const fmtRp = (n) => 'Rp' + Number(n).toLocaleString('id-ID');
const fmtWIB = (ts) => new Date(ts + CFG.TZ_OFFSET_H * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

/* ===================== DETEKSI EDIT ===================== */
const EDITOR_SIG = /photoshop|canva|gimp|picsart|snapseed|lightroom|pixlr|photopea|facetune|capcut|inshot|paint\.net|adobe(?! rgb)/i;

async function elaScore(buf) {
  const base = await sharp(buf).rotate().resize({ width: 800, withoutEnlargement: true }).removeAlpha().jpeg({ quality: 90 }).toBuffer();
  const re = await sharp(base).jpeg({ quality: 75 }).toBuffer();
  const a = await sharp(base).greyscale().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(re).greyscale().raw().toBuffer();
  const { width: w, height: h } = a.info;
  const B = 24, bx = Math.ceil(w / B), by = Math.ceil(h / B);
  const sums = new Float64Array(bx * by), cnt = new Float64Array(bx * by);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = ((y / B) | 0) * bx + ((x / B) | 0);
      sums[k] += Math.abs(a.data[i] - b[i]);
      cnt[k]++;
    }
  }
  const means = [...sums].map((s, i) => s / cnt[i]).sort((p, q) => p - q);
  const p95 = means[Math.floor(means.length * 0.95)] || 0.1;
  const max = means[means.length - 1];
  return { max, ratio: max / Math.max(p95, 0.5) };
}

/* ===================== VERIFIKASI BUKTI ===================== */
async function verifyProof(o, buf) {
  const hard = [], soft = [];
  const hash = sha256(buf);
  if (await R('GET', 'hash:' + hash)) hard.push('Gambar bukti ini sudah pernah dipakai.');

  let meta;
  try { meta = await sharp(buf).metadata(); } catch (e) { return { hard: ['File bukan gambar yang valid.'], soft, info: {}, hash }; }

  // OCR
  let prep = await sharp(buf).rotate().resize({ width: 1200 }).jpeg({ quality: 85 }).toBuffer();
  if (prep.length > 900000) prep = await sharp(buf).rotate().resize({ width: 1000 }).jpeg({ quality: 60 }).toBuffer();
  let text;
  try { text = await ocrSpace(prep); } catch (e) { console.error(e); return { error: 'Pembaca bukti sedang bermasalah. Coba lagi sebentar.', hard, soft, info: {}, hash }; }
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const info = {};
  if (flat.length < 30) hard.push('Teks di gambar hampir tidak terbaca. Gunakan screenshot asli yang jelas.');

  // 1. Status berhasil
  if (!/berhasil|sukses|success|selesai|completed/i.test(flat)) hard.push('Tulisan "berhasil/sukses" tidak ditemukan di bukti.');

  // 2. Nominal harus sama persis
  const amounts = parseAmounts(flat);
  info.amounts = amounts;
  const fmt = String(o.total).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fmtRe = new RegExp('(?<![\\d.,])' + fmt.replace(/\./g, '\\.') + '(?!\\d|\\.\\d)');
  if (!(amounts.includes(o.total) || fmtRe.test(flat))) {
    hard.push(amounts.length
      ? 'Nominal di bukti (' + amounts.map(fmtRp).join(', ') + ') tidak sama dengan total ' + fmtRp(o.total) + '.'
      : 'Nominal tidak terbaca. Pastikan total ' + fmtRp(o.total) + ' terlihat jelas.');
  }

  // 3. Tanggal dan jam
  const dt = parseDT(flat);
  if (!dt || !dt.t) {
    hard.push('Tanggal atau jam tidak terbaca. Screenshot ulang dengan tanggal dan jam terlihat jelas.');
  } else {
    const ts = Date.UTC(dt.d.y, dt.d.mo - 1, dt.d.d, dt.t.h, dt.t.mi, dt.t.s) - CFG.TZ_OFFSET_H * 3600e3;
    info.datetime = fmtWIB(ts) + ' WIB';
    if (ts + 60000 < o.created) hard.push('Waktu transfer (' + info.datetime + ') lebih awal dari waktu order dibuat (' + fmtWIB(o.created) + ' WIB).');
    else if (ts > Date.now() + 120000) hard.push('Waktu transfer di bukti berada di masa depan.');
    else if (ts > o.expires + 10 * 60000) hard.push('Waktu transfer melewati batas waktu order.');
  }

  // 4. Penerima
  if (CFG.RECEIVER_NAME) {
    const tokens = CFG.RECEIVER_NAME.split(/\s+/).filter((w) => w.length >= 3);
    const hit = tokens.filter((w) => lower.includes(w)).length;
    if (tokens.length && hit < Math.ceil(tokens.length / 2)) hard.push('Nama penerima di bukti tidak cocok.');
  }
  if (CFG.RECEIVER_PHONE && !flat.includes(CFG.RECEIVER_PHONE.slice(-4))) soft.push('Nomor penerima tidak terbaca di bukti.');

  // 5. ID transaksi unik
  const refs = parseRefs(flat);
  info.refs = refs;
  for (const r of refs) {
    const used = await R('GET', 'ref:' + r);
    if (used && used !== o.id) { hard.push('ID transaksi di bukti sudah dipakai untuk order lain.'); break; }
  }
  if (!refs.length) soft.push('ID/nomor referensi transaksi tidak terbaca.');

  // 6. Tanda edit
  const sig = buf.toString('latin1').match(EDITOR_SIG);
  if (sig) soft.push('Metadata gambar memuat jejak aplikasi edit: ' + sig[0] + '.');
  if (meta.width < 300 || meta.height / meta.width < 1.3) soft.push('Rasio/ukuran gambar bukan seperti screenshot HP.');
  if (meta.format === 'jpeg') {
    try {
      const e = await elaScore(buf);
      info.ela = Math.round(e.ratio * 10) / 10;
      if (e.max > 8 && e.ratio > 3.2) soft.push('Ada area gambar dengan pola kompresi berbeda (indikasi diedit).');
    } catch (e) {}
  }
  return { hard, soft, info, hash };
}

async function tryAttachNotif(o) {
  if (o.notif) return;
  const s = await R('GET', 'un:' + o.total);
  if (!s) return;
  const n = JSON.parse(s);
  if (n.at >= o.created - 60000) {
    o.notif = { at: n.at, text: n.text };
    await R('DEL', 'un:' + o.total);
  }
}

/* ===================== SERVER ===================== */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4.4 * 1024 * 1024 } });
const base = (req) => CFG.BASE_URL || req.protocol + '://' + req.get('host');
const ah = (fn) => (req, res, next) => fn(req, res, next).catch((e) => { console.error(e); res.status(500).json({ ok: false, error: 'Kesalahan server', reasons: ['Kesalahan server. Coba lagi.'] }); });

function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// konfigurasi wajib
app.use((req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/pay/') || req.path === '/admin') return next();
  const miss = [];
  if (!RURL || !RTOK) miss.push('UPSTASH_REDIS_REST_URL/TOKEN');
  if (!CFG.API_KEY) miss.push('API_KEY');
  if (!CFG.ADMIN_PASSWORD) miss.push('ADMIN_PASSWORD');
  if (!CFG.NOTIF_SECRET) miss.push('NOTIF_SECRET');
  if (miss.length) return res.status(500).json({ ok: false, error: 'ENV belum diisi: ' + miss.join(', ') });
  next();
});
const apiAuth = (req, res, next) => (safeEq(req.get('x-api-key') || '', CFG.API_KEY) ? next() : res.status(401).json({ ok: false, error: 'API key salah' }));
// token admin tanpa state (Vercel serverless tidak berbagi memori)
const signTok = (p) => crypto.createHmac('sha256', CFG.ADMIN_PASSWORD + '|admin').update(p).digest('hex');
const mkTok = () => { const p = String(Date.now() + 12 * 3600e3); return p + '.' + signTok(p); };
const okTok = (t) => {
  const [p, s] = String(t || '').split('.');
  return !!(p && s && +p > Date.now() && safeEq(s, signTok(p)));
};
const adminAuth = (req, res, next) => (okTok(req.get('x-admin-token') || req.query.t) ? next() : res.status(401).json({ ok: false, error: 'Belum login' }));

/* ---------- API untuk web/bot ---------- */
app.post('/api/v1/orders', apiAuth, ah(async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!(amount >= 1000) || amount > 10000000) return res.status(400).json({ ok: false, error: 'amount harus 1000 - 10.000.000' });
  const id = 'PAY-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const now = Date.now();
  let code = 0, total = 0, got = false;
  for (let i = 0; i < 60 && !got; i++) {
    code = 1 + Math.floor(Math.random() * 999);
    total = amount + code;
    got = !!(await R('SET', 'lock:' + total, id, 'NX', 'EX', CFG.ORDER_TTL_MIN * 60 + 1800));
  }
  if (!got) return res.status(503).json({ ok: false, error: 'Kode unik habis, coba lagi sebentar' });
  const o = {
    id, ref: String(req.body.ref || '').slice(0, 100), amount, code, total,
    callback_url: String(req.body.callback_url || '').slice(0, 300),
    status: 'pending', created: now, expires: now + CFG.ORDER_TTL_MIN * 60000,
    attempts: 0, proof_ok: false, flag: null, notif: null, proof: null,
  };
  await tryAttachNotif(o);
  await putO(o);
  await R('LPUSH', 'orders', id);
  await R('LTRIM', 'orders', 0, 499);
  await refresh(o);
  res.json({ ok: true, order_id: id, ref: o.ref, amount, unique_code: code, total, status: o.status, pay_url: base(req) + '/pay/' + id, expires_at: o.expires });
}));
app.get('/api/v1/orders/:id', apiAuth, ah(async (req, res) => {
  const o = await getO(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: 'Order tidak ada' });
  await refresh(o);
  res.json({ ok: true, order_id: o.id, ref: o.ref, amount: o.amount, total: o.total, status: o.status, paid_at: o.paid_at || null, verified_by: o.via || null });
}));
app.get('/api/v1/orders', apiAuth, ah(async (req, res) => {
  const list = await mgetOrders(await R('LRANGE', 'orders', 0, 99));
  const out = list.filter((o) => !req.query.ref || o.ref === req.query.ref).slice(0, 50)
    .map((o) => ({ order_id: o.id, ref: o.ref, total: o.total, status: o.status }));
  res.json({ ok: true, orders: out });
}));

/* ---------- Notif dari HP ---------- */
app.post('/api/notif', ah(async (req, res) => {
  if (!safeEq(req.get('x-notif-secret') || '', CFG.NOTIF_SECRET)) return res.status(401).json({ ok: false });
  const text = String(req.body.text || req.body.message || '') + ' ' + String(req.body.title || '');
  if (!/menerima|diterima|uang masuk|dana masuk|transfer masuk|received/i.test(text)) return res.json({ ok: true, matched: false, reason: 'bukan notif uang masuk' });
  const amounts = parseAmounts(text);
  const n = { at: Date.now(), text: text.replace(/\s+/g, ' ').slice(0, 300), amounts };
  const act = await loadActive();
  const o = act.find((x) => !x.notif && amounts.includes(x.total) && n.at >= x.created - 60000 && n.at <= x.expires + 300000);
  if (o) {
    o.notif = { at: n.at, text: n.text };
    await putO(o);
    await refresh(o);
  } else {
    for (const a of amounts) await R('SET', 'un:' + a, JSON.stringify(n), 'EX', 1800);
  }
  await R('LPUSH', 'notiflog', JSON.stringify(Object.assign({ order_id: o ? o.id : null }, n)));
  await R('LTRIM', 'notiflog', 0, 99);
  res.json({ ok: true, matched: !!o, order_id: o ? o.id : null });
}));

/* ---------- Halaman bayar ---------- */
app.get('/api/qr', ah(async (req, res) => {
  const b = await R('GET', 'settings:qr');
  if (!b) return res.status(404).end();
  res.set({ 'content-type': 'image/png', 'cache-control': 'public, max-age=300' }).send(Buffer.from(b, 'base64'));
}));
app.get('/api/pay/:id', ah(async (req, res) => {
  const o = await getO(req.params.id);
  if (!o) return res.status(404).json({ ok: false });
  await refresh(o);
  res.json({
    id: o.id, status: o.status, amount: o.amount, code: o.code, total: o.total, expires: o.expires,
    attempts_left: Math.max(0, CFG.MAX_ATTEMPTS - (o.attempts || 0)), qr: !!(await R('EXISTS', 'settings:qr')),
  });
}));
app.post('/api/pay/:id/proof', upload.single('proof'), ah(async (req, res) => {
  const o = await getO(req.params.id);
  if (!o) return res.status(404).json({ ok: false, reasons: ['Order tidak ditemukan.'] });
  await refresh(o);
  if (!['pending', 'notif_matched'].includes(o.status)) return res.status(400).json({ ok: false, status: o.status, reasons: ['Order ini tidak bisa menerima bukti lagi (status: ' + o.status + ').'] });
  if (!req.file) return res.status(400).json({ ok: false, reasons: ['Pilih gambar bukti transfer dulu.'] });
  if (!CFG.OCR_KEY) return res.status(500).json({ ok: false, reasons: ['OCR_SPACE_KEY belum diisi oleh admin.'] });
  const lock = await R('SET', 'busy:' + o.id, '1', 'NX', 'EX', 60);
  if (!lock) return res.status(429).json({ ok: false, reasons: ['Bukti sebelumnya masih diproses.'] });
  try {
    await tryAttachNotif(o);
    const r = await verifyProof(o, req.file.buffer);
    if (r.error) return res.status(503).json({ ok: false, status: o.status, reasons: [r.error] });
    if (!r.hard.length) {
      const okHash = await R('SET', 'hash:' + r.hash, o.id, 'NX');
      if (!okHash) r.hard.push('Gambar bukti ini sudah pernah dipakai.');
    }
    if (r.hard.length) {
      o.attempts = (o.attempts || 0) + 1;
      if (o.attempts >= CFG.MAX_ATTEMPTS) { o.status = 'rejected'; r.hard.push('Batas percobaan habis. Order ditolak.'); }
      await putO(o);
      return res.json({ ok: false, status: o.status, reasons: r.hard });
    }
    const small = await sharp(req.file.buffer).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    await R('SET', 'img:' + r.hash, small.toString('base64'), 'EX', 60 * 60 * 24 * 60);
    o.proof = { file: r.hash, info: r.info, at: Date.now() };
    if (r.soft.length) o.flag = r.soft;
    else {
      o.proof_ok = true;
      for (const x of r.info.refs) await R('SET', 'ref:' + x, o.id, 'NX');
    }
    await refresh(o);
    await putO(o);
    res.json({ ok: true, status: o.status, flagged: !!o.flag });
  } finally {
    await R('DEL', 'busy:' + o.id);
  }
}));

/* ---------- Admin ---------- */
app.post('/admin/api/login', ah(async (req, res) => {
  if (!CFG.ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD belum diisi' });
  if (!safeEq(req.body.password || '', CFG.ADMIN_PASSWORD)) return res.status(401).json({ ok: false });
  res.json({ ok: true, token: mkTok() });
}));
app.get('/admin/api/orders', adminAuth, ah(async (req, res) => {
  const list = await mgetOrders(await R('LRANGE', 'orders', 0, 99));
  const out = [];
  for (const o of list) {
    if (isActive(o)) await refresh(o);
    out.push({ id: o.id, ref: o.ref, amount: o.amount, total: o.total, status: o.status, created: o.created, flag: o.flag, notif: o.notif, proof: o.proof, via: o.via, manual: o.manual, callback_ok: o.callback_ok, has_cb: !!o.callback_url });
  }
  res.json({ ok: true, orders: out, settings: { qr: !!(await R('EXISTS', 'settings:qr')), require_notif: CFG.REQUIRE_NOTIF } });
}));
app.post('/admin/api/orders/:id/:act', adminAuth, ah(async (req, res) => {
  const o = await getO(req.params.id);
  if (!o) return res.status(404).json({ ok: false });
  const act = req.params.act;
  if (act === 'approve') {
    o.proof_ok = true; o.flag = null; o.manual = true;
    if (o.status === 'expired' || o.status === 'rejected') o.status = 'pending';
    if (o.proof && o.proof.info && o.proof.info.refs) for (const x of o.proof.info.refs) await R('SET', 'ref:' + x, o.id, 'NX');
    await putO(o);
    await refresh(o);
  } else if (act === 'reject') {
    o.status = 'rejected';
    await putO(o);
  } else if (act === 'resend' && o.status === 'paid') {
    await sendCallback(o);
  } else return res.status(400).json({ ok: false });
  res.json({ ok: true, status: o.status });
}));
app.post('/admin/api/settings', adminAuth, ah(async (req, res) => {
  const q = req.body.qr;
  if (typeof q === 'string' && q.startsWith('data:image/')) {
    const raw = Buffer.from(q.split(',')[1] || '', 'base64');
    const png = await sharp(raw).resize({ width: 700, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    await R('SET', 'settings:qr', png.toString('base64'));
  }
  res.json({ ok: true });
}));
app.get('/admin/proof/:f', adminAuth, ah(async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.f)) return res.status(400).end();
  const b = await R('GET', 'img:' + req.params.f);
  if (!b) return res.status(404).end();
  res.set('content-type', 'image/jpeg').send(Buffer.from(b, 'base64'));
}));

/* ===================== HALAMAN ===================== */
const STYLE = `
:root{--ink:#0e2a47;--paper:#f2f6fa;--line:#d5e0eb;--blue:#0f7fd6;--ok:#12805c;--warn:#a55b00;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:460px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0 0 14px}
.total{background:var(--ink);color:#fff;border-radius:14px;padding:20px 18px;margin-bottom:14px}
.total small{display:block;opacity:.75;font-size:14px}
.total b{display:block;font-size:38px;line-height:1.15;letter-spacing:-.5px;margin:4px 0 8px}
.box{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.qr{display:block;width:100%;max-width:280px;margin:0 auto;border-radius:6px}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:600;background:#e6eef6}
.s-paid{background:#d8f1e8;color:var(--ok)}.s-flagged,.s-proof_ok,.s-notif_matched{background:#ffecd0;color:var(--warn)}.s-rejected,.s-expired{background:#fbdcd9;color:var(--bad)}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 16px;background:var(--blue);color:#fff;cursor:pointer;width:100%}
button.sec{background:#e6eef6;color:var(--ink)}button.bad{background:var(--bad)}button:disabled{opacity:.5}
input[type=file],input[type=password]{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff;font:inherit;margin-bottom:10px}
ul{margin:8px 0 0;padding-left:18px}.err{color:var(--bad)}.muted{color:#5b7088;font-size:14px}
:focus-visible{outline:3px solid #7fc4ff;outline-offset:2px}
`;

const PAY_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pembayaran</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>Pembayaran</h1>
<div class="total"><small>Total yang harus dibayar</small><b id="total">-</b><small id="detail"></small></div>
<div class="box" id="qrbox"><img class="qr" id="qr" alt="QR pembayaran" hidden><p class="muted" id="noqr" hidden>QR belum diatur oleh admin.</p>
<p class="muted" style="margin:10px 0 0">Scan QR, lalu bayar persis sesuai total di atas, termasuk 3 digit terakhir. Nominal berbeda tidak akan terverifikasi.</p></div>
<div class="box"><span class="badge" id="badge">Memuat</span> <span class="muted" id="timer"></span><p id="msg" style="margin:8px 0 0"></p></div>
<div class="box" id="form" hidden><b>Upload bukti transfer</b>
<p class="muted">Screenshot asli dari aplikasi. Tanggal, jam, nominal dan status berhasil harus terlihat. Jangan diedit atau dipotong.</p>
<input type="file" id="file" accept="image/*"><button id="send">Kirim bukti</button>
<ul class="err" id="reasons"></ul></div>
</div><script>
var id=location.pathname.split('/').pop(),D=null,qrSet=false;
function $(s){return document.querySelector(s)}
function rp(n){return 'Rp'+Number(n).toLocaleString('id-ID')}
var MSG={pending:'Menunggu pembayaran dan bukti transfer.',notif_matched:'Dana sudah terdeteksi masuk. Upload bukti transfer untuk verifikasi.',proof_ok:'Bukti valid. Menunggu konfirmasi dana masuk.',flagged:'Bukti sedang ditinjau admin. Mohon tunggu.',paid:'Pembayaran berhasil. Terima kasih.',expired:'Waktu pembayaran habis. Buat pesanan baru.',rejected:'Pembayaran ditolak.'};
var LBL={pending:'Menunggu',notif_matched:'Dana masuk',proof_ok:'Bukti valid',flagged:'Ditinjau',paid:'Lunas',expired:'Kedaluwarsa',rejected:'Ditolak'};
async function load(){
  var r=await fetch('/api/pay/'+id);if(!r.ok){$('.wrap').textContent='Order tidak ditemukan.';return}
  D=await r.json();
  $('#total').textContent=rp(D.total);
  $('#detail').textContent=rp(D.amount)+' + kode unik '+D.code;
  if(D.qr){if(!qrSet){$('#qr').src='/api/qr';qrSet=true}$('#qr').hidden=false;$('#noqr').hidden=true}else{$('#noqr').hidden=false}
  $('#badge').textContent=LBL[D.status]||D.status;$('#badge').className='badge s-'+D.status;
  $('#msg').textContent=MSG[D.status]||'';
  var open=D.status==='pending'||D.status==='notif_matched';
  $('#form').hidden=!open;
  $('#qrbox').hidden=!(open||D.status==='proof_ok'||D.status==='flagged');
  tick();
}
function tick(){
  if(!D)return;var s=Math.max(0,Math.floor((D.expires-Date.now())/1000));
  var live=D.status==='pending'||D.status==='notif_matched';
  $('#timer').textContent=live?('Sisa waktu '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0')):'';
}
function shrink(f){return new Promise(function(res){var img=new Image(),u=URL.createObjectURL(f);img.onload=function(){var s=Math.min(1,1800/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=img.width*s;c.height=img.height*s;c.getContext('2d').drawImage(img,0,0,c.width,c.height);c.toBlob(function(b){res(b||f)},'image/jpeg',.9)};img.onerror=function(){res(f)};img.src=u})}
$('#send').onclick=async function(){
  var f=$('#file').files[0];if(!f){$('#reasons').innerHTML='<li>Pilih gambar dulu.</li>';return}
  var b=$('#send');b.disabled=true;b.textContent='Memverifikasi, mohon tunggu';$('#reasons').innerHTML='';
  if(f.size>4*1024*1024)f=await shrink(f);
  var fd=new FormData();fd.append('proof',f,'bukti.jpg');
  try{
    var r=await fetch('/api/pay/'+id+'/proof',{method:'POST',body:fd});var j=await r.json();
    if(!j.ok){(j.reasons||['Gagal.']).forEach(function(t){var li=document.createElement('li');li.textContent=t;$('#reasons').appendChild(li)})}
  }catch(e){var li=document.createElement('li');li.textContent='Koneksi gagal. Coba lagi.';$('#reasons').appendChild(li)}
  b.disabled=false;b.textContent='Kirim bukti';load();
};
load();setInterval(load,4000);setInterval(tick,1000);
</script></body></html>`;
app.get('/pay/:id', (req, res) => res.type('html').send(PAY_HTML));

const ADMIN_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Pembayaran</title><style>${STYLE}
.wrap{max-width:720px}.row{display:flex;gap:8px}.row button{width:auto;flex:1}img.proof{max-width:100%;max-height:420px;border-radius:8px;border:1px solid var(--line);margin-top:8px}
</style></head><body><div class="wrap">
<div id="login"><h1>Admin</h1><input type="password" id="pw" placeholder="Password admin"><button id="go">Masuk</button><p class="err" id="lerr"></p></div>
<div id="main" hidden><h1>Pembayaran</h1>
<div class="box"><b>QR pembayaran (DANA Bisnis)</b><p class="muted" id="qrstat"></p><input type="file" id="qrfile" accept="image/*"><button class="sec" id="qrsave">Simpan QR</button></div>
<p class="muted" id="info"></p><div id="list"></div></div>
</div><script>
var T=sessionStorage.getItem('t')||'';
function $(s){return document.querySelector(s)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function rp(n){return 'Rp'+Number(n).toLocaleString('id-ID')}
function wib(ts){return new Date(ts).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}
async function api(p,o){o=o||{};o.headers=Object.assign({'x-admin-token':T,'content-type':'application/json'},o.headers||{});var r=await fetch(p,o);if(r.status===401){sessionStorage.removeItem('t');T='';show();throw 0}return r.json()}
function show(){$('#login').hidden=!!T;$('#main').hidden=!T;if(T)load()}
$('#go').onclick=async function(){var r=await fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});var j=await r.json();if(j.ok){T=j.token;sessionStorage.setItem('t',T);show()}else{$('#lerr').textContent=j.error||'Password salah.'}};
function toDataUrl(f,cb){var img=new Image(),u=URL.createObjectURL(f);img.onload=function(){var s=Math.min(1,800/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=img.width*s;c.height=img.height*s;c.getContext('2d').drawImage(img,0,0,c.width,c.height);cb(c.toDataURL('image/png'))};img.src=u}
$('#qrsave').onclick=function(){var f=$('#qrfile').files[0];if(!f)return;toDataUrl(f,async function(d){await api('/admin/api/settings',{method:'POST',body:JSON.stringify({qr:d})});load()})};
async function act(id,a){if(a==='reject'&&!confirm('Tolak order ini?'))return;await api('/admin/api/orders/'+id+'/'+a,{method:'POST'});load()}
async function load(){
  var j=await api('/admin/api/orders');
  $('#qrstat').textContent=j.settings.qr?'QR sudah terpasang.':'QR belum diatur. Upload gambar QR dulu.';
  $('#info').textContent='Mode: '+(j.settings.require_notif?'bukti valid + notif HP wajib':'bukti valid cukup, notif HP sebagai konfirmasi tambahan');
  var h='';
  j.orders.forEach(function(o){
    h+='<div class="box"><b>'+esc(o.id)+'</b> <span class="badge s-'+esc(o.status)+'">'+esc(o.status)+'</span><br>'+rp(o.total)+' (dasar '+rp(o.amount)+')'+(o.ref?' · ref '+esc(o.ref):'')+'<br><span class="muted">'+wib(o.created)+' · notif HP: '+(o.notif?'masuk':'belum')+(o.via?' · lunas via '+esc(o.via):'')+(o.manual?' · disetujui manual':'')+(o.status==='paid'&&o.has_cb?' · callback: '+(o.callback_ok?'terkirim':'gagal'):'')+'</span>';
    if(o.proof){var i=o.proof.info||{};h+='<p class="muted">Terbaca di bukti: nominal '+esc((i.amounts||[]).join(', '))+' · waktu '+esc(i.datetime||'-')+' · ref '+esc((i.refs||[]).join(', ')||'-')+(i.ela!=null?' · ELA '+esc(i.ela):'')+'</p><img class="proof" src="/admin/proof/'+encodeURIComponent(o.proof.file)+'?t='+encodeURIComponent(T)+'" alt="bukti">'}
    if(o.flag){h+='<ul class="err">'+o.flag.map(function(f){return '<li>'+esc(f)+'</li>'}).join('')+'</ul>'}
    if(['flagged','proof_ok','notif_matched','pending','expired'].indexOf(o.status)>-1){h+='<div class="row" style="margin-top:10px"><button onclick="act(\\''+esc(o.id)+'\\',\\'approve\\')">Setujui</button><button class="bad" onclick="act(\\''+esc(o.id)+'\\',\\'reject\\')">Tolak</button></div>'}
    if(o.status==='paid'&&o.has_cb&&!o.callback_ok){h+='<div class="row" style="margin-top:10px"><button class="sec" onclick="act(\\''+esc(o.id)+'\\',\\'resend\\')">Kirim ulang callback</button></div>'}
    h+='</div>';
  });
  $('#list').innerHTML=h||'<p class="muted">Belum ada order. Buat lewat API.</p>';
}
show();setInterval(function(){if(T)load()},8000);
</script></body></html>`;
app.get('/admin', (req, res) => res.type('html').send(ADMIN_HTML));

app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PEDIA PAY</title><style>${STYLE}pre{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:13px}</style></head><body><div class="wrap"><h1>PEDIA PAY API</h1>
<p>Buat order:</p><pre>curl -X POST ${base(req)}/api/v1/orders \\
 -H "x-api-key: API_KEY" -H "content-type: application/json" \\
 -d '{"amount":15000,"ref":"INV-001","callback_url":"https://bot.kamu/callback"}'</pre>
<p>Cek status:</p><pre>GET /api/v1/orders/:order_id   (header x-api-key)</pre>
<p>Notif HP (dari MacroDroid/Tasker/Automate):</p><pre>POST /api/notif   (header x-notif-secret)
{"title":"DANA","text":"Kamu menerima Rp15.123 dari ..."}</pre>
<p>Callback lunas berisi header <code>x-signature</code> = HMAC-SHA256(body, API_KEY).</p>
<p><a href="/admin">Panel admin</a></p></div></body></html>`));

module.exports = app;
if (require.main === module) app.listen(CFG.PORT, () => console.log('PEDIA PAY jalan di port ' + CFG.PORT));
