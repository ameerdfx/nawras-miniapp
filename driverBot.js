'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ══════════════════════════════════════════════
// 1. ENV VALIDATION
// ══════════════════════════════════════════════
const REQUIRED_ENV = [
  'DRIVER_BOT_TOKEN', 'MERCHANT_BOT_TOKEN', 'CUSTOMER_BOT_TOKEN',
  'SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_ID',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`ENV مفقود: ${key}`);
}

// ══════════════════════════════════════════════
// 2. CLIENTS
// ══════════════════════════════════════════════
const bot = new TelegramBot(process.env.DRIVER_BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 30 } },
});
const merchantBot = new TelegramBot(process.env.MERCHANT_BOT_TOKEN, { polling: false });
const customerBot = new TelegramBot(process.env.CUSTOMER_BOT_TOKEN, { polling: false });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ══════════════════════════════════════════════
// 3. CONFIG
// ══════════════════════════════════════════════
const CONFIG = Object.freeze({
  adminId:         String(process.env.ADMIN_ID),
  requiredChannel: process.env.REQUIRED_CHANNEL || '@order_iq1',
  supportUsername: process.env.SUPPORT_USERNAME || null,
});

const ACTIVE_STATUSES   = ['ready', 'on_the_way'];
const FINISHED_STATUSES = ['delivered', 'cancelled', 'rejected'];

const STATUS_TEXT = {
  pending:    'بانتظار قبول التاجر',
  accepted:   'مقبول من التاجر',
  preparing:  'قيد التحضير',
  ready:      'جاهز للاستلام',
  on_the_way: 'في الطريق',
  delivered:  'تم التسليم',
  cancelled:  'ملغي',
  rejected:   'مرفوض',
};

const STATUS_EMOJI = {
  pending: '⏳', accepted: '✅', preparing: '👨‍🍳',
  ready: '📦', on_the_way: '🛵', delivered: '🎉',
  cancelled: '❌', rejected: '⛔',
};

// ══════════════════════════════════════════════
// 4. SESSION STORE (TTL 60 min)
// ══════════════════════════════════════════════
const SESSION_TTL = 60 * 60 * 1000;
class SessionStore {
  #m = new Map();
  get(id) {
    const e = this.#m.get(String(id));
    if (!e || Date.now() - e.ts > SESSION_TTL) return null;
    return e.data;
  }
  set(id, data) { this.#m.set(String(id), { data, ts: Date.now() }); }
  del(id) { this.#m.delete(String(id)); }
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.#m) if (now - v.ts > SESSION_TTL) this.#m.delete(k);
    }, 15 * 60 * 1000);
  }
}
const sessions = new SessionStore();
sessions.startCleanup();

// ══════════════════════════════════════════════
// 5. UTILS
// ══════════════════════════════════════════════
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mapsUrl(lat, lng)  { return (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : '#'; }
function navUrl(lat, lng)   { return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`; }
function statusLabel(s)     { return `${STATUS_EMOJI[s] ?? ''} ${STATUS_TEXT[s] ?? s ?? 'غير معروف'}`; }
function formatAmount(n)    { return `${Number(n || 0).toLocaleString('ar-IQ')} د.ع`; }
function formatDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleString('ar-IQ', { timeZone: 'Asia/Baghdad', dateStyle: 'short', timeStyle: 'short' });
}
function logError(scope, err) { console.error(`[${new Date().toISOString()}][${scope}]`, err?.message ?? err); }

function calcKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function calcDistance(lat1, lon1, lat2, lon2) {
  const d = calcKm(lat1, lon1, lat2, lon2);
  if (d === null) return null;
  return d < 1 ? `${Math.round(d * 1000)} متر` : `${d.toFixed(1)} كم`;
}
function estimateTime(lat1, lon1, lat2, lon2) {
  const d = calcKm(lat1, lon1, lat2, lon2);
  if (d === null) return null;
  const m = Math.ceil(d * 3);
  return m < 60 ? `~${m} دقيقة` : `~${(m/60).toFixed(1)} ساعة`;
}

// ══════════════════════════════════════════════
// 6. KEYBOARDS
// ══════════════════════════════════════════════
const kb = {
  inline: (rows) => ({ inline_keyboard: rows }),
  remove: () => ({ remove_keyboard: true }),
  main: (driver) => ({
    keyboard: [
      [driver?.online ? '🔴 إيقاف الاستقبال' : '🟢 أنا متاح الآن', '📦 طلبي الحالي'],
      ['📊 إحصائياتي', '💼 سجل طلباتي'],
      ['👤 حسابي', '⚙️ الإعدادات'],
      [{ text: '📍 تحديث موقعي', request_location: true }],
    ],
    resize_keyboard: true,
  }),
  location: (label) => ({
    keyboard: [[{ text: label || '📍 إرسال الموقع', request_location: true }]],
    resize_keyboard: true, one_time_keyboard: true,
  }),
  contact: () => ({
    keyboard: [[{ text: '📱 مشاركة رقم الهاتف', request_contact: true }]],
    resize_keyboard: true, one_time_keyboard: true,
  }),
};

function orderActionKb(order) {
  const { id, status } = order;
  const rows = [];
  if (status === 'ready') {
    rows.push([{ text: '🏪 وصلت للمتجر', callback_data: `arrived_merchant:${id}` }]);
    rows.push([{ text: '🛵 استلمت — في الطريق', callback_data: `picked_up:${id}` }]);
  }
  if (status === 'on_the_way') {
    rows.push([{ text: '📍 وصلت للزبون', callback_data: `arrived_customer:${id}` }]);
    rows.push([{ text: '✅ تم التسليم', callback_data: `delivered_order:${id}` }]);
  }
  if (ACTIVE_STATUSES.includes(status)) {
    const m = order.merchants ?? {};
    rows.push([
      { text: '🗺 ملاحة للمتجر', url: navUrl(m.lat, m.lng) },
      { text: '🗺 ملاحة للزبون', url: navUrl(order.customer_lat, order.customer_lng) },
    ]);
    rows.push([
      { text: '📞 اتصال بالمتجر',  callback_data: `call_merchant:${id}` },
      { text: '📞 اتصال بالزبون', callback_data: `call_customer:${id}` },
    ]);
    rows.push([{ text: '❗ مشكلة في الطلب', callback_data: `report_issue:${id}` }]);
  }
  rows.push([{ text: '🔄 تحديث', callback_data: `refresh_order:${id}` }]);
  return kb.inline(rows);
}

// ══════════════════════════════════════════════
// 7. SEND WRAPPERS
// ══════════════════════════════════════════════
async function send(chatId, text, opts = {}) {
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts }); }
  catch (err) { logError('send', err); return null; }
}
async function edit(chatId, msgId, text, opts = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', disable_web_page_preview: true, ...opts,
    });
  } catch (_) { return null; }
}

// ══════════════════════════════════════════════
// 8. DB LAYER
// ══════════════════════════════════════════════
async function getDriver(telegramId) {
  const { data, error } = await supabase.from('drivers').select('*').eq('telegram_id', String(telegramId)).maybeSingle();
  if (error) throw error;
  return data;
}
async function getActiveDriver(chatId) {
  const d = await getDriver(chatId);
  if (!d) { await send(chatId, '⚠️ حسابك غير مسجل. اضغط /start.'); return null; }
  if (!d.active || d.status === 'pending') { await send(chatId, '⏳ حسابك قيد المراجعة.'); return null; }
  if (d.status === 'rejected') { await send(chatId, '⛔ تم رفض حسابك.'); return null; }
  return d;
}
async function getOrder(orderId) {
  const { data, error } = await supabase.from('orders').select('*, merchants(*)').eq('id', orderId).maybeSingle();
  if (error) throw error;
  return data;
}
async function getDriverActiveOrder(driver) {
  const { data, error } = await supabase
    .from('orders').select('*, merchants(*)')
    .eq('driver_id', driver.id).in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}
async function getDriverOrders(driver, page = 0, size = 8) {
  const { data, error, count } = await supabase
    .from('orders')
    .select('id,order_number,status,total_amount,delivery_fee,created_at', { count: 'exact' })
    .eq('driver_id', driver.id).order('created_at', { ascending: false })
    .range(page * size, page * size + size - 1);
  if (error) throw error;
  return { orders: data ?? [], total: count ?? 0, pages: Math.ceil((count ?? 0) / size) };
}
async function updateDriverLocation(chatId, lat, lng) {
  await supabase.from('drivers')
    .update({ lat, lng, last_seen: new Date().toISOString() })
    .eq('telegram_id', String(chatId));
}

// ══════════════════════════════════════════════
// 9. NOTIFICATIONS
// ══════════════════════════════════════════════
async function notifyMerchant(order, text) {
  const tgId = order?.merchants?.telegram_id;
  if (!tgId) return;
  merchantBot.sendMessage(tgId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => logError('notifyMerchant', e));
}
async function notifyCustomer(order, text, markup = null) {
  if (!order?.customer_telegram_id) return;
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (markup) opts.reply_markup = markup;
  customerBot.sendMessage(order.customer_telegram_id, text, opts).catch((e) => logError('notifyCustomer', e));
}
async function notifyAdmin(text) { send(CONFIG.adminId, text); }

// ══════════════════════════════════════════════
// 10. ORDER TEXT
// ══════════════════════════════════════════════
function buildOrderText(order, driver = null) {
  const m = order.merchants ?? {};
  const distMerchant = driver ? calcDistance(driver.lat, driver.lng, m.lat, m.lng) : null;
  const distCustomer = driver ? calcDistance(driver.lat, driver.lng, order.customer_lat, order.customer_lng) : null;
  const eta          = driver ? estimateTime(driver.lat, driver.lng, order.customer_lat, order.customer_lng) : null;
  const items = Array.isArray(order.order_items)
    ? order.order_items.map((i) => `  • ${esc(i.name)} x${i.qty} = ${formatAmount(i.total)}`).join('\n')
    : esc(order.notes ?? 'لا توجد تفاصيل');
  return (
    `📦 <b>طلب #<code>${order.order_number ?? order.id}</code></b>\n` +
    `${statusLabel(order.status)} | 🕐 ${formatDate(order.created_at)}\n\n` +
    `🏪 <b>المتجر:</b> ${esc(m.store_name ?? '')}\n` +
    `📞 هاتف المتجر: ${esc(m.phone ?? '—')}\n` +
    (distMerchant ? `📏 المسافة للمتجر: <b>${distMerchant}</b>\n` : '') +
    `📍 <a href="${mapsUrl(m.lat, m.lng)}">موقع المتجر</a>\n\n` +
    `📱 هاتف الزبون: ${esc(order.customer_phone ?? '—')}\n` +
    (distCustomer ? `📏 المسافة للزبون: <b>${distCustomer}</b>\n` : '') +
    (eta          ? `⏱ وقت الوصول المتوقع: <b>${eta}</b>\n` : '') +
    `📍 <a href="${mapsUrl(order.customer_lat, order.customer_lng)}">موقع الزبون</a>\n\n` +
    `🛒 <b>المنتجات:</b>\n${items}\n\n` +
    `💰 المجموع: <b>${formatAmount(order.total_amount)}</b>\n` +
    `💵 أجرة التوصيل: <b>${formatAmount(order.delivery_fee ?? 0)}</b>`
  );
}

// ══════════════════════════════════════════════
// 11. HOME / STATS / HISTORY / ACCOUNT / SETTINGS
// ══════════════════════════════════════════════
async function sendHome(chatId, driver) {
  const active = await getDriverActiveOrder(driver);
  const extra  = active
    ? `\n\n🔥 <b>لديك طلب نشط:</b> <code>${active.order_number}</code> — ${statusLabel(active.status)}`
    : '';
  return send(chatId,
    `🚗 أهلاً كابتن <b>${esc(driver.full_name ?? '')}</b>\n\n` +
    `📶 ${driver.online ? '🟢 متاح لاستقبال الطلبات' : '🔴 غير متاح'}\n` +
    `📍 آخر تحديث موقع: ${formatDate(driver.last_seen)}` + extra,
    { reply_markup: kb.main(driver) }
  );
}

async function showStats(chatId, driver) {
  const { data, error } = await supabase
    .from('orders').select('status,total_amount,delivery_fee,created_at').eq('driver_id', driver.id);
  if (error) throw error;
  const all = data ?? [];
  const delivered = all.filter((o) => o.status === 'delivered');
  const cancelled = all.filter((o) => ['cancelled', 'rejected'].includes(o.status));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const todayAll  = all.filter((o) => new Date(o.created_at) >= today);
  const todayDone = todayAll.filter((o) => o.status === 'delivered');
  const weekDone  = all.filter((o) => o.status === 'delivered' && new Date(o.created_at) >= weekAgo);
  const totalFee  = delivered.reduce((s, o) => s + Number(o.delivery_fee ?? 0), 0);
  const todayFee  = todayDone.reduce((s, o) => s + Number(o.delivery_fee ?? 0), 0);
  const weekFee   = weekDone.reduce((s, o)  => s + Number(o.delivery_fee ?? 0), 0);
  const rate      = all.length ? Math.round(delivered.length / all.length * 100) : 0;
  return send(chatId,
    `📊 <b>إحصائياتك كابتن</b>\n\n` +
    `<b>اليوم</b>\n  📦 ${todayAll.length} طلب | ✅ ${todayDone.length} مكتمل\n  💵 <b>${formatAmount(todayFee)}</b>\n\n` +
    `<b>الأسبوع</b>\n  ✅ ${weekDone.length} مكتمل | 💵 <b>${formatAmount(weekFee)}</b>\n\n` +
    `<b>الإجمالي</b>\n  📦 ${all.length} | ✅ ${delivered.length} | ❌ ${cancelled.length}\n` +
    `  📈 نسبة النجاح: <b>${rate}%</b>\n  💰 إجمالي الأرباح: <b>${formatAmount(totalFee)}</b>`
  );
}

async function showOrderHistory(chatId, driver, page = 0) {
  const { orders, total, pages } = await getDriverOrders(driver, page);
  if (!orders.length) return send(chatId, '📋 لا توجد طلبات في سجلك.', { reply_markup: kb.main(driver) });
  if (page === 0) await send(chatId, `💼 <b>سجل طلباتك</b> (الإجمالي: ${total})`);
  for (const o of orders) {
    await send(chatId,
      `${STATUS_EMOJI[o.status] ?? '📋'} <b>#${o.order_number}</b>  ${formatDate(o.created_at)}\n` +
      `${statusLabel(o.status)} | 💵 ${formatAmount(o.delivery_fee ?? 0)}`,
      { reply_markup: kb.inline([[{ text: '🔍 التفاصيل', callback_data: `order_detail:${o.id}` }]]) }
    );
  }
  if (pages > 1) {
    const nav = [];
    if (page > 0)         nav.push({ text: '◀ السابق', callback_data: `history_page:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'التالي ▶', callback_data: `history_page:${page + 1}` });
    if (nav.length) await send(chatId, `الصفحة ${page + 1} / ${pages}`, { reply_markup: kb.inline([nav]) });
  }
}

async function showAccount(chatId, driver) {
  return send(chatId,
    `👤 <b>حسابي</b>\n\n` +
    `الاسم: <b>${esc(driver.full_name ?? '')}</b>\n` +
    `📞 الهاتف: ${esc(driver.phone ?? '—')}\n` +
    `📌 الحالة: ${driver.online ? '🟢 متاح' : '🔴 غير متاح'}\n` +
    `📍 الموقع: ${driver.lat ? 'محفوظ ✅' : 'غير محفوظ ❌'}\n` +
    `📅 آخر نشاط: ${formatDate(driver.last_seen)}`,
    {
      reply_markup: kb.inline([
        [{ text: '✏️ تعديل الاسم', callback_data: 'edit_name' }, { text: '📞 تعديل الهاتف', callback_data: 'edit_phone' }],
        [{ text: '📍 تحديث الموقع', callback_data: 'prompt_location' }],
        ...(CONFIG.supportUsername ? [[{ text: '💬 الدعم الفني', url: `https://t.me/${CONFIG.supportUsername}` }]] : []),
      ]),
    }
  );
}

async function showSettings(chatId, driver) {
  return send(chatId,
    `⚙️ <b>الإعدادات</b>\n\n` +
    `استقبال الطلبات: ${driver.online ? '🟢 مفعّل' : '🔴 موقف'}\n` +
    `التنبيهات: ${driver.sound_notifications !== false ? '🔔 مفعّلة' : '🔕 موقفة'}`,
    {
      reply_markup: kb.inline([
        [{ text: driver.online ? '🔴 إيقاف الاستقبال' : '🟢 تفعيل الاستقبال', callback_data: driver.online ? 'go_offline' : 'go_online' }],
        [{ text: driver.sound_notifications !== false ? '🔕 إيقاف التنبيهات' : '🔔 تفعيل التنبيهات', callback_data: 'toggle_sound' }],
        [{ text: '🗑 حذف حسابي', callback_data: 'request_delete_account' }],
      ]),
    }
  );
}

// ══════════════════════════════════════════════
// 12. ONLINE STATUS
// ══════════════════════════════════════════════
async function setOnlineStatus(chatId, isOnline) {
  const { data: driver, error } = await supabase
    .from('drivers')
    .update({ online: isOnline, last_seen: new Date().toISOString() })
    .eq('telegram_id', String(chatId)).select('*').single();
  if (error) throw error;
  await sendHome(chatId, driver);
  if (isOnline) return send(chatId, '🟢 <b>أنت الآن متاح لاستقبال الطلبات!</b>\n\n💡 فعّل مشاركة الموقع المباشر لأفضل دقة.');
  return send(chatId, '🔴 تم إيقاف استقبال الطلبات.');
}

// ══════════════════════════════════════════════
// 13. ACCEPT ORDER (race-condition safe)
// ══════════════════════════════════════════════
async function acceptOrder(chatId, msgId, orderId, driver, originalText) {
  const existing = await getDriverActiveOrder(driver);
  if (existing) {
    return send(chatId, `⚠️ لديك طلب نشط بالفعل: <code>${existing.order_number}</code>\nأكمل طلبك الحالي أولاً.`);
  }
  const order = await getOrder(orderId);
  if (!order) return send(chatId, '❌ الطلب غير موجود.');
  if (!['pending', 'accepted', 'preparing', 'ready'].includes(order.status)) return send(chatId, '⏳ هذا الطلب لم يعد متاحاً.');
  if (order.driver_id) return send(chatId, '⏳ سبقك كابتن آخر. سيصلك طلب قريباً 🚀');

  const { data: claimed, error } = await supabase
    .from('orders')
    .update({ status: 'ready', driver_id: driver.id, driver_telegram_id: String(chatId), updated_at: new Date().toISOString() })
    .eq('id', orderId).is('driver_id', null)
    .select('*, merchants(*)').single();
  if (error || !claimed) return send(chatId, '⏳ سبقك كابتن آخر. سيصلك طلب قريباً 🚀');

  // Clean broadcast
  const { data: bcs } = await supabase.from('order_broadcasts').select('*').eq('order_id', orderId);
  if (bcs?.length) {
    for (const bc of bcs) {
      if (String(bc.driver_telegram_id) === String(chatId)) continue;
      bot.editMessageText('⏳ تم قبول هذا الطلب من كابتن آخر.', {
        chat_id: bc.driver_telegram_id, message_id: bc.message_id, parse_mode: 'HTML',
      }).catch(() => {});
    }
  }
  await supabase.from('order_broadcasts').delete().eq('order_id', orderId);

  await edit(chatId, msgId,
    `${originalText ?? buildOrderText(claimed, driver)}\n\n✅ <b>قبلت هذا الطلب.</b>`,
    { reply_markup: orderActionKb(claimed) }
  );

  const m = claimed.merchants ?? {};
  const dist = calcDistance(m.lat, m.lng, driver.lat, driver.lng);
  await notifyMerchant(claimed,
    `🎉 <b>سائق قبل الطلب!</b>\n🆔 <code>${claimed.order_number}</code>\n` +
    `👤 ${esc(driver.full_name ?? '')} | 📞 ${esc(driver.phone ?? '')}\n` +
    (dist ? `📏 المسافة: ${dist}` : '')
  );
  await notifyCustomer(claimed,
    `🛵 <b>تم تعيين سائق لطلبك!</b>\n\n` +
    `👤 الكابتن: <b>${esc(driver.full_name ?? '')}</b>\n` +
    `📞 ${esc(driver.phone ?? '')}\n\n⏱ في الطريق للمتجر...`
  );
  return send(chatId, '🚀 تم قبول الطلب! توجه للمتجر.', { reply_markup: kb.main(driver) });
}

// ══════════════════════════════════════════════
// 14. ORDER STEPS
// ══════════════════════════════════════════════
async function handleArrivedMerchant(chatId, msgId, orderId, driver) {
  const order = await getOrder(orderId);
  if (!order || String(order.driver_id) !== String(driver.id)) return send(chatId, '⛔ ليس طلبك.');
  await notifyMerchant(order, `🏪 <b>الكابتن وصل للمتجر</b>\n🆔 <code>${order.order_number}</code>\n👤 ${esc(driver.full_name ?? '')}`);
  await notifyCustomer(order, `⏳ كابتنك وصل للمتجر ويستلم طلبك...`);
  await edit(chatId, msgId, `${buildOrderText(order, driver)}\n\n🏪 <b>وصلت للمتجر.</b>`, { reply_markup: orderActionKb({ ...order, status: 'ready' }) });
}

async function handlePickedUp(chatId, msgId, orderId, driver) {
  const order = await getOrder(orderId);
  if (!order || String(order.driver_id) !== String(driver.id)) return send(chatId, '⛔ ليس طلبك.');
  const { data: updated, error } = await supabase
    .from('orders').update({ status: 'on_the_way', updated_at: new Date().toISOString() })
    .eq('id', orderId).eq('driver_id', driver.id).select('*, merchants(*)').single();
  if (error) throw error;
  const eta = estimateTime(driver.lat, driver.lng, updated.customer_lat, updated.customer_lng);
  await notifyMerchant(updated, `🚚 <b>استلم الكابتن الطلب</b>\n🆔 <code>${updated.order_number}</code>\nفي الطريق للزبون.`);
  await notifyCustomer(updated,
    `🛵 <b>طلبك في الطريق!</b>\n\n👤 ${esc(driver.full_name ?? '')} | 📞 ${esc(driver.phone ?? '')}` +
    (eta ? `\n⏱ وقت الوصال: <b>${eta}</b>` : '')
  );
  await edit(chatId, msgId, `${buildOrderText(updated, driver)}\n\n🛵 <b>أنت في الطريق للزبون!</b>`, { reply_markup: orderActionKb(updated) });
}

async function handleArrivedCustomer(chatId, msgId, orderId, driver) {
  const order = await getOrder(orderId);
  if (!order || String(order.driver_id) !== String(driver.id)) return send(chatId, '⛔ ليس طلبك.');
  await notifyCustomer(order, `📍 <b>الكابتن وصل لموقعك!</b>\nيرجى النزول لاستلام طلبك 🙏`);
  await edit(chatId, msgId, `${buildOrderText(order, driver)}\n\n📍 <b>أنت عند موقع الزبون.</b>`, {
    reply_markup: kb.inline([
      [{ text: '✅ تم التسليم', callback_data: `delivered_order:${orderId}` }],
      [{ text: '❗ مشكلة في التسليم', callback_data: `report_issue:${orderId}` }],
      [{ text: '🔄 تحديث', callback_data: `refresh_order:${orderId}` }],
    ]),
  });
}

async function handleDelivered(chatId, msgId, orderId, driver) {
  const order = await getOrder(orderId);
  if (!order || String(order.driver_id) !== String(driver.id)) return send(chatId, '⛔ ليس طلبك.');
  const { data: done, error } = await supabase
    .from('orders').update({ status: 'delivered', updated_at: new Date().toISOString() })
    .eq('id', orderId).eq('driver_id', driver.id).select('*, merchants(*)').single();
  if (error) throw error;
  await notifyMerchant(done, `✅ <b>تم تسليم الطلب</b>\n🆔 <code>${done.order_number}</code>\n👤 ${esc(driver.full_name ?? '')}`);
  await notifyCustomer(done, `🎉 <b>وصل طلبك!</b>\n\nشكراً لثقتك بنا. نتمنى لك وجبة شهية! 😊`,
    kb.inline([[{ text: '⭐ قيّم التوصيل', callback_data: `rate_order:${orderId}` }]])
  );
  await edit(chatId, msgId, `${buildOrderText(done, driver)}\n\n🏁 <b>تم التسليم بنجاح! عمل رائع كابتن.</b>`);
  const fresh = await getDriver(chatId);
  return send(chatId, `✅ تم إغلاق الطلب.\n💵 أجرة التوصيل: <b>${formatAmount(done.delivery_fee ?? 0)}</b>`, {
    reply_markup: kb.main(fresh ?? driver),
  });
}

// ══════════════════════════════════════════════
// 15. ISSUE REPORT
// ══════════════════════════════════════════════
async function promptIssueReport(chatId, orderId) {
  return send(chatId, '❗ ما المشكلة؟ اختر:', {
    reply_markup: kb.inline([
      [{ text: '🚫 الزبون لا يرد',         callback_data: `issue:no_answer:${orderId}` }],
      [{ text: '📍 الموقع خاطئ',           callback_data: `issue:wrong_location:${orderId}` }],
      [{ text: '🏪 المتجر لم يجهز الطلب', callback_data: `issue:not_ready:${orderId}` }],
      [{ text: '💳 مشكلة في الدفع',        callback_data: `issue:payment:${orderId}` }],
      [{ text: '📝 مشكلة أخرى',            callback_data: `issue:other:${orderId}` }],
    ]),
  });
}

async function handleIssue(chatId, type, orderId, driver) {
  const order = await getOrder(orderId);
  if (!order) return send(chatId, '❌ الطلب غير موجود.');
  const labels = { no_answer: 'الزبون لا يرد', wrong_location: 'الموقع خاطئ', not_ready: 'المتجر لم يجهز الطلب', payment: 'مشكلة دفع', other: 'مشكلة أخرى' };
  const label = labels[type] ?? type;
  await supabase.from('order_issues').insert({ order_id: orderId, driver_telegram_id: String(chatId), issue_type: type, reported_at: new Date().toISOString() }).catch(() => {});
  await notifyAdmin(`⚠️ <b>مشكلة في طلب</b>\n🆔 <code>${order.order_number}</code>\n👤 ${esc(driver.full_name ?? '')} | 📞 ${esc(driver.phone ?? '')}\n❗ ${label}`);
  if (['no_answer', 'wrong_location'].includes(type)) {
    await notifyMerchant(order, `⚠️ <b>مشكلة أبلغ عنها الكابتن</b>\n🆔 <code>${order.order_number}</code>\n❗ ${label}`);
  }
  return send(chatId, `✅ تم إرسال البلاغ للإدارة.\nالمشكلة: <b>${label}</b>`, { reply_markup: kb.main(driver) });
}

// ══════════════════════════════════════════════
// 16. REGISTRATION
// ══════════════════════════════════════════════
function startRegistration(chatId) {
  sessions.set(chatId, { flow: 'register', step: 'full_name' });
  return send(chatId, '👋 أهلاً كابتن!\n\nأرسل اسمك الكامل للتسجيل:', { reply_markup: kb.remove() });
}

async function handleRegistration(chatId, msg) {
  const s = sessions.get(chatId);
  if (!s || s.flow !== 'register') return;
  const text = msg.text?.trim();
  if (s.step === 'full_name') {
    if (!text || text.length < 3) return send(chatId, '✍️ الاسم قصير جداً (3 أحرف على الأقل).');
    s.full_name = text; s.step = 'phone'; sessions.set(chatId, s);
    return send(chatId, '📞 أرسل رقم هاتفك:', { reply_markup: kb.contact() });
  }
  if (s.step === 'phone') {
    const phone = msg.contact?.phone_number ?? text;
    if (!phone || String(phone).length < 7) return send(chatId, '⚠️ رقم غير صحيح.', { reply_markup: kb.contact() });
    s.phone = phone; s.step = 'location'; sessions.set(chatId, s);
    return send(chatId, '📍 أرسل موقعك الحالي:', { reply_markup: kb.location('📍 إرسال موقعي') });
  }
  if (s.step === 'location') {
    if (!msg.location) return send(chatId, '⚠️ اضغط زر إرسال الموقع.', { reply_markup: kb.location('📍 إرسال موقعي') });
    const { latitude: lat, longitude: lng } = msg.location;
    const existing = await getDriver(chatId);
    if (existing) { sessions.del(chatId); return send(chatId, '⚠️ أنت مسجل مسبقاً.'); }
    await supabase.from('drivers').insert({
      telegram_id: String(chatId), full_name: s.full_name, phone: s.phone,
      lat, lng, active: false, online: false, status: 'pending', last_seen: new Date().toISOString(),
    });
    sessions.del(chatId);
    await send(CONFIG.adminId,
      `🔔 <b>طلب تفعيل سائق جديد</b>\n\n👤 <b>${esc(s.full_name)}</b>\n📞 ${esc(s.phone)}\n🆔 <code>${chatId}</code>\n📍 <a href="${mapsUrl(lat, lng)}">موقع السائق</a>`,
      { reply_markup: kb.inline([[{ text: '✅ تفعيل', callback_data: `approve_driver:${chatId}` }, { text: '❌ رفض', callback_data: `reject_driver:${chatId}` }]]) }
    );
    return send(chatId, '✅ <b>تم إرسال طلبك للإدارة!</b>\n\n⏳ سيتم إشعارك بالموافقة قريباً.', { reply_markup: kb.remove() });
  }
}

// ══════════════════════════════════════════════
// 17. BOT EVENTS
// ══════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const m = await bot.getChatMember(CONFIG.requiredChannel, chatId).catch(() => null);
    if (m && !['creator', 'administrator', 'member'].includes(m.status)) {
      return send(chatId, `⚠️ يجب الاشتراك في القناة:\n🔗 ${CONFIG.requiredChannel}\n\nثم اضغط /start`, { reply_markup: kb.remove() });
    }
    const driver = await getDriver(chatId);
    if (!driver) return startRegistration(chatId);
    if (!driver.active || driver.status === 'pending') return send(chatId, '⏳ حسابك قيد المراجعة.', { reply_markup: kb.remove() });
    if (driver.status === 'rejected') return send(chatId, '⛔ تم رفض حسابك.');
    return sendHome(chatId, driver);
  } catch (err) { logError('/start', err); return send(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.'); }
});

bot.onText(/\/cancel/, async (msg) => {
  sessions.del(msg.chat.id);
  const driver = await getDriver(msg.chat.id).catch(() => null);
  return send(msg.chat.id, '🚫 تم إلغاء العملية.', { reply_markup: driver ? kb.main(driver) : kb.remove() });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (text?.startsWith('/')) return;
  const session = sessions.get(chatId);
  try {
    if (session?.flow === 'register') return handleRegistration(chatId, msg);
    if (session?.flow === 'edit_name') {
      if (!text || text.length < 3) return send(chatId, '⚠️ الاسم قصير جداً.');
      await supabase.from('drivers').update({ full_name: text }).eq('telegram_id', String(chatId));
      sessions.del(chatId);
      return send(chatId, '✅ تم تحديث اسمك.', { reply_markup: kb.main(await getDriver(chatId)) });
    }
    if (session?.flow === 'edit_phone') {
      const phone = msg.contact?.phone_number ?? text;
      if (!phone || String(phone).length < 7) return send(chatId, '⚠️ رقم غير صحيح.', { reply_markup: kb.contact() });
      await supabase.from('drivers').update({ phone }).eq('telegram_id', String(chatId));
      sessions.del(chatId);
      return send(chatId, '✅ تم تحديث رقمك.', { reply_markup: kb.main(await getDriver(chatId)) });
    }
    const driver = await getActiveDriver(chatId);
    if (!driver) return;
    if (msg.location && !msg.edit_date) {
      await updateDriverLocation(chatId, msg.location.latitude, msg.location.longitude);
      return send(chatId, '📍 تم تحديث موقعك ✅', { reply_markup: kb.main(driver) });
    }
    const map = {
      '🟢 أنا متاح الآن':     () => setOnlineStatus(chatId, true),
      '🔴 إيقاف الاستقبال':   () => setOnlineStatus(chatId, false),
      '📦 طلبي الحالي':       () => showCurrentOrder(chatId, driver),
      '📊 إحصائياتي':         () => showStats(chatId, driver),
      '💼 سجل طلباتي':        () => showOrderHistory(chatId, driver),
      '👤 حسابي':              () => showAccount(chatId, driver),
      '⚙️ الإعدادات':         () => showSettings(chatId, driver),
    };
    if (map[text]) return map[text]();
    return send(chatId, 'اختر من الأزرار 👇', { reply_markup: kb.main(driver) });
  } catch (err) { logError('message', err); return send(chatId, '❌ حدث خطأ.'); }
});

async function showCurrentOrder(chatId, driver) {
  const order = await getDriverActiveOrder(driver);
  if (!order) return send(chatId, '✅ لا يوجد لديك طلب نشط.', { reply_markup: kb.main(driver) });
  return send(chatId, buildOrderText(order, driver), { reply_markup: orderActionKb(order) });
}

bot.on('edited_message', async (msg) => {
  if (!msg.location) return;
  const chatId = msg.chat.id;
  try {
    const d = await getDriver(chatId);
    if (!d?.active || !d?.online) return;
    await updateDriverLocation(chatId, msg.location.latitude, msg.location.longitude);
  } catch (err) { logError('edited_message', err); }
});

// ══════════════════════════════════════════════
// 18. CALLBACK
// ══════════════════════════════════════════════
bot.on('callback_query', async (q) => {
  const chatId  = q.message.chat.id;
  const msgId   = q.message.message_id;
  const action  = q.data;
  const userId  = String(q.from.id);
  await bot.answerCallbackQuery(q.id).catch(() => {});
  try {
    // Admin
    if (action.startsWith('approve_driver:') || action.startsWith('reject_driver:')) {
      if (userId !== CONFIG.adminId) return;
      const [act, dChatId] = action.split(':');
      const approve = act === 'approve_driver';
      await supabase.from('drivers').update({ active: approve, status: approve ? 'approved' : 'rejected', online: false }).eq('telegram_id', dChatId);
      await send(dChatId, approve ? '🎉 <b>تم تفعيل حسابك!</b>\nاضغط /start للبدء.' : '⛔ تم رفض طلب انضمامك. تواصل مع الدعم.');
      return edit(chatId, msgId, `${q.message.text ?? ''}\n\n${approve ? '🟢 تم التفعيل' : '🔴 تم الرفض'}`);
    }

    const driver = await getActiveDriver(userId);

    if (action.startsWith('accept_order:'))      { if (!driver) return; return acceptOrder(userId, msgId, action.split(':')[1], driver, q.message.text); }
    if (action.startsWith('arrived_merchant:'))  { if (!driver) return; return handleArrivedMerchant(userId, msgId, action.split(':')[1], driver); }
    if (action.startsWith('picked_up:'))         { if (!driver) return; return handlePickedUp(userId, msgId, action.split(':')[1], driver); }
    if (action.startsWith('arrived_customer:'))  { if (!driver) return; return handleArrivedCustomer(userId, msgId, action.split(':')[1], driver); }
    if (action.startsWith('delivered_order:'))   { if (!driver) return; return handleDelivered(userId, msgId, action.split(':')[1], driver); }
    if (action.startsWith('report_issue:'))      { if (!driver) return; return promptIssueReport(userId, action.split(':')[1]); }
    if (action.startsWith('issue:'))             {
      if (!driver) return;
      const [, type, orderId] = action.split(':');
      return handleIssue(userId, type, orderId, driver);
    }
    if (action.startsWith('refresh_order:')) {
      if (!driver) return;
      const order = await getOrder(action.split(':')[1]);
      if (!order || String(order.driver_id) !== String(driver.id)) return send(userId, '⛔ ليس طلبك.');
      return send(userId, buildOrderText(order, driver), { reply_markup: orderActionKb(order) });
    }
    if (action.startsWith('order_detail:')) {
      if (!driver) return;
      const order = await getOrder(action.split(':')[1]);
      if (!order || String(order.driver_id) !== String(driver.id)) return send(userId, '⛔ ليس لديك صلاحية.');
      return send(userId, buildOrderText(order, driver));
    }
    if (action.startsWith('history_page:')) { if (!driver) return; return showOrderHistory(userId, driver, Number(action.split(':')[1])); }

    if (action.startsWith('call_merchant:')) {
      if (!driver) return;
      const order = await getOrder(action.split(':')[1]);
      if (!order || String(order.driver_id) !== String(driver.id)) return;
      return bot.answerCallbackQuery(q.id, { text: `📞 هاتف المتجر: ${order.merchants?.phone ?? '—'}`, show_alert: true }).catch(() => {});
    }
    if (action.startsWith('call_customer:')) {
      if (!driver) return;
      const order = await getOrder(action.split(':')[1]);
      if (!order || String(order.driver_id) !== String(driver.id)) return;
      return bot.answerCallbackQuery(q.id, { text: `📞 هاتف الزبون: ${order.customer_phone ?? '—'}`, show_alert: true }).catch(() => {});
    }

    if (action === 'go_online')  { if (driver) return setOnlineStatus(userId, true); }
    if (action === 'go_offline') { if (driver) return setOnlineStatus(userId, false); }
    if (action === 'toggle_sound') {
      if (!driver) return;
      const next = driver.sound_notifications === false;
      await supabase.from('drivers').update({ sound_notifications: next }).eq('telegram_id', String(userId));
      return showSettings(userId, await getDriver(userId));
    }
    if (action === 'request_delete_account') {
      if (!driver) return;
      return send(userId, '⚠️ هل أنت متأكد من حذف حسابك؟', {
        reply_markup: kb.inline([[{ text: '✅ نعم', callback_data: 'confirm_delete_account' }, { text: '❌ إلغاء', callback_data: 'cancel_delete_account' }]]),
      });
    }
    if (action === 'confirm_delete_account') {
      if (!driver) return;
      await supabase.from('drivers').update({ active: false, status: 'deleted', online: false }).eq('telegram_id', String(userId));
      await notifyAdmin(`🗑 سائق طلب حذف حسابه: ${esc(driver.full_name ?? '')} | <code>${userId}</code>`);
      return send(userId, '✅ تم إلغاء تفعيل حسابك.', { reply_markup: kb.remove() });
    }
    if (action === 'cancel_delete_account') { if (driver) return showSettings(userId, driver); }
    if (action === 'edit_name')      { if (!driver) return; sessions.set(userId, { flow: 'edit_name' }); return send(userId, '✏️ أرسل اسمك الجديد:', { reply_markup: kb.remove() }); }
    if (action === 'edit_phone')     { if (!driver) return; sessions.set(userId, { flow: 'edit_phone' }); return send(userId, '📞 أرسل رقمك الجديد:', { reply_markup: kb.contact() }); }
    if (action === 'prompt_location'){ if (!driver) return; return send(userId, '📍 أرسل موقعك:', { reply_markup: kb.location() }); }
  } catch (err) { logError('callback', err); return send(chatId, '❌ حدث خطأ.'); }
});

bot.on('polling_error', (err) => logError('polling_error', err));
process.on('unhandledRejection', (r) => logError('unhandledRejection', r));
process.on('uncaughtException',  (e) => logError('uncaughtException', e));

console.log('🚗 Driver Bot running...');
module.exports = bot;