'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ──────────────────────────────────────────────
// 1. ENV VALIDATION
// ──────────────────────────────────────────────
const REQUIRED_ENV = [
  'MERCHANT_BOT_TOKEN',
  'DRIVER_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'ADMIN_ID',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
}

// ──────────────────────────────────────────────
// 2. CLIENTS
// ──────────────────────────────────────────────
const bot = new TelegramBot(process.env.MERCHANT_BOT_TOKEN, { polling: true });
const driverBot = new TelegramBot(process.env.DRIVER_BOT_TOKEN, { polling: false });
const customerBot = process.env.CUSTOMER_BOT_TOKEN
  ? new TelegramBot(process.env.CUSTOMER_BOT_TOKEN, { polling: false })
  : null;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ──────────────────────────────────────────────
// 3. CONFIG
// ──────────────────────────────────────────────
const CONFIG = Object.freeze({
  adminId: String(process.env.ADMIN_ID),
  requiredChannel: process.env.REQUIRED_CHANNEL || '@order_iq1',
  retryDelayMs: Number(process.env.ORDER_RETRY_DELAY_MS || 120_000),
  maxDriverBroadcast: Number(process.env.MAX_DRIVER_BROADCAST || 50),
  productImagesChannelId: process.env.PRODUCT_IMAGES_CHANNEL_ID || null,
  storeImagesChannelId: process.env.STORE_IMAGES_CHANNEL_ID || null, // ← NEW: قناة لحفظ صور المتاجر
  maxProductsPerMerchant: Number(process.env.MAX_PRODUCTS || 100),
  orderPageSize: Number(process.env.ORDER_PAGE_SIZE || 10),
});

// ──────────────────────────────────────────────
// 4. IN-MEMORY SESSION STORE (TTL 30 min)
// ──────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 60 * 1000;

class SessionStore {
  #store = new Map();

  get(id) {
    const entry = this.#store.get(String(id));
    if (!entry) return undefined;
    if (Date.now() - entry.ts > SESSION_TTL_MS) {
      this.#store.delete(String(id));
      return undefined;
    }
    return entry.data;
  }

  set(id, data) {
    this.#store.set(String(id), { data, ts: Date.now() });
  }

  delete(id) {
    this.#store.delete(String(id));
  }

  startCleanup(intervalMs = 10 * 60 * 1000) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.#store) {
        if (now - v.ts > SESSION_TTL_MS) this.#store.delete(k);
      }
    }, intervalMs);
  }
}

const sessions = new SessionStore();
sessions.startCleanup();

// ──────────────────────────────────────────────
// 5. CONSTANTS
// ──────────────────────────────────────────────
const STATUS_TEXT = {
  pending:    '⏳ بانتظار قبول التاجر',
  accepted:   '✅ مقبول',
  preparing:  '👨‍🍳 قيد التحضير',
  ready:      '📦 جاهز للسائق',
  on_the_way: '🛵 في الطريق',
  delivered:  '🎉 تم التسليم',
  cancelled:  '❌ ملغي',
  rejected:   '⛔ مرفوض',
};

const FLOWS = Object.freeze({
  REGISTER:           'register',
  MANUAL_ORDER:       'manual_order',
  ADD_PRODUCT:        'add_product',
  EDIT_PRICE:         'edit_price',
  EDIT_ORDER:         'edit_order',
  EDIT_SINGLE_ITEM:   'edit_single_order_item',
  REJECT_REASON:      'reject_order_reason',
  CHAT_CUSTOMER:      'chat_customer',
  ADD_NOTE:           'add_merchant_note',
  CANCEL_ORDER:       'cancel_order_reason',
  SET_DELIVERY_FEE:   'set_delivery_fee',
  BULK_NOTIFY:        'bulk_notify_customers',
  UPLOAD_STORE_IMAGE: 'upload_store_image',   // ← NEW
  EDIT_PRODUCT_MEDIA: 'edit_product_media',   // ← NEW
});

// ──────────────────────────────────────────────
// 6. HELPERS
// ──────────────────────────────────────────────

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mapsUrl(lat, lng) {
  if (!lat || !lng) return '#';
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function statusText(s) {
  return STATUS_TEXT[s] ?? s ?? 'غير معروف';
}

function parseNumber(text) {
  if (!text) return NaN;
  const normalized = String(text)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d.]/g, '');
  return Number(normalized);
}

function safeRound(n) {
  const x = parseNumber(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function formatAmount(n) {
  return `${Number(n || 0).toLocaleString('ar-IQ')} د.ع`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('ar-IQ', {
    timeZone: 'Asia/Baghdad',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

// ──────────────────────────────────────────────
// 7. KEYBOARD BUILDERS
// ──────────────────────────────────────────────

const kb = {
  inline: (rows) => ({ inline_keyboard: rows }),
  remove: () => ({ remove_keyboard: true }),
  main: () => ({
    keyboard: [
      ['📥 الطلبات الجديدة', '📦 طلباتي'],
      ['🛒 إضافة منتج', '📋 منتجاتي'],
      ['📊 الإحصائيات', '🏪 حالة المتجر'],
      ['➕ طلب يدوي', 'ℹ️ معلومات حسابي'],
      ['⚙️ إعدادات المتجر'],
    ],
    resize_keyboard: true,
  }),
  location: (label) => ({
    keyboard: [[{ text: label, request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),
  contact: () => ({
    keyboard: [[{ text: '📞 مشاركة رقم الهاتف', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),
};

// ──────────────────────────────────────────────
// 8. BOT SEND WRAPPERS (never throw)
// ──────────────────────────────────────────────

async function send(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
  } catch (err) {
    logError('send', err);
    return null;
  }
}

async function edit(chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    });
  } catch (_) {
    return null;
  }
}

async function editReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    return await bot.editMessageReplyMarkup(replyMarkup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (_) {
    return null;
  }
}

async function deleteMsg(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {}
}

function logError(scope, err) {
  console.error(`[${new Date().toISOString()}][${scope}]`, err?.message ?? err);
}

// ──────────────────────────────────────────────
// 9. SUPABASE HELPERS
// ──────────────────────────────────────────────

async function getMerchant(telegramId) {
  const { data, error } = await supabase
    .from('merchants')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getActiveMerchant(chatId) {
  const m = await getMerchant(chatId);
  if (!m) {
    await send(chatId, '⚠️ حسابك غير مسجل. اضغط /start.');
    return null;
  }
  if (!m.active) {
    await send(chatId, '⏳ حسابك قيد المراجعة من الإدارة.');
    return null;
  }
  return m;
}

async function getOrder(orderId, merchantId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updateOrder(orderId, merchantId, payload) {
  const { data, error } = await supabase
    .from('orders')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('merchant_id', merchantId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function setOrderStatus(orderId, merchantId, status) {
  return updateOrder(orderId, merchantId, { status });
}

async function getOnlineDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('online', true)
    .limit(CONFIG.maxDriverBroadcast);
  if (error) throw error;
  return data ?? [];
}

async function generateOrderNumber() {
  for (let i = 0; i < 30; i++) {
    const number = Math.floor(100_000 + Math.random() * 900_000);
    const { data } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', number)
      .maybeSingle();
    if (!data) return number;
  }
  throw new Error('فشل توليد رقم الطلب');
}

// ──────────────────────────────────────────────
// 10. SUBSCRIPTION CHECK
// ──────────────────────────────────────────────

async function checkSubscription(userId) {
  try {
    const m = await bot.getChatMember(CONFIG.requiredChannel, userId);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (_) {
    return false;
  }
}

async function requireSubscription(chatId) {
  if (await checkSubscription(chatId)) return true;
  await send(
    chatId,
    `⚠️ يجب الاشتراك في القناة أولاً:\n🔗 ${CONFIG.requiredChannel}\n\nبعد الاشتراك اضغط /start`,
    { reply_markup: kb.remove() }
  );
  return false;
}

// ──────────────────────────────────────────────
// 11. NOTIFICATIONS
// ──────────────────────────────────────────────

async function notifyAdmin(text, markup = null) {
  return send(CONFIG.adminId, text, markup ? { reply_markup: markup } : {});
}

async function notifyCustomer(order, text) {
  if (!order?.customer_telegram_id || !customerBot) return;
  try {
    await customerBot.sendMessage(order.customer_telegram_id, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    logError('notifyCustomer', err);
  }
}

async function notifyAdminNewMerchant(draft, chatId) {
  await notifyAdmin(
    `🔔 <b>طلب تفعيل تاجر جديد</b>\n\n` +
    `🏪 المتجر: <b>${esc(draft.store_name)}</b>\n` +
    `📞 الهاتف: ${esc(draft.phone)}\n` +
    `🆔 <code>${chatId}</code>\n` +
    `📍 <a href="${mapsUrl(draft.lat, draft.lng)}">موقع المتجر</a>`,
    kb.inline([
      [
        { text: '✅ تفعيل', callback_data: `approve_merchant:${chatId}` },
        { text: '❌ رفض',   callback_data: `reject_merchant:${chatId}` },
      ],
    ])
  );
}

// ──────────────────────────────────────────────
// 12. DRIVER BROADCAST
// ──────────────────────────────────────────────

function buildDriverMsg(orderId, merchant, order) {
  return (
    `🚚 <b>طلب توصيل جديد</b>\n\n` +
    `🆔 رقم الطلب: <code>${order.order_number ?? orderId}</code>\n` +
    `🏪 المتجر: <b>${esc(merchant.store_name)}</b>\n` +
    `📞 هاتف المتجر: ${esc(merchant.phone ?? '')}\n` +
    `📍 <a href="${mapsUrl(merchant.lat, merchant.lng)}">موقع الاستلام</a>\n\n` +
    `🛒 <b>التفاصيل:</b>\n${esc(order.notes ?? '')}\n\n` +
    `📱 هاتف الزبون: ${esc(order.customer_phone ?? '')}\n` +
    `💰 المجموع: ${formatAmount(order.total_amount)}\n` +
    `💵 أجرة التوصيل: ${formatAmount(order.delivery_fee)}\n` +
    `📍 <a href="${mapsUrl(order.customer_lat, order.customer_lng)}">موقع الزبون</a>`
  );
}

async function broadcastToDrivers(orderId, merchant, order, merchantChatId) {
  const drivers = await getOnlineDrivers();

  if (!drivers.length) {
    await send(merchantChatId, '⚠️ لا يوجد سائقون متاحون.', {
      reply_markup: kb.inline([
        [{ text: '🔄 إعادة الإرسال للسائقين', callback_data: `send_driver:${orderId}` }],
      ]),
    });
    return false;
  }

  const msg = buildDriverMsg(orderId, merchant, order);
  const records = [];
  let ok = 0;

  for (const d of drivers) {
    if (!d.telegram_id) continue;
    try {
      const sent = await driverBot.sendMessage(d.telegram_id, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: kb.inline([
          [{ text: '🤝 قبول الطلب', callback_data: `accept_order:${orderId}` }],
        ]),
      });
      records.push({
        order_id: orderId,
        driver_telegram_id: String(d.telegram_id),
        message_id: sent.message_id,
      });
      ok++;
    } catch (err) {
      logError(`driver:${d.telegram_id}`, err);
    }
  }

  if (records.length) {
    await supabase.from('order_broadcasts').insert(records);
  }

  await send(
    merchantChatId,
    ok > 0
      ? `✅ تم إرسال الطلب إلى <b>${ok}</b> سائق.`
      : '⚠️ لم يُرسل الطلب لأي سائق.'
  );

  return ok > 0;
}

// ──────────────────────────────────────────────
// 13. ORDER CARD
// ──────────────────────────────────────────────

async function sendOrderCard(chatId, order) {
  const createdAt = formatDate(order.created_at);
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const itemsText = items.length
    ? items.map((i) => `  • ${esc(i.name)} × ${i.qty} — ${formatAmount(i.total)}`).join('\n')
    : esc(order.notes ?? '');

  const text =
    `📦 <b>طلب رقم:</b> <code>${order.order_number ?? order.id}</code>\n` +
    `🕐 ${createdAt}\n` +
    `📌 الحالة: <b>${statusText(order.status)}</b>\n\n` +
    `📱 هاتف الزبون: ${esc(order.customer_phone ?? '')}\n` +
    `💰 المجموع: <b>${formatAmount(order.total_amount)}</b>\n` +
    `💵 أجرة التوصيل: ${formatAmount(order.delivery_fee)}\n\n` +
    `🛒 <b>الطلب:</b>\n${itemsText}\n\n` +
    (order.merchant_note ? `📝 ملاحظتك: ${esc(order.merchant_note)}\n\n` : '') +
    `📍 <a href="${mapsUrl(order.customer_lat, order.customer_lng)}">موقع الزبون</a>`;

  const rows = [
    [
      { text: '⚙️ إدارة الطلب', callback_data: `manage_order:${order.id}` },
      { text: '🔄 تحديث', callback_data: `refresh_order:${order.id}` },
    ],
  ];

  return send(chatId, text, {
    disable_web_page_preview: true,
    reply_markup: kb.inline(rows),
  });
}

// ──────────────────────────────────────────────
// 14. MANAGE ORDER MENU
// ──────────────────────────────────────────────

async function sendManageMenu(chatId, order) {
  const { status, id, order_number, customer_telegram_id } = order;
  const rows = [];

  if (status === 'pending') {
    rows.push([
      { text: '✅ قبول الطلب',       callback_data: `accept_order_m:${id}` },
      { text: '❌ رفض مع سبب',       callback_data: `reject_order_m:${id}` },
    ]);
  }

  if (status === 'accepted') {
    rows.push([
      { text: '👨‍🍳 قيد التحضير',     callback_data: `status_order:${id}:preparing` },
      { text: '📦 جاهز للتسليم',     callback_data: `status_order:${id}:ready` },
    ]);
  }

  if (status === 'preparing') {
    rows.push([
      { text: '📦 جاهز للتسليم',     callback_data: `status_order:${id}:ready` },
    ]);
  }

  if (['accepted', 'preparing', 'ready'].includes(status)) {
    rows.push([
      { text: '🛵 إرسال للسائقين',   callback_data: `send_driver:${id}` },
    ]);
  }

  if (['pending', 'accepted', 'preparing'].includes(status)) {
    rows.push([
      { text: '✏️ تعديل كامل',       callback_data: `edit_order:${id}` },
      { text: '🧩 تعديل منتج واحد', callback_data: `choose_item_edit:${id}` },
    ]);
    rows.push([
      { text: '📝 إضافة ملاحظة',     callback_data: `add_note:${id}` },
      { text: '💰 تعديل أجرة التوصيل', callback_data: `edit_delivery_fee:${id}` },
    ]);
    rows.push([
      { text: '⛔ إلغاء الطلب',      callback_data: `cancel_order_m:${id}` },
    ]);
  }

  if (customer_telegram_id) {
    rows.push([
      { text: '💬 مراسلة الزبون',    callback_data: `chat_customer:${id}` },
      { text: '⭐ تقييم الزبون',     callback_data: `rate_customer:${id}` },
    ]);
  }

  rows.push([
    { text: '🔄 تحديث الطلب',       callback_data: `refresh_order:${id}` },
    { text: '« رجوع',               callback_data: `back_orders` },
  ]);

  return send(
    chatId,
    `⚙️ <b>إدارة طلب رقم:</b> <code>${order_number ?? id}</code>\n` +
    `📌 الحالة: <b>${statusText(status)}</b>\n\nاختر الإجراء:`,
    { reply_markup: kb.inline(rows) }
  );
}

// ──────────────────────────────────────────────
// 15. REGISTRATION FLOW
// ──────────────────────────────────────────────

function startRegistration(chatId) {
  sessions.set(chatId, { flow: FLOWS.REGISTER, step: 'store_name' });
  return send(chatId, '🏪 أرسل اسم المتجر:', { reply_markup: kb.remove() });
}

async function handleRegistration(chatId, msg, session) {
  const text = msg.text?.trim();

  switch (session.step) {
    case 'store_name': {
      if (!text || text.length < 2) return send(chatId, '⚠️ اسم المتجر قصير جداً.');
      session.store_name = text;
      session.step = 'phone';
      sessions.set(chatId, session);
      return send(chatId, '📞 شارك رقم هاتف المتجر:', { reply_markup: kb.contact() });
    }

    case 'phone': {
      const phone = msg.contact?.phone_number ?? text;
      if (!phone || phone.length < 7) return send(chatId, '⚠️ أرسل رقم هاتف صحيح.');
      session.phone = phone;
      session.step = 'location';
      sessions.set(chatId, session);
      return send(chatId, '📍 شارك موقع المتجر:', {
        reply_markup: kb.location('📍 مشاركة موقع المتجر'),
      });
    }

    case 'location': {
      if (!msg.location) return send(chatId, '⚠️ اضغط زر مشاركة الموقع.');
      const { latitude: lat, longitude: lng } = msg.location;

      const existing = await getMerchant(chatId);
      if (existing) {
        sessions.delete(chatId);
        return send(chatId, '⚠️ هذا الحساب مسجل مسبقاً.', { reply_markup: kb.remove() });
      }

      const payload = {
        telegram_id: String(chatId),
        store_name: session.store_name,
        phone: session.phone,
        lat, lng,
        active: false,
        is_open: true,
      };

      const { error } = await supabase.from('merchants').insert(payload);
      if (error) throw error;

      await notifyAdminNewMerchant(payload, chatId);
      sessions.delete(chatId);
      return send(
        chatId,
        '✅ تم إرسال طلب التسجيل للإدارة.\n⏳ سيتم مراجعته قريباً.',
        { reply_markup: kb.remove() }
      );
    }
  }
}

// ──────────────────────────────────────────────
// 16. MANUAL ORDER FLOW
// ──────────────────────────────────────────────

function startManualOrder(chatId) {
  sessions.set(chatId, { flow: FLOWS.MANUAL_ORDER, step: 'customer_location' });
  return send(chatId, '📍 أرسل موقع الزبون:', {
    reply_markup: kb.location('📍 مشاركة موقع الزبون'),
  });
}

async function handleManualOrder(chatId, msg, session) {
  const text = msg.text?.trim();

  switch (session.step) {
    case 'customer_location': {
      if (!msg.location) return send(chatId, '⚠️ اضغط زر مشاركة الموقع.');
      session.customer_lat = msg.location.latitude;
      session.customer_lng = msg.location.longitude;
      session.step = 'customer_phone';
      sessions.set(chatId, session);
      return send(chatId, '📱 أرسل رقم هاتف الزبون:', { reply_markup: kb.remove() });
    }

    case 'customer_phone': {
      if (!text || text.length < 7) return send(chatId, '⚠️ رقم غير صحيح.');
      session.customer_phone = text;
      session.step = 'details';
      sessions.set(chatId, session);
      return send(chatId, '📝 أرسل تفاصيل الطلب:');
    }

    case 'details': {
      if (!text || text.length < 3) return send(chatId, '⚠️ التفاصيل قصيرة جداً.');
      session.details = text;
      session.step = 'delivery_fee';
      sessions.set(chatId, session);
      return send(chatId, '💰 أرسل أجرة التوصيل (مثال: 3000):');
    }

    case 'delivery_fee': {
      const fee = parseNumber(text);
      if (!Number.isFinite(fee) || fee < 0) return send(chatId, '⚠️ أرسل رقم صحيح.');
      session.delivery_fee = Math.round(fee);
      session.step = 'total_amount';
      sessions.set(chatId, session);
      return send(chatId, '💰 أرسل المبلغ الكلي للطلب (أو اكتب 0 إذا كان التوصيل فقط):');
    }

    case 'total_amount': {
      const amount = parseNumber(text);
      if (!Number.isFinite(amount) || amount < 0) return send(chatId, '⚠️ أرسل رقم صحيح.');
      session.total_amount = Math.round(amount) + session.delivery_fee;
      session.step = 'confirm';
      sessions.set(chatId, session);

      return send(
        chatId,
        `✅ <b>مراجعة الطلب</b>\n\n` +
        `📱 الزبون: ${esc(session.customer_phone)}\n` +
        `📝 التفاصيل: ${esc(session.details)}\n` +
        `💵 أجرة التوصيل: ${formatAmount(session.delivery_fee)}\n` +
        `💰 المجموع الكلي: ${formatAmount(session.total_amount)}\n\n` +
        `هل تريد إنشاء الطلب؟`,
        {
          reply_markup: kb.inline([
            [{ text: '✅ إنشاء وإرسال للسائقين', callback_data: 'confirm_manual_order' }],
            [{ text: '❌ إلغاء',                  callback_data: 'discard_flow' }],
          ]),
        }
      );
    }
  }
}

async function confirmManualOrder(chatId, messageId) {
  const session = sessions.get(chatId);
  if (!session || session.flow !== FLOWS.MANUAL_ORDER || session.step !== 'confirm') {
    return edit(chatId, messageId, 'انتهت صلاحية الجلسة.');
  }

  const merchant = await getActiveMerchant(chatId);
  if (!merchant) return;

  const orderNumber = await generateOrderNumber();

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      merchant_id: merchant.id,
      notes: session.details,
      customer_phone: session.customer_phone,
      customer_lat: session.customer_lat,
      customer_lng: session.customer_lng,
      address: mapsUrl(session.customer_lat, session.customer_lng),
      delivery_fee: session.delivery_fee,
      total_amount: session.total_amount,
      status: 'accepted',
    })
    .select('*')
    .single();

  if (error) throw error;

  sessions.delete(chatId);
  await edit(chatId, messageId, `✅ تم إنشاء طلب رقم <code>${order.order_number}</code>.`);
  return broadcastToDrivers(order.id, merchant, order, chatId);
}

// ──────────────────────────────────────────────
// 17. ADD PRODUCT FLOW
// ──────────────────────────────────────────────

function startAddProduct(chatId) {
  sessions.set(chatId, { flow: FLOWS.ADD_PRODUCT, step: 'name' });
  return send(chatId, '🛒 أرسل اسم المنتج:', { reply_markup: kb.remove() });
}

async function handleAddProduct(chatId, msg, session) {
  const text = msg.text?.trim();

  switch (session.step) {
    case 'name': {
      if (!text || text.length < 2) return send(chatId, '⚠️ اسم المنتج قصير.');
      session.name = text;
      session.step = 'category';
      sessions.set(chatId, session);
      return send(
        chatId,
        '📂 أرسل تصنيف المنتج (مثال: مناقيش / مشروبات / وجبات) أو اكتب <b>تخطي</b>:',
        {
          reply_markup: kb.inline([
            [{ text: 'تخطي ◀', callback_data: 'product_skip_category' }],
          ]),
        }
      );
    }

    case 'category': {
      session.category = (text === 'تخطي' || !text) ? null : text;
      session.step = 'description';
      sessions.set(chatId, session);
      return send(
        chatId,
        '📝 أرسل وصفاً للمنتج أو اكتب <b>تخطي</b>:',
        {
          reply_markup: kb.inline([
            [{ text: 'تخطي ◀', callback_data: 'product_skip_description' }],
          ]),
        }
      );
    }

    case 'description': {
      session.description = (text === 'تخطي' || !text) ? null : text;
      session.step = 'price';
      sessions.set(chatId, session);
      return send(chatId, '💰 أرسل السعر بالدينار:', { reply_markup: kb.remove() });
    }

    case 'price': {
      const price = parseNumber(text);
      if (!Number.isFinite(price) || price <= 0) return send(chatId, '⚠️ أرسل سعر صحيح أكبر من 0.');
      session.price = Math.round(price);
      session.step = 'image';
      sessions.set(chatId, session);
      return send(
        chatId,
        '🖼️ أرسل <b>صورة</b> أو <b>فيديو</b> للمنتج، أو اضغط تخطي:',
        {
          reply_markup: kb.inline([
            [{ text: 'تخطي ◀ (بدون وسائط)', callback_data: 'product_skip_image' }],
          ]),
        }
      );
    }

    // ── NEW: handles both photo AND video ──
    case 'image': {
      if (text === 'تخطي') {
        session.image_file_id  = null;
        session.video_file_id  = null;
        session.media_type     = null;
      } else if (msg.photo?.length) {
        // صورة
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        session.image_file_id = fileId;
        session.video_file_id = null;
        session.media_type    = 'photo';

        if (CONFIG.productImagesChannelId) {
          try {
            const saved = await bot.sendPhoto(CONFIG.productImagesChannelId, fileId, {
              caption: `product:${chatId}:${Date.now()}`,
            });
            session.image_channel_id  = String(CONFIG.productImagesChannelId);
            session.image_message_id  = saved.message_id;
          } catch (err) {
            logError('saveProductImage', err);
          }
        }
      } else if (msg.video) {
        // فيديو ← NEW
        const fileId = msg.video.file_id;
        session.video_file_id = fileId;
        session.image_file_id = null;
        session.media_type    = 'video';

        if (CONFIG.productImagesChannelId) {
          try {
            const saved = await bot.sendVideo(CONFIG.productImagesChannelId, fileId, {
              caption: `product_video:${chatId}:${Date.now()}`,
            });
            session.image_channel_id  = String(CONFIG.productImagesChannelId);
            session.image_message_id  = saved.message_id;
          } catch (err) {
            logError('saveProductVideo', err);
          }
        }
      } else {
        return send(chatId, '⚠️ أرسل صورة أو فيديو، أو اضغط تخطي.');
      }

      session.step = 'confirm';
      sessions.set(chatId, session);

      const mediaLabel = session.media_type === 'photo'
        ? '🖼️ صورة ✅'
        : session.media_type === 'video'
          ? '🎥 فيديو ✅'
          : 'لا توجد وسائط';

      return send(
        chatId,
        `✅ <b>مراجعة المنتج</b>\n\n` +
        `🛒 الاسم: ${esc(session.name)}\n` +
        `📂 التصنيف: ${esc(session.category ?? 'بدون تصنيف')}\n` +
        `📝 الوصف: ${esc(session.description ?? 'لا يوجد')}\n` +
        `💰 السعر: ${formatAmount(session.price)}\n` +
        `📎 الوسائط: ${mediaLabel}\n\n` +
        `هل تريد حفظ المنتج؟`,
        {
          reply_markup: kb.inline([
            [{ text: '✅ حفظ المنتج', callback_data: 'confirm_add_product' }],
            [{ text: '❌ إلغاء',       callback_data: 'discard_flow' }],
          ]),
        }
      );
    }
  }
}

async function confirmAddProduct(chatId, messageId) {
  const session = sessions.get(chatId);
  if (!session || session.flow !== FLOWS.ADD_PRODUCT) {
    return edit(chatId, messageId, 'انتهت صلاحية الجلسة.');
  }

  const merchant = await getActiveMerchant(chatId);
  if (!merchant) return;

  const { count } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchant.id);

  if (count >= CONFIG.maxProductsPerMerchant) {
    sessions.delete(chatId);
    return edit(chatId, messageId, `⚠️ وصلت الحد الأقصى (${CONFIG.maxProductsPerMerchant} منتج).`);
  }

  const { error } = await supabase.from('products').insert({
    merchant_id:      merchant.id,
    name:             session.name,
    category:         session.category,
    description:      session.description,
    price:            session.price,
    image_file_id:    session.image_file_id  ?? null,  // صورة
    video_file_id:    session.video_file_id  ?? null,  // فيديو ← NEW column
    media_type:       session.media_type     ?? null,  // 'photo' | 'video' | null ← NEW column
    image_channel_id: session.image_channel_id ?? null,
    image_message_id: session.image_message_id ?? null,
    is_available:     true,
  });

  if (error) throw error;

  sessions.delete(chatId);
  await edit(chatId, messageId, '✅ تم حفظ المنتج بنجاح.');
  return send(chatId, 'اختر من القائمة:', { reply_markup: kb.main() });
}

// ──────────────────────────────────────────────
// 18. PRODUCT LISTING — now shows video too
// ──────────────────────────────────────────────

async function showProducts(chatId, merchant) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('merchant_id', merchant.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!data?.length) return send(chatId, '📋 لا توجد منتجات بعد.\nاضغط 🛒 إضافة منتج لإضافة أول منتج.');

  await send(chatId, `📋 <b>منتجاتك</b> — الإجمالي: <b>${data.length}</b>`);

  for (const p of data) {
    const caption =
      `🛒 <b>${esc(p.name)}</b>\n` +
      `📂 ${esc(p.category ?? 'بدون تصنيف')}\n` +
      `💰 ${formatAmount(p.price)}\n` +
      `📌 ${p.is_available ? '🟢 ظاهر للزبائن' : '🔴 مخفي'}\n` +
      `📝 ${esc(p.description ?? 'لا يوجد وصف')}`;

    const markup = kb.inline([
      [
        { text: p.is_available ? '🔴 إخفاء' : '🟢 إظهار', callback_data: `toggle_product:${p.id}` },
        { text: '🗑 حذف',                                   callback_data: `delete_product:${p.id}` },
      ],
      [
        { text: '✏️ تعديل السعر',     callback_data: `edit_price:${p.id}` },
        { text: '📝 تعديل الوصف',     callback_data: `edit_desc:${p.id}` },
      ],
      [
        { text: '📎 تعديل الوسائط',   callback_data: `edit_product_media:${p.id}` }, // ← NEW
      ],
    ]);

    // عرض الفيديو إذا وُجد، وإلا الصورة ← NEW logic
    if (p.media_type === 'video' && p.video_file_id) {
      try {
        await bot.sendVideo(chatId, p.video_file_id, { caption, parse_mode: 'HTML', reply_markup: markup });
        continue;
      } catch (_) {}
    } else if (p.image_file_id) {
      try {
        await bot.sendPhoto(chatId, p.image_file_id, { caption, parse_mode: 'HTML', reply_markup: markup });
        continue;
      } catch (_) {}
    }
    await send(chatId, caption, { reply_markup: markup });
  }
}

// ──────────────────────────────────────────────
// NEW 18b. EDIT PRODUCT MEDIA FLOW
// ──────────────────────────────────────────────

async function startEditProductMedia(chatId, productId) {
  sessions.set(chatId, { flow: FLOWS.EDIT_PRODUCT_MEDIA, product_id: productId });
  return send(
    chatId,
    '📎 أرسل <b>صورة</b> أو <b>فيديو</b> جديد للمنتج، أو اضغط حذف الوسائط:',
    {
      reply_markup: kb.inline([
        [{ text: '🗑 حذف الوسائط', callback_data: `delete_product_media:${productId}` }],
        [{ text: '❌ إلغاء',        callback_data: 'discard_flow' }],
      ]),
    }
  );
}

async function handleEditProductMedia(chatId, msg, session) {
  const merchant = await getActiveMerchant(chatId);
  if (!merchant) return;

  let updatePayload = {};

  if (msg.photo?.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    updatePayload = { image_file_id: fileId, video_file_id: null, media_type: 'photo' };

    if (CONFIG.productImagesChannelId) {
      try {
        const saved = await bot.sendPhoto(CONFIG.productImagesChannelId, fileId, {
          caption: `product_edit:${chatId}:${Date.now()}`,
        });
        updatePayload.image_channel_id = String(CONFIG.productImagesChannelId);
        updatePayload.image_message_id = saved.message_id;
      } catch (err) {
        logError('saveEditedProductImage', err);
      }
    }
  } else if (msg.video) {
    const fileId = msg.video.file_id;
    updatePayload = { video_file_id: fileId, image_file_id: null, media_type: 'video' };

    if (CONFIG.productImagesChannelId) {
      try {
        const saved = await bot.sendVideo(CONFIG.productImagesChannelId, fileId, {
          caption: `product_video_edit:${chatId}:${Date.now()}`,
        });
        updatePayload.image_channel_id = String(CONFIG.productImagesChannelId);
        updatePayload.image_message_id = saved.message_id;
      } catch (err) {
        logError('saveEditedProductVideo', err);
      }
    }
  } else {
    return send(chatId, '⚠️ أرسل صورة أو فيديو فقط.');
  }

  const { error } = await supabase
    .from('products')
    .update(updatePayload)
    .eq('id', session.product_id)
    .eq('merchant_id', merchant.id);

  if (error) throw error;

  sessions.delete(chatId);
  return send(
    chatId,
    updatePayload.media_type === 'video'
      ? '✅ تم تحديث فيديو المنتج.'
      : '✅ تم تحديث صورة المنتج.',
    { reply_markup: kb.main() }
  );
}

// ──────────────────────────────────────────────
// NEW 18c. STORE IMAGE FLOW
// ──────────────────────────────────────────────

async function startUploadStoreImage(chatId) {
  sessions.set(chatId, { flow: FLOWS.UPLOAD_STORE_IMAGE });
  return send(
    chatId,
    '🏪 أرسل صورة المتجر (تظهر للزبائن في قائمة المتاجر):',
    {
      reply_markup: kb.inline([
        [{ text: '🗑 حذف الصورة الحالية', callback_data: 'delete_store_image' }],
        [{ text: '❌ إلغاء',               callback_data: 'discard_flow' }],
      ]),
    }
  );
}

async function handleUploadStoreImage(chatId, msg, session) {
  const merchant = await getActiveMerchant(chatId);
  if (!merchant) return;

  if (!msg.photo?.length) return send(chatId, '⚠️ أرسل صورة فقط (لا يدعم فيديو لصورة المتجر).');

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  let storeImageChannelId   = null;
  let storeImageMessageId   = null;

  // حفظ في قناة الصور إن وُجدت
  const channelTarget = CONFIG.storeImagesChannelId || CONFIG.productImagesChannelId;
  if (channelTarget) {
    try {
      const saved = await bot.sendPhoto(channelTarget, fileId, {
        caption: `store_image:${merchant.id}:${Date.now()}`,
      });
      storeImageChannelId = String(channelTarget);
      storeImageMessageId = saved.message_id;
    } catch (err) {
      logError('saveStoreImage', err);
    }
  }

  const { error } = await supabase
    .from('merchants')
    .update({
      store_image_file_id:    fileId,               // ← NEW column in merchants table
      store_image_channel_id: storeImageChannelId,  // ← NEW column
      store_image_message_id: storeImageMessageId,  // ← NEW column
    })
    .eq('id', merchant.id);

  if (error) throw error;

  sessions.delete(chatId);

  // معاينة فورية
  try {
    await bot.sendPhoto(chatId, fileId, {
      caption: `✅ تم حفظ صورة المتجر <b>${esc(merchant.store_name)}</b>.`,
      parse_mode: 'HTML',
      reply_markup: kb.main(),
    });
  } catch (_) {
    await send(chatId, '✅ تم حفظ صورة المتجر.', { reply_markup: kb.main() });
  }
}

// ──────────────────────────────────────────────
// 19. ORDER LISTING
// ──────────────────────────────────────────────

async function showNewOrders(chatId, merchant) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('merchant_id', merchant.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) throw error;
  if (!data?.length) return send(chatId, '✅ لا توجد طلبات جديدة.');

  await send(chatId, `📥 <b>الطلبات الجديدة</b> — ${data.length} طلب`);
  for (const o of data) await sendOrderCard(chatId, o);
}

async function showMerchantOrders(chatId, merchant, page = 0) {
  const limit = CONFIG.orderPageSize;
  const offset = page * limit;

  const { data, error, count } = await supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('merchant_id', merchant.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  if (!data?.length) return send(chatId, 'لا توجد طلبات بعد.');

  const totalPages = Math.ceil((count ?? 0) / limit);
  await send(chatId, `📦 <b>طلباتك</b> — صفحة ${page + 1} / ${totalPages}`);

  for (const o of data) await sendOrderCard(chatId, o);

  if (totalPages > 1) {
    const navRows = [];
    if (page > 0) navRows.push({ text: '◀ السابق', callback_data: `orders_page:${page - 1}` });
    if (page < totalPages - 1) navRows.push({ text: 'التالي ▶', callback_data: `orders_page:${page + 1}` });
    if (navRows.length) {
      await send(chatId, '⬆️ التنقل بين الصفحات:', { reply_markup: kb.inline([navRows]) });
    }
  }
}

// ──────────────────────────────────────────────
// 20. STATS
// ──────────────────────────────────────────────

async function showStats(chatId, merchant) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const { data, error } = await supabase
    .from('orders')
    .select('status,total_amount,delivery_fee,created_at')
    .eq('merchant_id', merchant.id);

  if (error) throw error;

  const all = data ?? [];
  const todayOrders = all.filter((o) => new Date(o.created_at) >= today);
  const weekOrders  = all.filter((o) => new Date(o.created_at) >= weekAgo);
  const delivered   = all.filter((o) => o.status === 'delivered');
  const pending     = all.filter((o) => o.status === 'pending');
  const cancelled   = all.filter((o) => ['cancelled', 'rejected'].includes(o.status));

  const totalSales       = delivered.reduce((s, o) => s + Number(o.total_amount  ?? 0), 0);
  const deliveryEarnings = delivered.reduce((s, o) => s + Number(o.delivery_fee  ?? 0), 0);
  const weekSales        = weekOrders.filter((o) => o.status === 'delivered')
                                     .reduce((s, o) => s + Number(o.total_amount ?? 0), 0);

  return send(
    chatId,
    `📊 <b>إحصائيات المتجر</b>\n\n` +
    `<b>اليوم</b>\n` +
    `  📥 طلبات: <b>${todayOrders.length}</b>\n\n` +
    `<b>الأسبوع</b>\n` +
    `  📦 طلبات: <b>${weekOrders.length}</b>\n` +
    `  💰 مبيعات: <b>${formatAmount(weekSales)}</b>\n\n` +
    `<b>الإجمالي</b>\n` +
    `  ⏳ بانتظارك: <b>${pending.length}</b>\n` +
    `  🎉 مكتملة: <b>${delivered.length}</b>\n` +
    `  ❌ ملغاة/مرفوضة: <b>${cancelled.length}</b>\n` +
    `  💰 إجمالي المبيعات: <b>${formatAmount(totalSales)}</b>\n` +
    `  💵 أرباح التوصيل: <b>${formatAmount(deliveryEarnings)}</b>`
  );
}

// ──────────────────────────────────────────────
// 21. STORE SETTINGS — now includes store image option
// ──────────────────────────────────────────────

async function showStoreSettings(chatId, merchant) {
  const hasStoreImage = !!merchant.store_image_file_id;

  const settingsText =
    `⚙️ <b>إعدادات المتجر</b>\n\n` +
    `🏪 الاسم: ${esc(merchant.store_name)}\n` +
    `📞 الهاتف: ${esc(merchant.phone)}\n` +
    `📌 الحالة: ${merchant.is_open ? '🟢 مفتوح' : '🔴 مغلق'}\n` +
    `🖼️ صورة المتجر: ${hasStoreImage ? '✅ موجودة' : '❌ لا توجد'}`;

  const markup = kb.inline([
    [
      { text: merchant.is_open ? '🔴 إغلاق المتجر' : '🟢 فتح المتجر',
        callback_data: 'toggle_store' },
    ],
    [
      { text: '🖼️ رفع صورة المتجر',  callback_data: 'upload_store_image' }, // ← NEW
      { text: '👁 عرض صورة المتجر',  callback_data: 'view_store_image'   }, // ← NEW
    ],
    [
      { text: '📍 تحديث الموقع',      callback_data: 'update_location' },
      { text: '📞 تحديث الهاتف',      callback_data: 'update_phone' },
    ],
  ]);

  // عرض الصورة الحالية إن وُجدت
  if (hasStoreImage) {
    try {
      return bot.sendPhoto(chatId, merchant.store_image_file_id, {
        caption: settingsText,
        parse_mode: 'HTML',
        reply_markup: markup,
      });
    } catch (_) {}
  }

  return send(chatId, settingsText, { reply_markup: markup });
}

async function toggleStore(chatId, merchant) {
  const next = !merchant.is_open;
  const { error } = await supabase
    .from('merchants')
    .update({ is_open: next })
    .eq('id', merchant.id);
  if (error) throw error;
  return send(
    chatId,
    next ? '🟢 تم فتح المتجر.' : '🔴 تم إغلاق المتجر.',
    { reply_markup: kb.main() }
  );
}

// ──────────────────────────────────────────────
// 22. ORDER ITEM HELPERS
// ──────────────────────────────────────────────

function parseOrderItems(text) {
  const lines = String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) throw new Error('لا توجد بيانات.');

  const items = lines.map((line) => {
    const parts = line.split('|').map((x) => x.trim());
    if (parts.length < 3) throw new Error('صيغة غير صحيحة: ' + line);

    const name  = parts[0];
    const price = parseNumber(parts[1]);
    const qty   = parseNumber(parts[2]);

    if (!name) throw new Error('اسم فارغ: ' + line);
    if (!Number.isFinite(price) || price <= 0) throw new Error('سعر غير صحيح: ' + line);
    if (!Number.isFinite(qty)   || qty   <= 0) throw new Error('كمية غير صحيحة: ' + line);

    return { name, price: Math.round(price), qty: Math.round(qty), total: Math.round(price) * Math.round(qty) };
  });

  const totalAmount = items.reduce((s, i) => s + i.total, 0);
  const notes = items.map((i) => `${i.name} × ${i.qty} = ${formatAmount(i.total)}`).join('\n');
  return { items, notes, totalAmount };
}

function rebuildOrder(items) {
  const normalized = items.map((i) => ({
    ...i,
    price: Math.round(Number(i.price ?? 0)),
    qty:   Math.round(Number(i.qty   ?? 0)),
    total: Math.round(Number(i.price ?? 0)) * Math.round(Number(i.qty ?? 0)),
  }));
  const totalAmount = normalized.reduce((s, i) => s + i.total, 0);
  const notes = normalized.map((i) => `${i.name} × ${i.qty} = ${formatAmount(i.total)}`).join('\n');
  return { items: normalized, notes, totalAmount };
}

function buildItemsKeyboard(order) {
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  if (!items.length) return null;

  const rows = items.map((item, i) => [
    { text: `✏️ ${item.name} (${formatAmount(item.price)} × ${item.qty})`, callback_data: `edit_one_item:${order.id}:${i}` },
  ]);
  rows.push([{ text: '« رجوع', callback_data: `manage_order:${order.id}` }]);
  return kb.inline(rows);
}

// ──────────────────────────────────────────────
// 23. /start
// ──────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await requireSubscription(chatId))) return;

  try {
    const merchant = await getMerchant(chatId);

    if (!merchant) return startRegistration(chatId);

    if (!merchant.active) {
      return send(chatId, '⏳ حسابك قيد المراجعة من الإدارة.', { reply_markup: kb.remove() });
    }

    return send(
      chatId,
      `👋 أهلاً <b>${esc(merchant.store_name)}</b>!\n\n` +
      `حالة المتجر: ${merchant.is_open ? '🟢 مفتوح' : '🔴 مغلق'}\n\n` +
      `لوحة التاجر جاهزة.`,
      { reply_markup: kb.main() }
    );
  } catch (err) {
    logError('/start', err);
    return send(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.');
  }
});

// ──────────────────────────────────────────────
// 24. /cancel
// ──────────────────────────────────────────────

bot.onText(/\/cancel/, async (msg) => {
  sessions.delete(msg.chat.id);
  return send(msg.chat.id, '🚫 تم إلغاء العملية.', { reply_markup: kb.main() });
});

// ──────────────────────────────────────────────
// 25. /stats
// ──────────────────────────────────────────────

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await requireSubscription(chatId))) return;
  try {
    const merchant = await getActiveMerchant(chatId);
    if (merchant) await showStats(chatId, merchant);
  } catch (err) {
    logError('/stats', err);
  }
});

// ──────────────────────────────────────────────
// 26. MESSAGE HANDLER
// ──────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (text?.startsWith('/')) return;
  if (!(await requireSubscription(chatId))) return;

  const session = sessions.get(chatId);

  try {
    // ── Session flows ──
    if (session?.flow === FLOWS.REGISTER)           return handleRegistration(chatId, msg, session);
    if (session?.flow === FLOWS.MANUAL_ORDER)        return handleManualOrder(chatId, msg, session);
    if (session?.flow === FLOWS.ADD_PRODUCT)         return handleAddProduct(chatId, msg, session);

    // ← NEW: صورة/فيديو المتجر
    if (session?.flow === FLOWS.UPLOAD_STORE_IMAGE)  return handleUploadStoreImage(chatId, msg, session);

    // ← NEW: تعديل وسائط المنتج
    if (session?.flow === FLOWS.EDIT_PRODUCT_MEDIA)  return handleEditProductMedia(chatId, msg, session);

    if (session?.flow === FLOWS.EDIT_PRICE) {
      const price = parseNumber(text);
      if (!Number.isFinite(price) || price <= 0) return send(chatId, '⚠️ أرسل سعر صحيح.');
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const { error } = await supabase
        .from('products')
        .update({ price: Math.round(price) })
        .eq('id', session.product_id)
        .eq('merchant_id', merchant.id);
      if (error) throw error;
      sessions.delete(chatId);
      return send(chatId, '✅ تم تعديل السعر.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.REJECT_REASON) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const reason = text || 'لم يُذكر السبب';
      const order = await updateOrder(session.order_id, merchant.id, {
        status: 'rejected',
        reject_reason: reason,
      });
      sessions.delete(chatId);
      await notifyCustomer(
        order,
        `⛔ <b>تم رفض طلبك</b>\n\n` +
        `🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n` +
        `📝 السبب: ${esc(reason)}`
      );
      return send(chatId, '✅ تم رفض الطلب وإشعار الزبون.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.CANCEL_ORDER) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const reason = text || 'لم يُذكر السبب';
      const order = await updateOrder(session.order_id, merchant.id, {
        status: 'cancelled',
        cancel_reason: reason,
      });
      sessions.delete(chatId);
      await notifyCustomer(
        order,
        `❌ <b>تم إلغاء طلبك</b>\n\n` +
        `🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n` +
        `📝 السبب: ${esc(reason)}`
      );
      return send(chatId, '✅ تم إلغاء الطلب وإشعار الزبون.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.ADD_NOTE) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      await updateOrder(session.order_id, merchant.id, { merchant_note: text });
      sessions.delete(chatId);
      return send(chatId, '✅ تم حفظ الملاحظة.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.SET_DELIVERY_FEE) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const fee = parseNumber(text);
      if (!Number.isFinite(fee) || fee < 0) return send(chatId, '⚠️ أرسل رقم صحيح.');
      const order = await getOrder(session.order_id, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      const itemsTotal = (Array.isArray(order.order_items) ? order.order_items : [])
        .reduce((s, i) => s + Number(i.total ?? 0), 0);
      await updateOrder(session.order_id, merchant.id, {
        delivery_fee: Math.round(fee),
        total_amount: itemsTotal + Math.round(fee),
      });
      sessions.delete(chatId);
      return send(chatId, `✅ تم تحديث أجرة التوصيل إلى ${formatAmount(fee)}.`, { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.EDIT_ORDER) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      let parsed;
      try {
        parsed = parseOrderItems(text);
      } catch (e) {
        return send(
          chatId,
          `❌ ${esc(e.message)}\n\nالصيغة الصحيحة:\nاسم المنتج | السعر | الكمية\n\nمثال:\nمناقيش جبن | 2000 | 2\nبيبسي | 1000 | 1`
        );
      }
      const order = await updateOrder(session.order_id, merchant.id, {
        notes: parsed.notes,
        merchant_note: 'تم التعديل الكامل',
        order_items: parsed.items,
        total_amount: parsed.totalAmount,
      });
      sessions.delete(chatId);
      await notifyCustomer(
        order,
        `✏️ <b>تم تعديل طلبك</b>\n\n` +
        `🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n\n` +
        `🛒 <b>التفاصيل الجديدة:</b>\n${esc(parsed.notes)}\n\n` +
        `💰 <b>المجموع الجديد:</b> ${formatAmount(parsed.totalAmount)}`
      );
      return send(chatId, '✅ تم تعديل الطلب وإشعار الزبون.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.EDIT_SINGLE_ITEM) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const parts = String(text ?? '').split('|').map((x) => x.trim());
      if (parts.length < 2) return send(chatId, '❌ الصيغة: السعر | الكمية\nمثال: 2500 | 3');
      const newPrice = parseNumber(parts[0]);
      const newQty   = parseNumber(parts[1]);
      if (!Number.isFinite(newPrice) || newPrice <= 0) return send(chatId, '⚠️ سعر غير صحيح.');
      if (!Number.isFinite(newQty)   || newQty   <= 0) return send(chatId, '⚠️ كمية غير صحيحة.');

      const order = await getOrder(session.order_id, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      const items = Array.isArray(order.order_items) ? [...order.order_items] : [];
      const old = items[session.item_index];
      if (!old) return send(chatId, '❌ المنتج غير موجود.');
      items[session.item_index] = { ...old, price: Math.round(newPrice), qty: Math.round(newQty), total: Math.round(newPrice) * Math.round(newQty) };
      const rebuilt = rebuildOrder(items);
      const updated = await updateOrder(session.order_id, merchant.id, {
        order_items: rebuilt.items,
        notes: rebuilt.notes,
        total_amount: rebuilt.totalAmount,
        merchant_note: `تم تعديل ${old.name}`,
      });
      sessions.delete(chatId);
      await notifyCustomer(
        updated,
        `✏️ <b>تم تعديل منتج في طلبك</b>\n\n` +
        `🆔 رقم الطلب: <code>${updated.order_number ?? updated.id}</code>\n` +
        `🛒 ${esc(old.name)}\n` +
        `💰 السعر الجديد: ${formatAmount(newPrice)}\n` +
        `🔢 الكمية الجديدة: ${Math.round(newQty)}\n` +
        `💰 المجموع الجديد: <b>${formatAmount(rebuilt.totalAmount)}</b>`
      );
      return send(chatId, '✅ تم تعديل المنتج.', { reply_markup: kb.main() });
    }

    if (session?.flow === FLOWS.CHAT_CUSTOMER) {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      const order = await getOrder(session.order_id, merchant.id);
      if (!order) { sessions.delete(chatId); return send(chatId, '❌ الطلب غير موجود.'); }
      if (!order.customer_telegram_id) { sessions.delete(chatId); return send(chatId, '❌ لا يوجد معرف للزبون.'); }
      await supabase.from('order_messages').insert({
        order_id: order.id,
        sender_type: 'merchant',
        sender_telegram_id: String(chatId),
        receiver_type: 'customer',
        receiver_telegram_id: order.customer_telegram_id,
        message: text,
      });
      await notifyCustomer(
        order,
        `🏪 <b>رسالة من المتجر</b>\n\n` +
        `🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n\n` +
        `💬 ${esc(text)}`
      );
      sessions.delete(chatId);
      return send(chatId, '✅ تم إرسال الرسالة للزبون.', { reply_markup: kb.main() });
    }

    // ── Menu commands ──
    const merchant = await getActiveMerchant(chatId);
    if (!merchant) return;

    const handlers = {
      '➕ طلب يدوي':          () => startManualOrder(chatId),
      '🛒 إضافة منتج':        () => startAddProduct(chatId),
      '📋 منتجاتي':           () => showProducts(chatId, merchant),
      '📥 الطلبات الجديدة':   () => showNewOrders(chatId, merchant),
      '📦 طلباتي':            () => showMerchantOrders(chatId, merchant),
      '📊 الإحصائيات':        () => showStats(chatId, merchant),
      '🏪 حالة المتجر':       () => showStoreSettings(chatId, merchant),
      '⚙️ إعدادات المتجر':   () => showStoreSettings(chatId, merchant),
      'ℹ️ معلومات حسابي': () =>
        send(
          chatId,
          `🏪 المتجر: <b>${esc(merchant.store_name)}</b>\n` +
          `📞 الهاتف: ${esc(merchant.phone ?? '')}\n` +
          `📌 الحالة: ${merchant.is_open ? '🟢 مفتوح' : '🔴 مغلق'}\n` +
          `✅ الحساب: مفعل`,
          { reply_markup: kb.main() }
        ),
    };

    if (handlers[text]) return handlers[text]();
    return send(chatId, 'اختر من الأزرار أدناه:', { reply_markup: kb.main() });
  } catch (err) {
    logError('message', err);
    return send(chatId, '❌ حدث خطأ أثناء التنفيذ. يرجى المحاولة مجدداً.');
  }
});

// ──────────────────────────────────────────────
// 27. CALLBACK QUERY HANDLER
// ──────────────────────────────────────────────

bot.on('callback_query', async (q) => {
  const chatId    = q.message.chat.id;
  const messageId = q.message.message_id;
  const action    = q.data;
  const userId    = String(q.from.id);

  await bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    if (action === 'discard_flow') {
      sessions.delete(chatId);
      await edit(chatId, messageId, '🚫 تم إلغاء العملية.');
      return send(chatId, 'اختر من القائمة:', { reply_markup: kb.main() });
    }

    if (action === 'confirm_manual_order') return confirmManualOrder(chatId, messageId);
    if (action === 'confirm_add_product')  return confirmAddProduct(chatId, messageId);

    // ── NEW: صورة المتجر ──
    if (action === 'upload_store_image') {
      return startUploadStoreImage(chatId);
    }

    if (action === 'view_store_image') {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      if (!merchant.store_image_file_id) return send(chatId, '⚠️ لا توجد صورة للمتجر حالياً.');
      return bot.sendPhoto(chatId, merchant.store_image_file_id, {
        caption: `🏪 صورة متجر <b>${esc(merchant.store_name)}</b>`,
        parse_mode: 'HTML',
      });
    }

    if (action === 'delete_store_image') {
      const merchant = await getActiveMerchant(chatId);
      if (!merchant) return;
      await supabase
        .from('merchants')
        .update({ store_image_file_id: null, store_image_channel_id: null, store_image_message_id: null })
        .eq('id', merchant.id);
      sessions.delete(chatId);
      return edit(chatId, messageId, '🗑 تم حذف صورة المتجر.');
    }

    // ── NEW: تعديل وسائط المنتج ──
    if (action.startsWith('edit_product_media:')) {
      const productId = action.split(':')[1];
      return startEditProductMedia(chatId, productId);
    }

    if (action.startsWith('delete_product_media:')) {
      const productId = action.split(':')[1];
      const merchant  = await getActiveMerchant(chatId);
      if (!merchant) return;
      await supabase
        .from('products')
        .update({ image_file_id: null, video_file_id: null, media_type: null })
        .eq('id', productId)
        .eq('merchant_id', merchant.id);
      sessions.delete(chatId);
      return edit(chatId, messageId, '🗑 تم حذف وسائط المنتج.');
    }

    // Skip steps in add-product flow
    if (action === 'product_skip_category') {
      const s = sessions.get(chatId);
      if (s?.flow === FLOWS.ADD_PRODUCT && s.step === 'category') {
        s.category = null; s.step = 'description'; sessions.set(chatId, s);
        return send(chatId, '📝 أرسل وصفاً للمنتج أو اكتب تخطي:');
      }
    }
    if (action === 'product_skip_description') {
      const s = sessions.get(chatId);
      if (s?.flow === FLOWS.ADD_PRODUCT && s.step === 'description') {
        s.description = null; s.step = 'price'; sessions.set(chatId, s);
        return send(chatId, '💰 أرسل السعر بالدينار:');
      }
    }
    if (action === 'product_skip_image') {
      const s = sessions.get(chatId);
      if (s?.flow === FLOWS.ADD_PRODUCT && s.step === 'image') {
        s.image_file_id = null; s.video_file_id = null; s.media_type = null;
        s.step = 'confirm'; sessions.set(chatId, s);
        return send(
          chatId,
          `✅ <b>مراجعة المنتج</b>\n\n🛒 ${esc(s.name)}\n📂 ${esc(s.category ?? 'بدون')}\n💰 ${formatAmount(s.price)}\n📎 بدون وسائط\n\nهل تريد حفظ المنتج؟`,
          { reply_markup: kb.inline([[{ text: '✅ حفظ', callback_data: 'confirm_add_product' }], [{ text: '❌ إلغاء', callback_data: 'discard_flow' }]]) }
        );
      }
    }

    if (action === 'back_orders') {
      const merchant = await getActiveMerchant(chatId);
      if (merchant) return showMerchantOrders(chatId, merchant);
      return;
    }

    if (action === 'toggle_store') {
      const merchant = await getActiveMerchant(chatId);
      if (merchant) return toggleStore(chatId, merchant);
      return;
    }

    if (action.startsWith('orders_page:')) {
      const page = Number(action.split(':')[1]);
      const merchant = await getActiveMerchant(chatId);
      if (merchant) return showMerchantOrders(chatId, merchant, page);
      return;
    }

    const merchant = await getActiveMerchant(chatId);

    if (action.startsWith('manage_order:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      return sendManageMenu(chatId, order);
    }

    if (action.startsWith('accept_order_m:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await setOrderStatus(orderId, merchant.id, 'accepted');
      await notifyCustomer(
        order,
        `✅ <b>تم قبول طلبك</b>\n\n🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n📌 الحالة: ${statusText('accepted')}`
      );
      await edit(chatId, messageId, `✅ تم قبول طلب <code>${order.order_number ?? order.id}</code>.`);
      return sendManageMenu(chatId, order);
    }

    if (action.startsWith('reject_order_m:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.REJECT_REASON, order_id: orderId });
      return send(chatId, '✍️ اكتب سبب الرفض ليصل للزبون:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('cancel_order_m:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.CANCEL_ORDER, order_id: orderId });
      return send(chatId, '✍️ اكتب سبب الإلغاء للزبون:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('status_order:')) {
      if (!merchant) return;
      const [, orderId, status] = action.split(':');
      const order = await setOrderStatus(orderId, merchant.id, status);
      await notifyCustomer(
        order,
        `📦 <b>تحديث حالة طلبك</b>\n\n🆔 رقم الطلب: <code>${order.order_number ?? order.id}</code>\n📌 الحالة: <b>${statusText(status)}</b>`
      );
      await edit(chatId, messageId, `✅ الحالة: <b>${statusText(status)}</b> — طلب <code>${order.order_number ?? order.id}</code>`);
      return sendManageMenu(chatId, order);
    }

    if (action.startsWith('send_driver:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      if (order.status === 'pending') return send(chatId, '⚠️ يجب قبول الطلب أولاً.');
      await supabase.from('orders').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', orderId);
      return broadcastToDrivers(order.id, merchant, { ...order, status: 'ready' }, chatId);
    }

    if (action.startsWith('refresh_order:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      return sendOrderCard(chatId, order);
    }

    if (action.startsWith('edit_order:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      if (!['pending', 'accepted', 'preparing'].includes(order.status)) {
        return send(chatId, '⚠️ لا يمكن تعديل الطلب بعد هذه المرحلة.');
      }
      sessions.set(chatId, { flow: FLOWS.EDIT_ORDER, order_id: orderId });
      return send(
        chatId,
        `✏️ أرسل تفاصيل الطلب المعدلة:\n\n` +
        `اسم المنتج | السعر | الكمية\n\n` +
        `مثال:\nمناقيش جبن | 2000 | 2\nبيبسي | 1000 | 1\n\n` +
        `التفاصيل الحالية:\n${esc(order.notes ?? '')}`,
        { reply_markup: kb.remove() }
      );
    }

    if (action.startsWith('choose_item_edit:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      const itemsKb = buildItemsKeyboard(order);
      if (!itemsKb) return send(chatId, '⚠️ هذا الطلب لا يحتوي منتجات قابلة للتعديل.');
      return send(chatId, `🧩 اختر المنتج الذي تريد تعديله:`, { reply_markup: itemsKb });
    }

    if (action.startsWith('edit_one_item:')) {
      if (!merchant) return;
      const [, orderId, rawIdx] = action.split(':');
      const itemIndex = Number(rawIdx);
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      const items = Array.isArray(order.order_items) ? order.order_items : [];
      const item = items[itemIndex];
      if (!item) return send(chatId, '❌ المنتج غير موجود.');
      sessions.set(chatId, { flow: FLOWS.EDIT_SINGLE_ITEM, order_id: orderId, item_index: itemIndex });
      return send(
        chatId,
        `✏️ <b>تعديل: ${esc(item.name)}</b>\n\n` +
        `السعر الحالي: ${formatAmount(item.price)}\n` +
        `الكمية الحالية: ${item.qty}\n\n` +
        `أرسل السعر والكمية بهذه الصيغة:\n<code>السعر | الكمية</code>\nمثال: <code>2500 | 3</code>`,
        { reply_markup: kb.remove() }
      );
    }

    if (action.startsWith('add_note:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.ADD_NOTE, order_id: orderId });
      return send(chatId, '📝 أرسل ملاحظتك على الطلب:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('edit_delivery_fee:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.SET_DELIVERY_FEE, order_id: orderId });
      return send(chatId, '💰 أرسل أجرة التوصيل الجديدة:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('chat_customer:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.CHAT_CUSTOMER, order_id: orderId });
      return send(chatId, '💬 اكتب الرسالة للزبون:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('rate_customer:')) {
      if (!merchant) return;
      const orderId = action.split(':')[1];
      const order = await getOrder(orderId, merchant.id);
      if (!order) return send(chatId, '❌ الطلب غير موجود.');
      return send(chatId, '⭐ اختر تقييم الزبون:', {
        reply_markup: kb.inline([
          [
            { text: '😊 ممتاز (5)', callback_data: `save_rating:${order.customer_telegram_id}:5` },
            { text: '🙂 جيد (4)',   callback_data: `save_rating:${order.customer_telegram_id}:4` },
          ],
          [
            { text: '😐 متوسط (3)', callback_data: `save_rating:${order.customer_telegram_id}:3` },
            { text: '😠 سيء (2)',   callback_data: `save_rating:${order.customer_telegram_id}:2` },
          ],
          [
            { text: '😡 سيء جداً (1)', callback_data: `save_rating:${order.customer_telegram_id}:1` },
          ],
        ]),
      });
    }

    if (action.startsWith('save_rating:')) {
      if (!merchant) return;
      const [, customerTgId, rating] = action.split(':');
      await supabase.from('customer_ratings').insert({
        merchant_id: merchant.id,
        customer_telegram_id: customerTgId,
        rating: Number(rating),
      });
      return edit(chatId, messageId, `✅ تم حفظ التقييم: ${'⭐'.repeat(Number(rating))}`);
    }

    if (action.startsWith('toggle_product:')) {
      if (!merchant) return;
      const productId = action.split(':')[1];
      const { data: p, error } = await supabase
        .from('products').select('*').eq('id', productId).eq('merchant_id', merchant.id).maybeSingle();
      if (error) throw error;
      if (!p) return send(chatId, '❌ المنتج غير موجود.');
      await supabase.from('products').update({ is_available: !p.is_available }).eq('id', productId);
      return edit(chatId, messageId, p.is_available
        ? `🔴 تم إخفاء <b>${esc(p.name)}</b>.`
        : `🟢 تم إظهار <b>${esc(p.name)}</b>.`
      );
    }

    if (action.startsWith('delete_product:')) {
      if (!merchant) return;
      const productId = action.split(':')[1];
      return send(chatId, '⚠️ هل أنت متأكد من حذف هذا المنتج؟', {
        reply_markup: kb.inline([
          [
            { text: '✅ نعم، احذف', callback_data: `confirm_delete_product:${productId}` },
            { text: '❌ إلغاء',      callback_data: 'discard_flow' },
          ],
        ]),
      });
    }

    if (action.startsWith('confirm_delete_product:')) {
      if (!merchant) return;
      const productId = action.split(':')[1];
      await supabase.from('products').delete().eq('id', productId).eq('merchant_id', merchant.id);
      return edit(chatId, messageId, '🗑 تم حذف المنتج.');
    }

    if (action.startsWith('edit_price:')) {
      const productId = action.split(':')[1];
      sessions.set(chatId, { flow: FLOWS.EDIT_PRICE, product_id: productId });
      return send(chatId, '✏️ أرسل السعر الجديد:', { reply_markup: kb.remove() });
    }

    if (action.startsWith('edit_desc:')) {
      return send(chatId, '📝 ميزة تعديل الوصف قيد التطوير.');
    }

    // ── ADMIN ONLY ──
    if (userId !== CONFIG.adminId) return;

    if (action.startsWith('approve_merchant:')) {
      const mChatId = action.split(':')[1];
      await supabase.from('merchants').update({ active: true, is_open: true }).eq('telegram_id', mChatId);
      await send(mChatId, '🎉 تم تفعيل حسابك! أهلاً بك في المنصة.', { reply_markup: kb.main() });
      return edit(chatId, messageId, `${q.message.text ?? ''}\n\n🟢 تم التفعيل`);
    }

    if (action.startsWith('reject_merchant:')) {
      const mChatId = action.split(':')[1];
      await supabase.from('merchants').delete().eq('telegram_id', mChatId);
      await send(mChatId, '⛔ تم رفض طلب انضمام متجرك. تواصل مع الإدارة لمزيد من المعلومات.');
      return edit(chatId, messageId, `${q.message.text ?? ''}\n\n🔴 تم الرفض`);
    }

  } catch (err) {
    logError('callback', err);
    return send(chatId, '❌ حدث خطأ أثناء تنفيذ العملية.');
  }
});

// ──────────────────────────────────────────────
// 28. GLOBAL ERROR HANDLERS
// ──────────────────────────────────────────────

process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
process.on('uncaughtException',  (err)    => logError('uncaughtException', err));

console.log('🚀 Merchant bot running...');

module.exports = bot;