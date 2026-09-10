// ============================================================
// API DASHBOARD ADMIN — dipakai oleh index.html
// Semua request: POST { action: '...', ...payload }
// Header: x-admin-token (kecuali action 'login')
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function makeToken(password) {
  return crypto.createHash('sha256').update(password + (process.env.ADMIN_SECRET || 'gmailid-secret')).digest('hex');
}
function checkAuth(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  return token === makeToken(process.env.ADMIN_PASSWORD || '');
}

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const body = req.body || {};
  const action = body.action;

  if (action === 'login') {
    if (body.password === (process.env.ADMIN_PASSWORD || '')) {
      return res.status(200).json({ ok: true, token: makeToken(body.password) });
    }
    return res.status(401).json({ ok: false, error: 'Password salah' });
  }

  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    switch (action) {
      case 'stats': return res.json({ ok: true, data: await getStats() });
      case 'listProducts': return res.json({ ok: true, data: await listProducts() });
      case 'saveProduct': return res.json({ ok: true, data: await saveProduct(body.product) });
      case 'deleteProduct': return res.json({ ok: true, data: await deleteProduct(body.id) });
      case 'listStock': return res.json({ ok: true, data: await listStock(body.product_id, body.onlyUnsold) });
      case 'addStock': return res.json({ ok: true, data: await addStock(body.product_id, body.lines) });
      case 'deleteStockItem': return res.json({ ok: true, data: await deleteStockItem(body.id) });
      case 'listTransactions': return res.json({ ok: true, data: await listTransactions(body.status, body.page || 0) });
      case 'listUsers': return res.json({ ok: true, data: await listUsers(body.search, body.page || 0) });
      case 'adjustSaldo': return res.json({ ok: true, data: await adjustSaldo(body.tg_id, body.amount, body.note) });
      case 'getSettings': return res.json({ ok: true, data: await getSettings() });
      case 'saveSettings': return res.json({ ok: true, data: await saveSettings(body.settings) });
      case 'broadcast': return res.json({ ok: true, data: await broadcast(body.text) });
      default: return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    console.error('admin.js error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};

// ---------------- IMPLEMENTASI ----------------
async function getStats() {
  const [{ count: totalUsers }, { count: totalProducts }, { count: totalStockUnsold }, { count: totalTxSuccess }, { count: totalTxPending }] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('products').select('id', { count: 'exact', head: true }),
    supabase.from('stock_items').select('id', { count: 'exact', head: true }).eq('is_sold', false),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('status', 'success'),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  ]);
  const { data: revenueRows } = await supabase.from('transactions').select('total').eq('status', 'success');
  const revenue = (revenueRows || []).reduce((a, b) => a + (b.total || 0), 0);
  return { totalUsers, totalProducts, totalStockUnsold, totalTxSuccess, totalTxPending, revenue };
}

async function listProducts() {
  const { data: products } = await supabase.from('products').select('*').order('sort_order', { ascending: true });
  const withStock = await Promise.all((products || []).map(async p => {
    const { count } = await supabase.from('stock_items').select('id', { count: 'exact', head: true }).eq('product_id', p.id).eq('is_sold', false);
    return { ...p, stock: count || 0 };
  }));
  return withStock;
}

async function saveProduct(p) {
  const payload = {
    name: p.name, description: p.description || '', price: p.price,
    grosir: p.grosir || [], warranty_hours: p.warranty_hours || 24,
    active: p.active !== false, sort_order: p.sort_order || 0
  };
  if (p.id) {
    const { data } = await supabase.from('products').update(payload).eq('id', p.id).select().single();
    return data;
  }
  const { data } = await supabase.from('products').insert(payload).select().single();
  return data;
}
async function deleteProduct(id) {
  await supabase.from('stock_items').delete().eq('product_id', id);
  await supabase.from('products').delete().eq('id', id);
  return { deleted: true };
}

async function listStock(productId, onlyUnsold) {
  let q = supabase.from('stock_items').select('*').eq('product_id', productId).order('created_at', { ascending: false }).limit(500);
  if (onlyUnsold) q = q.eq('is_sold', false);
  const { data } = await q;
  return data || [];
}

async function addStock(productId, linesText) {
  const lines = (linesText || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { inserted: 0 };
  const rows = lines.map(content => ({ product_id: productId, content }));
  await supabase.from('stock_items').insert(rows);

  const { data: product } = await supabase.from('products').select('*').eq('id', productId).single();
  const { count: totalReady } = await supabase.from('stock_items').select('id', { count: 'exact', head: true }).eq('product_id', productId).eq('is_sold', false);

  const { data: settingsRows } = await supabase.from('settings').select('key,value');
  const settings = {}; (settingsRows || []).forEach(r => settings[r.key] = r.value);
  if (settings.auto_post_stock === 'true' && settings.channel_link) {
    await tg('sendMessage', {
      chat_id: '@' + settings.channel_link.split('/').pop(),
      text: `----➤ Stok <b>${product.name}</b> baru masuk +${lines.length} nih! Total ready <b>${totalReady}</b> akun. Yuk sikat sebelum ludes! 🎗️`,
      parse_mode: 'HTML'
    }).catch(() => {});
  }
  return { inserted: lines.length, totalReady };
}
async function deleteStockItem(id) {
  await supabase.from('stock_items').delete().eq('id', id).eq('is_sold', false);
  return { deleted: true };
}

async function listTransactions(status, page) {
  let q = supabase.from('transactions').select('*').order('created_at', { ascending: false }).range(page * 50, page * 50 + 49);
  if (status) q = q.eq('status', status);
  const { data } = await q;
  return data || [];
}

async function listUsers(search, page) {
  let q = supabase.from('users').select('*').order('created_at', { ascending: false }).range(page * 50, page * 50 + 49);
  if (search) q = q.or(`username.ilike.%${search}%,fullname.ilike.%${search}%,tg_id.eq.${isNaN(search) ? 0 : search}`);
  const { data } = await q;
  return data || [];
}
async function adjustSaldo(tgId, amount, note) {
  const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();
  const newSaldo = Math.max(0, user.saldo + amount);
  await supabase.from('users').update({ saldo: newSaldo }).eq('tg_id', tgId);
  await supabase.from('mutations').insert({ user_tg_id: tgId, type: amount >= 0 ? 'credit' : 'debit', amount: Math.abs(amount), note: note || 'Penyesuaian oleh admin' });
  await tg('sendMessage', { chat_id: tgId, text: `ℹ️ Saldo Anda disesuaikan oleh admin sebesar Rp${Math.abs(amount).toLocaleString('id-ID')} (${amount >= 0 ? 'ditambah' : 'dikurangi'}).\nSaldo sekarang: Rp${newSaldo.toLocaleString('id-ID')}` }).catch(() => {});
  return { newSaldo };
}

async function getSettings() {
  const { data } = await supabase.from('settings').select('key,value');
  const obj = {}; (data || []).forEach(r => obj[r.key] = r.value);
  return obj;
}
async function saveSettings(settings) {
  const rows = Object.entries(settings || {}).map(([key, value]) => ({ key, value: String(value) }));
  if (rows.length) await supabase.from('settings').upsert(rows);
  return { saved: rows.length };
}

async function broadcast(text) {
  if (!text) return { sent: 0 };
  const { data: users } = await supabase.from('users').select('tg_id').eq('is_blocked', false);
  let sent = 0, failed = 0;
  // Kirim berurutan dengan jeda kecil supaya tidak kena rate limit Telegram (~30 pesan/detik).
  for (const u of (users || [])) {
    try {
      const r = await tg('sendMessage', { chat_id: u.tg_id, text, parse_mode: 'HTML' });
      if (r.ok) sent++; else failed++;
    } catch (_) { failed++; }
  }
  return { sent, failed, total: (users || []).length };
}
