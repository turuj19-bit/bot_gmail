// ============================================================
// GMAIL ID BOT — Telegram webhook + Midtrans payment notification
// Satu file ini menangani DUA hal (dibedakan dari bentuk payload):
//   1) Update dari Telegram (body.message / body.callback_query)
//   2) Notifikasi status pembayaran dari Midtrans (body.order_id + body.transaction_status)
// URL webhook Telegram & Midtrans SAMA: https://<domain-anda>/api/bot
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const midtransClient = require('midtrans-client');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_CHAT_ID = process.env.ADMIN_TG_ID || null; // opsional: chat_id admin utk notifikasi order masuk

const coreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// ---------------- SETTINGS (cache ringan per-invocation) ----------------
let _settingsCache = null;
async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const { data } = await supabase.from('settings').select('key,value');
  const obj = {};
  (data || []).forEach(r => { obj[r.key] = r.value; });
  _settingsCache = obj;
  return obj;
}

// ---------------- HELPER TELEGRAM ----------------
async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}
const tgSend = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const tgSendPhoto = (chatId, photo, extra = {}) =>
  tg('sendPhoto', { chat_id: chatId, photo, parse_mode: 'HTML', ...extra });
const tgEdit = (chatId, messageId, text, extra = {}) =>
  tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const tgAnswerCb = (id, text, showAlert = false) =>
  tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });

// ---------------- FORMAT ----------------
const rp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');
function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/\./g, ':').replace(',', '');
}
function fmtDateShort(d) {
  const dt = new Date(d);
  return dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\./g, ':').replace(',', '');
}
function maskUsername(u) {
  if (!u) return 'User' + Math.floor(Math.random() * 900 + 100);
  if (u.length <= 2) return '@' + u[0] + '*';
  return '@' + u.slice(0, 2) + '*'.repeat(Math.max(1, u.length - 2));
}

// ---------------- USER & SESSION ----------------
async function getOrCreateUser(tgUser) {
  const { data: existing } = await supabase.from('users').select('*').eq('tg_id', tgUser.id).maybeSingle();
  if (existing) {
    await supabase.from('users').update({
      username: tgUser.username || null,
      fullname: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '),
      last_seen_at: new Date().toISOString()
    }).eq('tg_id', tgUser.id);
    return existing;
  }
  const { data: created } = await supabase.from('users').insert({
    tg_id: tgUser.id,
    username: tgUser.username || null,
    fullname: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '),
    saldo: 0
  }).select().single();
  await supabase.rpc('noop').catch(() => {}); // no-op guard (aman kalau rpc tak ada)
  await incrStat('total_users', 1);
  return created;
}
async function incrStat(key, by) {
  const { data } = await supabase.from('stats_counter').select('value').eq('key', key).maybeSingle();
  const val = (data ? data.value : 0) + by;
  await supabase.from('stats_counter').upsert({ key, value: val });
}
async function getStat(key) {
  const { data } = await supabase.from('stats_counter').select('value').eq('key', key).maybeSingle();
  return data ? data.value : 0;
}
async function getSession(tgId) {
  const { data } = await supabase.from('bot_sessions').select('*').eq('tg_id', tgId).maybeSingle();
  return data || { tg_id: tgId, state: null, context: {} };
}
async function setSession(tgId, state, context) {
  await supabase.from('bot_sessions').upsert({ tg_id: tgId, state, context: context || {}, updated_at: new Date().toISOString() });
}

// ---------------- PRODUCTS ----------------
async function getActiveProducts() {
  const { data } = await supabase.from('products').select('*').eq('active', true).order('sort_order', { ascending: true });
  return data || [];
}
async function getProduct(id) {
  const { data } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  return data;
}
async function getStockCount(productId) {
  const { count } = await supabase.from('stock_items').select('id', { count: 'exact', head: true }).eq('product_id', productId).eq('is_sold', false);
  return count || 0;
}
function unitPriceFor(product, qty) {
  let price = product.price;
  const tiers = Array.isArray(product.grosir) ? product.grosir : [];
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  for (const t of sorted) { if (qty >= t.min) { price = t.price; break; } }
  return price;
}
async function calcTotal(subtotal) {
  const s = await getSettings();
  const adminFeePct = parseFloat(s.admin_fee_percent || '0');
  const qrisFeePct = parseFloat(s.qris_fee_percent || '0.7');
  const fee = Math.ceil(subtotal * ((adminFeePct + qrisFeePct) / 100));
  return { fee, total: subtotal + fee, adminFeePct };
}

// ---------------- RENDER: MAIN MENU ----------------
async function renderMainMenu(user) {
  const s = await getSettings();
  const totalUsers = await getStat('total_users');
  const totalTx = await getStat('total_tx_success');
  const totalItem = await getStat('total_item_terjual');
  const welcome = (s.welcome_text || 'Selamat datang di ✨ {bot_username} ✨').replace('{bot_username}', s.bot_username || '');
  const text =
    `${welcome}\n` +
    `${'─'.repeat(28)}\n\n` +
    `💰 Saldo Anda: <b>${rp(user.saldo)}</b>\n\n` +
    `👥 Total pengguna: ${totalUsers}\n` +
    `📊 Total transaksi sukses: ${totalTx}\n` +
    `📦 Total item terjual: ${totalItem}\n\n` +
    `Klik tombol di bawah untuk membeli 👇`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🛍️ Beli Akun', callback_data: 'buy:open' }],
      [{ text: '➕ Isi Saldo', callback_data: 'topup:open' }],
      [{ text: '📋 Riwayat', callback_data: 'main:history' }, { text: '📈 Mutasi', callback_data: 'main:mutasi' }],
      [{ text: '🛡️ Claim Garansi', callback_data: 'main:garansi' }],
      [{ text: '💬 Hubungi Admin', url: s.admin_link || 't.me/' }, { text: '📣 Channel', url: s.channel_link || 't.me/' }]
    ]
  };
  return { text, keyboard, photo: s.banner_url };
}

async function sendMainMenu(chatId, user) {
  const m = await renderMainMenu(user);
  if (m.photo) return tgSendPhoto(chatId, m.photo, { caption: m.text, reply_markup: m.keyboard });
  return tgSend(chatId, m.text, { reply_markup: m.keyboard });
}
async function editToMainMenu(chatId, messageId, user) {
  const m = await renderMainMenu(user);
  // Pesan sebelumnya bisa berupa foto (caption) atau teks biasa — coba caption dulu.
  const r = await tg('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: m.text, parse_mode: 'HTML', reply_markup: m.keyboard });
  if (!r.ok) await tgEdit(chatId, messageId, m.text, { reply_markup: m.keyboard });
}

// ---------------- RENDER: BELI AKUN ----------------
async function renderBuyScreen(session) {
  const products = await getActiveProducts();
  if (!products.length) return { text: 'Belum ada produk tersedia saat ini.', keyboard: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'back:main' }]] } };
  let ctx = session.context || {};
  let product = products.find(p => p.id === ctx.product_id) || products[0];
  if (!ctx.product_id) ctx = { product_id: product.id, qty: 1 };
  if (!ctx.qty) ctx.qty = 1;
  const stock = await getStockCount(product.id);
  const unit = unitPriceFor(product, ctx.qty);
  const tiers = Array.isArray(product.grosir) ? product.grosir : [];
  const grosirLine = tiers.length
    ? '📊 Diskon Grosir: ' + tiers.sort((a, b) => a.min - b.min).map(t => `• ≥${t.min}: ${rp(t.price)}`).join(' | ') + '\n'
    : '';

  const s = await getSettings();
  const text =
    `✨ ${s.bot_username || ''} ✨\n${'─'.repeat(24)}\n\n` +
    `📦 Produk: <b>${product.name}</b>\n` +
    `📝 Deskripsi:\n${product.description || '-'}\n\n` +
    `💰 Harga saat ini <b>${rp(unit)}</b>/akun\n\n` +
    grosirLine +
    `📦 Stok: <b>${stock}</b> akun\n\n` +
    (s.channel_link ? `👤 <a href="${s.channel_link}">Klik disini untuk info update & testimoni</a>` : '');

  const prodRow = products.map(p => ({
    text: (p.id === product.id ? '✅ ' : '') + p.name + (p.id === product.id ? ' ✅' : ''),
    callback_data: `buy:selprod:${p.id}`
  }));
  const prodRows = [];
  for (let i = 0; i < prodRow.length; i += 2) prodRows.push(prodRow.slice(i, i + 2));

  const qtyPresets = [1, 5, 10, 20, 50, 100, 200, 300, 400, 500];
  const qtyBtns = qtyPresets.map(n => ({
    text: (n === ctx.qty ? '✅ ' : '') + n + ' akun' + (n === ctx.qty ? ' ✅' : ''),
    callback_data: `buy:selqty:${n}`
  }));
  const qtyRows = [];
  for (let i = 0; i < qtyBtns.length; i += 2) qtyRows.push(qtyBtns.slice(i, i + 2));

  const totalNow = unit * ctx.qty;
  const keyboard = {
    inline_keyboard: [
      ...prodRows,
      [{ text: '━━━ 📊 Pilih Jumlah ━━━', callback_data: 'noop' }],
      ...qtyRows,
      [{ text: '✏️ Input Manual', callback_data: 'buy:manualqty' }],
      [{ text: `💳 BAYAR ${rp(totalNow)} untuk ${ctx.qty} akun`, callback_data: 'buy:goconfirm' }],
      [{ text: '⬅️ Kembali', callback_data: 'back:main' }]
    ]
  };
  return { text, keyboard, ctx, product };
}

async function showBuyScreen(chatId, messageId, tgId) {
  const session = await getSession(tgId);
  const r = await renderBuyScreen(session);
  await setSession(tgId, 'buy_menu', r.ctx || session.context);
  const edited = await tg('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: r.text, parse_mode: 'HTML', reply_markup: r.keyboard });
  if (!edited.ok) await tgEdit(chatId, messageId, r.text, { reply_markup: r.keyboard });
}

// ---------------- RENDER: KONFIRMASI PEMBELIAN ----------------
async function showConfirmScreen(chatId, messageId, user, session) {
  const ctx = session.context;
  const product = await getProduct(ctx.product_id);
  const stock = await getStockCount(product.id);
  if (ctx.qty > stock) {
    await tgEdit(chatId, messageId, `⚠️ Stok tidak mencukupi. Sisa stok: ${stock} akun.`, {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'buy:open' }]] }
    });
    return;
  }
  const unit = unitPriceFor(product, ctx.qty);
  const subtotal = unit * ctx.qty;
  const text =
    `🛒 <b>Konfirmasi Pembelian</b>\n${'─'.repeat(24)}\n\n` +
    `📦 <b>${product.name}</b>\n` +
    `📝 ${product.description || '-'}\n` +
    `📊 Jumlah: ${ctx.qty} akun\n` +
    `💰 Total: <b>${rp(subtotal)}</b>\n` +
    `💼 Saldo: ${rp(user.saldo)}\n${'─'.repeat(24)}\n\n` +
    `Pilih metode pembayaran:`;
  const rows = [];
  if (user.saldo < subtotal) {
    rows.push([{ text: '💰 Saldo Kurang (Isi Dulu)', callback_data: 'topup:open' }]);
  } else {
    rows.push([{ text: '💰 Bayar Saldo', callback_data: 'buy:pay:saldo' }]);
  }
  rows.push([{ text: '💳 Bayar QRIS', callback_data: 'buy:pay:qris' }]);
  rows.push([{ text: '⬅️ Kembali', callback_data: 'buy:open' }]);
  await tgEdit(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
}

// ---------------- RENDER: ISI SALDO ----------------
async function showTopupScreen(chatId, messageId, user) {
  const text =
    `➕ <b>ISI SALDO</b>\n${'─'.repeat(24)}\n\n` +
    `💰 Saldo saat ini: <b>${rp(user.saldo)}</b>\n\n` +
    `Silakan pilih nominal deposit saldo:`;
  const amounts = [1000, 5000, 10000, 15000, 20000, 25000, 30000, 50000, 100000, 200000, 500000, 1000000];
  const labels = { 1000: '1k', 5000: '5k', 10000: '10k', 15000: '15k', 20000: '20k', 25000: '25k', 30000: '30k', 50000: '50k', 100000: '100k', 200000: '200k', 500000: '500k', 1000000: '1jt' };
  const btns = amounts.map(a => ({ text: labels[a], callback_data: `topup:amount:${a}` }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  rows.push([{ text: '⬅️ Kembali', callback_data: 'back:main' }]);
  const edited = await tg('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  if (!edited.ok) await tgEdit(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
}

// ---------------- RIWAYAT / MUTASI / GARANSI ----------------
async function showHistory(chatId, messageId, tgId) {
  const { data } = await supabase.from('transactions').select('*').eq('user_tg_id', tgId).order('created_at', { ascending: false }).limit(10);
  let text = `📋 <b>Riwayat 10 Transaksi Terakhir</b>\n${'─'.repeat(24)}\n\n`;
  if (!data || !data.length) {
    text += 'Belum ada transaksi.';
  } else {
    const icon = { pending: '⏳', success: '✅', failed: '❌', expired: '⌛' };
    text += data.map(t => {
      const label = t.type === 'purchase' ? 'Beli' : 'Top Up';
      return `${icon[t.status] || '•'} <b>${label}</b> | ${rp(t.total)}\n📅 ${fmtDateShort(t.created_at)} | ${t.status}`;
    }).join('\n\n');
  }
  await tgEdit(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'back:main' }]] } });
}
async function showMutasi(chatId, messageId, tgId) {
  const { data } = await supabase.from('mutations').select('*').eq('user_tg_id', tgId).order('created_at', { ascending: false }).limit(10);
  let text = `📈 <b>Mutasi Saldo</b>\n${'─'.repeat(24)}\n\n`;
  text += (!data || !data.length) ? '📭 Belum ada mutasi.' :
    data.map(m => `${m.type === 'credit' ? '➕' : '➖'} ${rp(m.amount)} — ${m.note || '-'}\n📅 ${fmtDateShort(m.created_at)}`).join('\n\n');
  await tgEdit(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'back:main' }]] } });
}
async function showGaransi(chatId, messageId, tgId) {
  const { data } = await supabase.from('transactions').select('*').eq('user_tg_id', tgId).eq('type', 'purchase').eq('status', 'success').gt('warranty_until', new Date().toISOString()).order('created_at', { ascending: false });
  let text = `🛡️ <b>KOMPLAIN / GARANSI</b>\n${'─'.repeat(24)}\n\n`;
  const rows = [];
  if (!data || !data.length) {
    text += 'Tidak ada pembelian yang masih dalam masa garansi.\n\nJika ada masalah lain, silakan hubungi admin langsung.';
  } else {
    text += data.map(t => `📦 ${t.product_name} x${t.qty} — ID: <code>${t.id.slice(0, 8)}</code>\n⏳ Garansi s/d ${fmtDate(t.warranty_until)}`).join('\n\n');
  }
  const s = await getSettings();
  rows.push([{ text: '💬 Hubungi Admin', url: s.admin_link || 't.me/' }]);
  rows.push([{ text: '⬅️ Kembali', callback_data: 'back:main' }]);
  await tgEdit(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
}

// ---------------- MIDTRANS: BUAT TAGIHAN QRIS ----------------
async function createQrisInvoice({ chatId, messageId, user, type, product, qty, subtotal }) {
  const s = await getSettings();
  const { fee, total, adminFeePct } = await calcTotal(subtotal);
  const orderId = `${type === 'purchase' ? 'PUR' : 'TOP'}-${Date.now()}-${user.tg_id}`;
  const timeoutMin = parseInt(s.qris_timeout_minutes || '10', 10);

  let charge;
  try {
    charge = await coreApi.charge({
      payment_type: 'qris',
      transaction_details: { order_id: orderId, gross_amount: total },
      custom_expiry: { expiry_duration: timeoutMin, unit: 'minute' }
    });
  } catch (e) {
    await tgSend(chatId, '⚠️ Gagal membuat tagihan QRIS. Silakan coba lagi beberapa saat lagi.');
    return;
  }
  const qrAction = (charge.actions || []).find(a => a.name === 'generate-qr-code');
  const qrUrl = qrAction ? qrAction.url : null;
  const expiresAt = new Date(Date.now() + timeoutMin * 60000).toISOString();

  const { data: tx } = await supabase.from('transactions').insert({
    user_tg_id: user.tg_id,
    type,
    product_id: product ? product.id : null,
    product_name: product ? product.name : 'Top Up Saldo',
    qty: qty || 1,
    unit_price: product ? unitPriceFor(product, qty) : subtotal,
    amount: subtotal,
    admin_fee: fee,
    total,
    status: 'pending',
    pay_method: 'qris',
    midtrans_order_id: orderId,
    expires_at: expiresAt
  }).select().single();

  const label = type === 'purchase' ? `Produk: ${product.name}\n📝 Jumlah: ${qty} akun\n💰 Harga: ${rp(subtotal)}` : `Produk: Top Up Saldo\n💰 Nominal: ${rp(subtotal)}`;
  const invoiceText =
    `🧾 <b>TAGIHAN PEMBAYARAN</b>\n${'─'.repeat(24)}\n\n` +
    `💳 Metode: QRIS\n` +
    `📦 ${label}\n` +
    `💸 Admin Fee: ${adminFeePct}%\n` +
    `💵 Total Bayar: <b>${rp(total)}</b>\n` +
    `📅 Cetak: ${fmtDate(new Date())}\n` +
    `🆔 ID: <code>${tx.id}</code>\n${'─'.repeat(24)}\n\n` +
    `Scan QRIS di atas untuk ${type === 'purchase' ? 'membayar' : 'mengisi saldo'}.\n` +
    `⏰ Batas waktu: ${timeoutMin} menit`;

  const keyboard = { inline_keyboard: [[{ text: '🔄 Cek Status Pembayaran', callback_data: `check:${tx.id}` }]] };
  if (qrUrl) {
    await tgSendPhoto(chatId, qrUrl, { caption: invoiceText, reply_markup: keyboard });
  } else {
    await tgSend(chatId, invoiceText, { reply_markup: keyboard });
  }
}

// ---------------- PROSES SUKSES ----------------
async function processSuccessTopup(tx) {
  await supabase.from('transactions').update({ status: 'success', paid_at: new Date().toISOString() }).eq('id', tx.id);
  const { data: user } = await supabase.from('users').select('*').eq('tg_id', tx.user_tg_id).single();
  const newSaldo = user.saldo + tx.amount;
  await supabase.from('users').update({ saldo: newSaldo }).eq('tg_id', tx.user_tg_id);
  await supabase.from('mutations').insert({ user_tg_id: tx.user_tg_id, type: 'credit', amount: tx.amount, note: 'Top up saldo via QRIS' });
  await tgSend(tx.user_tg_id, `✅ <b>Top up berhasil!</b>\n\n💰 Saldo ditambahkan: ${rp(tx.amount)}\n💼 Saldo sekarang: <b>${rp(newSaldo)}</b>`);
}

async function processSuccessPurchase(tx, viaSaldo) {
  const product = await getProduct(tx.product_id);
  const { data: items } = await supabase.from('stock_items').select('*').eq('product_id', tx.product_id).eq('is_sold', false).order('created_at', { ascending: true }).limit(tx.qty);
  if (!items || items.length < tx.qty) {
    await supabase.from('transactions').update({ status: 'failed' }).eq('id', tx.id);
    await tgSend(tx.user_tg_id, `⚠️ Maaf, stok <b>${product.name}</b> habis saat proses pengiriman. Dana Anda akan dikembalikan oleh admin. Mohon hubungi admin dengan ID transaksi: <code>${tx.id}</code>`);
    return;
  }
  const ids = items.map(i => i.id);
  await supabase.from('stock_items').update({ is_sold: true, sold_to: tx.user_tg_id, transaction_id: tx.id, sold_at: new Date().toISOString() }).in('id', ids);

  const warrantyUntil = new Date(Date.now() + (product.warranty_hours || 24) * 3600000).toISOString();
  await supabase.from('transactions').update({ status: 'success', paid_at: new Date().toISOString(), warranty_until: warrantyUntil }).eq('id', tx.id);

  if (viaSaldo) {
    await supabase.from('mutations').insert({ user_tg_id: tx.user_tg_id, type: 'debit', amount: tx.total, note: `Pembelian ${product.name} x${tx.qty}` });
  }
  await incrStat('total_tx_success', 1);
  await incrStat('total_item_terjual', tx.qty);

  const akunText = items.map((it, i) => `${i + 1}. <code>${it.content}</code>`).join('\n');
  await tgSend(tx.user_tg_id,
    `✅ <b>Pembelian berhasil!</b>\n\n📦 ${product.name} x${tx.qty}\n${'─'.repeat(24)}\n${akunText}\n${'─'.repeat(24)}\n` +
    `🛡️ Garansi s/d: ${fmtDate(warrantyUntil)}\n\nSimpan data akun di atas baik-baik.`
  );

  const s = await getSettings();
  if (s.auto_post_testimoni === 'true' && s.channel_link) {
    const { data: buyer } = await supabase.from('users').select('username').eq('tg_id', tx.user_tg_id).maybeSingle();
    await tg('sendMessage', {
      chat_id: '@' + s.channel_link.split('/').pop(),
      text: `🎗️ <b>TESTIMONI PEMBELIAN</b>\n${'─'.repeat(24)}\n\n👤 Pembeli: ${maskUsername(buyer && buyer.username)}\n📦 Produk: ${product.name}\n📝 Jumlah: ${tx.qty} pcs\n${'─'.repeat(24)}\n\nTerima kasih sudah berbelanja! 🤝`,
      parse_mode: 'HTML'
    }).catch(() => {});
  }
}

// ---------------- ROUTER: TELEGRAM UPDATE ----------------
async function handleTelegramUpdate(body) {
  if (body.message) return handleMessage(body.message);
  if (body.callback_query) return handleCallback(body.callback_query);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const user = await getOrCreateUser(msg.from);
  const text = (msg.text || '').trim();

  if (text === '/start') {
    await setSession(msg.from.id, null, {});
    return sendMainMenu(chatId, user);
  }

  const session = await getSession(msg.from.id);
  if (session.state === 'awaiting_manual_qty') {
    const n = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (!n || n < 1) {
      return tgSend(chatId, '⚠️ Masukkan jumlah akun berupa angka, contoh: 25');
    }
    const ctx = { ...session.context, qty: n };
    await setSession(msg.from.id, 'buy_menu', ctx);
    const r = await renderBuyScreen({ context: ctx });
    return tgSend(chatId, r.text, { reply_markup: r.keyboard });
  }

  // default: tampilkan menu utama biar user tidak nyasar
  return sendMainMenu(chatId, user);
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const tgId = cb.from.id;
  const data = cb.data;
  const user = await getOrCreateUser(cb.from);
  await tgAnswerCb(cb.id, '');

  if (data === 'noop') return;

  if (data === 'back:main') { await setSession(tgId, null, {}); return editToMainMenu(chatId, messageId, user); }

  if (data === 'buy:open') { await setSession(tgId, 'buy_menu', {}); return showBuyScreen(chatId, messageId, tgId); }
  if (data.startsWith('buy:selprod:')) {
    const session = await getSession(tgId);
    await setSession(tgId, 'buy_menu', { ...session.context, product_id: data.split(':')[2], qty: session.context.qty || 1 });
    return showBuyScreen(chatId, messageId, tgId);
  }
  if (data.startsWith('buy:selqty:')) {
    const session = await getSession(tgId);
    await setSession(tgId, 'buy_menu', { ...session.context, qty: parseInt(data.split(':')[2], 10) });
    return showBuyScreen(chatId, messageId, tgId);
  }
  if (data === 'buy:manualqty') {
    const session = await getSession(tgId);
    await setSession(tgId, 'awaiting_manual_qty', session.context);
    return tgEdit(chatId, messageId, '✏️ Ketik jumlah akun yang ingin dibeli (contoh: 25):', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Batal', callback_data: 'buy:open' }]] } }).catch(() => tgSend(chatId, '✏️ Ketik jumlah akun yang ingin dibeli (contoh: 25):'));
  }
  if (data === 'buy:goconfirm') {
    const session = await getSession(tgId);
    if (!session.context || !session.context.product_id) return;
    return showConfirmScreen(chatId, messageId, user, session);
  }
  if (data === 'buy:pay:saldo') {
    const session = await getSession(tgId);
    const product = await getProduct(session.context.product_id);
    const qty = session.context.qty;
    const stock = await getStockCount(product.id);
    if (qty > stock) return tgEdit(chatId, messageId, `⚠️ Stok tidak mencukupi. Sisa stok: ${stock} akun.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'buy:open' }]] } });
    const unit = unitPriceFor(product, qty);
    const subtotal = unit * qty;
    if (user.saldo < subtotal) return showConfirmScreen(chatId, messageId, user, session);
    await supabase.from('users').update({ saldo: user.saldo - subtotal }).eq('tg_id', tgId);
    const { data: tx } = await supabase.from('transactions').insert({
      user_tg_id: tgId, type: 'purchase', product_id: product.id, product_name: product.name,
      qty, unit_price: unit, amount: subtotal, admin_fee: 0, total: subtotal, status: 'pending', pay_method: 'saldo'
    }).select().single();
    await processSuccessPurchase(tx, true);
    await setSession(tgId, null, {});
    const updatedUser = await getOrCreateUser(cb.from);
    return editToMainMenu(chatId, messageId, updatedUser);
  }
  if (data === 'buy:pay:qris') {
    const session = await getSession(tgId);
    const product = await getProduct(session.context.product_id);
    const qty = session.context.qty;
    const stock = await getStockCount(product.id);
    if (qty > stock) return tgEdit(chatId, messageId, `⚠️ Stok tidak mencukupi. Sisa stok: ${stock} akun.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'buy:open' }]] } });
    const unit = unitPriceFor(product, qty);
    const subtotal = unit * qty;
    await createQrisInvoice({ chatId, messageId, user, type: 'purchase', product, qty, subtotal });
    return;
  }

  if (data === 'topup:open') { return showTopupScreen(chatId, messageId, user); }
  if (data.startsWith('topup:amount:')) {
    const amount = parseInt(data.split(':')[2], 10);
    return createQrisInvoice({ chatId, messageId, user, type: 'topup', product: null, qty: 1, subtotal: amount });
  }

  if (data === 'main:history') return showHistory(chatId, messageId, tgId);
  if (data === 'main:mutasi') return showMutasi(chatId, messageId, tgId);
  if (data === 'main:garansi') return showGaransi(chatId, messageId, tgId);

  if (data.startsWith('check:')) {
    const txId = data.split(':')[1];
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', txId).maybeSingle();
    if (!tx) return;
    if (tx.status !== 'pending') return tgAnswerCb(cb.id, `Status: ${tx.status}`, true);
    try {
      const status = await coreApi.transaction.status(tx.midtrans_order_id);
      await applyMidtransStatus(status);
      const { data: fresh } = await supabase.from('transactions').select('*').eq('id', txId).maybeSingle();
      return tgAnswerCb(cb.id, `Status: ${fresh.status}`, true);
    } catch (e) {
      return tgAnswerCb(cb.id, 'Belum ada pembayaran diterima.', true);
    }
  }
}

// ---------------- MIDTRANS NOTIFICATION ----------------
async function applyMidtransStatus(notif) {
  const orderId = notif.order_id;
  const { data: tx } = await supabase.from('transactions').select('*').eq('midtrans_order_id', orderId).maybeSingle();
  if (!tx || tx.status !== 'pending') return;

  const status = notif.transaction_status;
  const fraud = notif.fraud_status;

  if (status === 'settlement' || (status === 'capture' && fraud === 'accept')) {
    if (tx.type === 'topup') await processSuccessTopup(tx);
    else await processSuccessPurchase(tx, false);
  } else if (status === 'expire' || status === 'cancel' || status === 'deny') {
    await supabase.from('transactions').update({ status: status === 'expire' ? 'expired' : 'failed' }).eq('id', tx.id);
    await tgSend(tx.user_tg_id, `⌛ Tagihan <code>${tx.id}</code> telah ${status === 'expire' ? 'kedaluwarsa' : 'dibatalkan'}.`).catch(() => {});
  }
}

// ---------------- HANDLER UTAMA (export) ----------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(200).send('GMAIL ID BOT webhook aktif.'); return; }
  const body = req.body || {};
  try {
    if (body.order_id && body.transaction_status) {
      await applyMidtransStatus(body);
      return res.status(200).json({ ok: true });
    }
    if (body.message || body.callback_query) {
      await handleTelegramUpdate(body);
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('bot.js error:', err);
    return res.status(200).json({ ok: true }); // selalu 200 ke Telegram/Midtrans agar tidak retry storm
  }
};
