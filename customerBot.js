'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ══════════════════════════════════════════════
// 1. ENV VALIDATION
// ══════════════════════════════════════════════
const REQUIRED_ENV = ['CUSTOMER_BOT_TOKEN', 'MERCHANT_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`⛔ متغير البيئة مفقود: ${key}`);
}

// ══════════════════════════════════════════════
// 2. CLIENTS
// ══════════════════════════════════════════════
const bot = new TelegramBot(process.env.CUSTOMER_BOT_TOKEN, { polling: true });
const merchantBot = new TelegramBot(process.env.MERCHANT_BOT_TOKEN, { polling: false });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ══════════════════════════════════════════════
// 3. CONFIG
// ══════════════════════════════════════════════
const CONFIG = Object.freeze({
  ordersPageSize:   Number(process.env.ORDERS_PAGE_SIZE   || 8),
  productsPageSize: Number(process.env.PRODUCTS_PAGE_SIZE || 10),
  maxCartItems:     Number(process.env.MAX_CART_ITEMS     || 20),
  maxQtyPerItem:    Number(process.env.MAX_QTY_PER_ITEM   || 10),
  cancelWindowMin:  Number(process.env.CANCEL_WINDOW_MIN  || 5), // دقائق يُسمح فيها بالإلغاء
  supportUsername:  process.env.SUPPORT_USERNAME || null,
  webAppUrl:        process.env.WEBAPP_URL || null, // رابط المتجر الإلكتروني (Mini App)
});

// ══════════════════════════════════════════════
// 4. SESSION STORE  (TTL 60 دقيقة)
// ══════════════════════════════════════════════
const SESSION_TTL = 60 * 60 * 1000;

class SessionStore {
  #store = new Map();

  #fresh(id) {
    return { cart: [], ts: Date.now() };
  }

  get(id) {
    const key = String(id);
    let entry = this.#store.get(key);
    if (!entry || Date.now() - entry.ts > SESSION_TTL) {
      entry = this.#fresh(key);
      this.#store.set(key, entry);
    }
    entry.ts = Date.now(); // reset TTL on access
    return entry;
  }

  save(id, data) {
    this.#store.set(String(id), { ...data, ts: Date.now() });
  }

  patch(id, patch) {
    const s = this.get(id);
    this.save(id, { ...s, ...patch });
  }

  clearCart(id) {
    const s = this.get(id);
    s.cart = [];
    delete s.checkout;
    this.save(id, s);
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.#store) {
        if (now - v.ts > SESSION_TTL) this.#store.delete(k);
      }
    }, 15 * 60 * 1000);
  }
}

const sessions = new SessionStore();
sessions.startCleanup();

// ══════════════════════════════════════════════
// 5. CONSTANTS
// ══════════════════════════════════════════════
const STATUS_TEXT = {
  pending:    '⏳ بانتظار قبول المتجر',
  accepted:   '✅ تم القبول',
  preparing:  '👨‍🍳 قيد التحضير',
  ready:      '📦 جاهز للاستلام',
  on_the_way: '🛵 في الطريق إليك',
  delivered:  '🎉 تم التسليم بنجاح',
  cancelled:  '❌ ملغي',
  rejected:   '⛔ مرفوض من المتجر',
};

const STATUS_EMOJI = {
  pending:    '⏳', accepted: '✅', preparing: '👨‍🍳',
  ready:      '📦', on_the_way: '🛵', delivered: '🎉',
  cancelled:  '❌', rejected: '⛔',
};

// ══════════════════════════════════════════════
// 6. HELPERS
// ══════════════════════════════════════════════

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function statusLabel(s) {
  return STATUS_TEXT[s] ?? s ?? 'غير معروف';
}

function formatAmount(n) {
  return `${Number(n || 0).toLocaleString('ar-IQ')} د.ع`;
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleString('ar-IQ', {
    timeZone: 'Asia/Baghdad',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function stars(n) {
  return '⭐'.repeat(Math.max(0, Math.min(5, Math.round(n))));
}

function logError(scope, err) {
  console.error(`[${new Date().toISOString()}][${scope}]`, err?.message ?? err);
}

// ══════════════════════════════════════════════
// 7. KEYBOARDS
// ══════════════════════════════════════════════
const kb = {
  inline: (rows) => ({ inline_keyboard: rows }),
  remove: () => ({ remove_keyboard: true }),

  main: () => ({
    keyboard: [
      [
        CONFIG.webAppUrl
          ? { text: '🛍 المتجر الإلكتروني', web_app: { url: CONFIG.webAppUrl } }
          : '🏪 المتاجر',
        '🔍 بحث عن منتج',
      ],
      ['🛒 سلتي',        '📦 طلباتي'],
      ['⭐ المفضلة',     '👤 حسابي'],
    ],
    resize_keyboard: true,
  }),

  location: () => ({
    keyboard: [[{ text: '📍 مشاركة موقعي', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),

  contact: () => ({
    keyboard: [[{ text: '📱 مشاركة رقمي تلقائياً', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }),
};

// ══════════════════════════════════════════════
// 8. SEND WRAPPERS
// ══════════════════════════════════════════════
async function send(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
  } catch (err) {
    logError('send', err);
    return null;
  }
}

async function edit(chatId, msgId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'HTML', disable_web_page_preview: true,
      ...options,
    });
  } catch (_) { return null; }
}

// ══════════════════════════════════════════════
// 9. DATABASE LAYER
// ══════════════════════════════════════════════

async function getCustomer(chatId) {
  const { data, error } = await supabase
    .from('customers').select('*').eq('telegram_id', String(chatId)).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertCustomer(chatId, patch) {
  const { error } = await supabase.from('customers')
    .upsert({ telegram_id: String(chatId), ...patch }, { onConflict: 'telegram_id' });
  if (error) logError('upsertCustomer', error);
}

async function getStores(filters = {}) {
  let q = supabase.from('merchants').select('*').eq('active', true);
  if (filters.open) q = q.eq('is_open', true);
  if (filters.search) q = q.ilike('store_name', `%${filters.search}%`);
  q = q.order('store_name');
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function getMerchant(merchantId) {
  const { data, error } = await supabase
    .from('merchants').select('*').eq('id', merchantId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getProducts(merchantId, category = null) {
  let q = supabase.from('products').select('*, merchants(store_name, telegram_id)')
    .eq('merchant_id', merchantId).eq('is_available', true);
  if (category) q = q.eq('category', category);
  q = q.order('category').order('name');
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function getProductCategories(merchantId) {
  const { data, error } = await supabase
    .from('products').select('category')
    .eq('merchant_id', merchantId).eq('is_available', true);
  if (error) throw error;
  const cats = [...new Set((data ?? []).map((x) => x.category).filter(Boolean))];
  return cats.sort();
}

async function getProduct(productId) {
  const { data, error } = await supabase
    .from('products').select('*, merchants(store_name, telegram_id, lat, lng, phone)')
    .eq('id', productId).maybeSingle();
  if (error) throw error;
  return data;
}

async function searchProducts(keyword) {
  const { data, error } = await supabase
    .from('products').select('*, merchants(store_name)')
    .eq('is_available', true)
    .or(`name.ilike.%${keyword}%,description.ilike.%${keyword}%,category.ilike.%${keyword}%`)
    .order('name').limit(20);
  if (error) throw error;
  return data ?? [];
}

async function isFavorite(chatId, productId) {
  const { data } = await supabase.from('favorites')
    .select('id').eq('telegram_id', String(chatId)).eq('product_id', productId).maybeSingle();
  return !!data;
}

async function toggleFavorite(chatId, productId) {
  const exists = await isFavorite(chatId, productId);
  if (exists) {
    await supabase.from('favorites')
      .delete().eq('telegram_id', String(chatId)).eq('product_id', productId);
    return false;
  } else {
    await supabase.from('favorites')
      .insert({ telegram_id: String(chatId), product_id: productId });
    return true;
  }
}

async function generateOrderNumber() {
  for (let i = 0; i < 30; i++) {
    const n = Math.floor(100_000 + Math.random() * 900_000);
    const { data } = await supabase.from('orders').select('id').eq('order_number', n).maybeSingle();
    if (!data) return n;
  }
  throw new Error('فشل توليد رقم الطلب');
}

async function getCustomerOrders(chatId, page = 0) {
  const limit = CONFIG.ordersPageSize;
  const { data, error, count } = await supabase
    .from('orders')
    .select('id,order_number,status,total_amount,delivery_fee,created_at,order_items,reject_reason,cancel_reason', { count: 'exact' })
    .eq('customer_telegram_id', String(chatId))
    .order('created_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  if (error) throw error;
  return { orders: data ?? [], total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) };
}

// ══════════════════════════════════════════════
// 10. CART LOGIC
// ══════════════════════════════════════════════

function cartTotal(cart) {
  return cart.reduce((s, i) => s + i.price * i.qty, 0);
}

function cartSummary(cart) {
  if (!cart.length) return '🛒 <b>السلة فارغة</b>';
  const lines = cart.map(
    (i, idx) =>
      `${idx + 1}. <b>${esc(i.name)}</b>  ×${i.qty}  —  ${formatAmount(i.price * i.qty)}`
  );
  return (
    `🛒 <b>سلتك</b>\n\n` +
    lines.join('\n') +
    `\n\n💰 <b>المجموع:</b> ${formatAmount(cartTotal(cart))}`
  );
}

function addToCart(chatId, product) {
  const session = sessions.get(chatId);
  const cart = session.cart;

  if (cart.length >= CONFIG.maxCartItems) {
    return { ok: false, msg: `⚠️ السلة ممتلئة (الحد الأقصى ${CONFIG.maxCartItems} صنف).` };
  }

  if (cart.length && cart[0].merchant_id !== product.merchant_id) {
    return {
      ok: false,
      msg: '⚠️ لديك منتجات من متجر آخر في سلتك.\nأفرغ السلة أولاً أو أكمل طلبك الحالي.',
    };
  }

  const existing = cart.find((x) => x.id === product.id);
  if (existing) {
    if (existing.qty >= CONFIG.maxQtyPerItem) {
      return { ok: false, msg: `⚠️ وصلت الحد الأقصى لهذا المنتج (${CONFIG.maxQtyPerItem}).` };
    }
    existing.qty++;
  } else {
    cart.push({
      id:          product.id,
      merchant_id: product.merchant_id,
      name:        product.name,
      price:       product.price,
      qty:         1,
    });
  }

  sessions.save(chatId, session);
  return { ok: true };
}

function changeQty(chatId, productId, delta) {
  const s = sessions.get(chatId);
  const item = s.cart.find((x) => x.id === productId);
  if (!item) return;
  item.qty = Math.max(0, Math.min(CONFIG.maxQtyPerItem, item.qty + delta));
  if (item.qty === 0) s.cart = s.cart.filter((x) => x.id !== productId);
  sessions.save(chatId, s);
}

// ══════════════════════════════════════════════
// 11. PRODUCT CARD
// ══════════════════════════════════════════════

async function sendProductCard(chatId, product, favStatus = null) {
  const inFav = favStatus ?? (await isFavorite(chatId, product.id));
  const storeLine = product.merchants?.store_name
    ? `🏪 <b>${esc(product.merchants.store_name)}</b>\n` : '';
  const catLine   = product.category ? `🏷 ${esc(product.category)}\n` : '';
  const descLine  = product.description ? `\n📝 ${esc(product.description)}` : '';

  const caption =
    `${storeLine}` +
    `🛒 <b>${esc(product.name)}</b>\n` +
    `${catLine}` +
    `💰 <b>${formatAmount(product.price)}</b>` +
    `${descLine}`;

  const markup = kb.inline([
    [
      { text: '➕ أضف للسلة', callback_data: `add:${product.id}` },
      { text: inFav ? '💛 في المفضلة' : '🤍 أضف للمفضلة', callback_data: `fav:${product.id}` },
    ],
    [{ text: '🛒 عرض السلة', callback_data: 'show_cart' }],
  ]);

  // Try copyMessage first (preserves original quality)
  if (product.image_channel_id && product.image_message_id) {
    try {
      return await bot.copyMessage(chatId, product.image_channel_id, product.image_message_id, {
        caption, parse_mode: 'HTML', reply_markup: markup,
      });
    } catch (_) {}
  }

  if (product.image_file_id) {
    try {
      return await bot.sendPhoto(chatId, product.image_file_id, {
        caption, parse_mode: 'HTML', reply_markup: markup,
      });
    } catch (_) {}
  }

  return send(chatId, caption, { reply_markup: markup });
}

// ══════════════════════════════════════════════
// 12. STORE BROWSER
// ══════════════════════════════════════════════

async function showStores(chatId, filterOpen = false) {
  const stores = await getStores(filterOpen ? { open: true } : {});

  if (!stores.length) {
    return send(
      chatId,
      '😔 لا توجد متاجر متاحة حالياً.\nحاول لاحقاً.',
      { reply_markup: kb.main() }
    );
  }

  const rows = stores.map((s) => [{
    text: `${s.is_open ? '🟢' : '🔴'} ${esc(s.store_name)}`,
    callback_data: `store:${s.id}`,
  }]);

  rows.push([
    { text: filterOpen ? '🔄 عرض الكل' : '🟢 المفتوحة فقط',
      callback_data: filterOpen ? 'stores_all' : 'stores_open' },
  ]);

  return send(
    chatId,
    `🏪 <b>المتاجر المتاحة</b>  (${stores.length})\n\n🟢 مفتوح  🔴 مغلق`,
    { reply_markup: kb.inline(rows) }
  );
}

async function showStoreMenu(chatId, merchantId, merchant = null) {
  if (!merchant) merchant = await getMerchant(merchantId);
  if (!merchant) return send(chatId, '❌ المتجر غير موجود.');

  const categories = await getProductCategories(merchantId);

  const storeStatus = merchant.is_open
    ? '🟢 المتجر مفتوح الآن'
    : '🔴 المتجر مغلق حالياً';

  const rows = [];

  if (categories.length) {
    rows.push([{ text: '📋 جميع المنتجات', callback_data: `products:${merchantId}:all` }]);
    for (const cat of categories) {
      rows.push([{ text: `🏷 ${cat}`, callback_data: `products:${merchantId}:${cat}` }]);
    }
  } else {
    rows.push([{ text: '🛍 عرض المنتجات', callback_data: `products:${merchantId}:all` }]);
  }

  rows.push([{ text: '« العودة للمتاجر', callback_data: 'back_stores' }]);

  return send(
    chatId,
    `🏪 <b>${esc(merchant.store_name)}</b>\n${storeStatus}\n\nاختر التصنيف:`,
    { reply_markup: kb.inline(rows) }
  );
}

async function showProducts(chatId, merchantId, category = null) {
  const products = await getProducts(merchantId, category === 'all' ? null : category);

  if (!products.length) {
    return send(
      chatId,
      category ? `لا توجد منتجات في تصنيف "${esc(category)}".` : 'لا توجد منتجات متاحة حالياً.',
      { reply_markup: kb.inline([[{ text: '« رجوع', callback_data: `store:${merchantId}` }]]) }
    );
  }

  const label = category && category !== 'all' ? ` — ${esc(category)}` : '';
  await send(chatId, `🛍 <b>المنتجات${label}</b>  (${products.length})`);

  for (const p of products) {
    await sendProductCard(chatId, p);
  }
}

// ══════════════════════════════════════════════
// 13. CART VIEW
// ══════════════════════════════════════════════

async function showCart(chatId) {
  const s = sessions.get(chatId);
  const cart = s.cart;

  if (!cart.length) {
    return send(
      chatId,
      '🛒 سلتك فارغة.\nتصفح المتاجر واضف ما يعجبك! 😊',
      { reply_markup: kb.inline([[{ text: '🏪 تصفح المتاجر', callback_data: 'back_stores' }]]) }
    );
  }

  const rows = cart.map((item) => [
    { text: `➖`, callback_data: `qty_minus:${item.id}` },
    { text: `${esc(item.name)} ×${item.qty}`, callback_data: `item_info:${item.id}` },
    { text: `➕`, callback_data: `qty_plus:${item.id}` },
  ]);

  rows.push([{ text: '🗑 إفراغ السلة', callback_data: 'clear_cart' }]);
  rows.push([{ text: '✅ إتمام الطلب', callback_data: 'checkout' }]);

  return send(chatId, cartSummary(cart), { reply_markup: kb.inline(rows) });
}

// ══════════════════════════════════════════════
// 14. CHECKOUT FLOW
// ══════════════════════════════════════════════

async function startCheckout(chatId) {
  const s = sessions.get(chatId);
  if (!s.cart.length) return send(chatId, '🛒 سلتك فارغة.');

  // Check store is still open
  const merchantId = s.cart[0].merchant_id;
  const merchant   = await getMerchant(merchantId);
  if (!merchant?.active) return send(chatId, '⚠️ المتجر غير متاح حالياً.');

  if (!merchant.is_open) {
    return send(
      chatId,
      `⏰ متجر <b>${esc(merchant.store_name)}</b> مغلق حالياً.\n\nيمكنك إبقاء السلة والطلب لاحقاً.`,
      { reply_markup: kb.inline([[{ text: '« رجوع', callback_data: 'show_cart' }]]) }
    );
  }

  const customer = await getCustomer(chatId);

  // If we have saved phone, skip directly to location
  if (customer?.phone) {
    sessions.patch(chatId, {
      checkout: { step: 'location', phone: customer.phone, merchantId },
    });
    return send(
      chatId,
      `📱 سنستخدم رقمك المحفوظ: <b>${esc(customer.phone)}</b>\n\n` +
      `📍 الآن أرسل موقع التوصيل:`,
      { reply_markup: kb.location() }
    );
  }

  sessions.patch(chatId, { checkout: { step: 'phone', merchantId } });

  return send(
    chatId,
    `📱 أرسل رقم هاتفك لإتمام الطلب:\n(يُستخدم فقط للتواصل بشأن طلبك)`,
    { reply_markup: kb.contact() }
  );
}

async function handleCheckoutPhone(chatId, msg) {
  const s = sessions.get(chatId);
  if (s.checkout?.step !== 'phone') return;

  const phone = msg.contact?.phone_number ?? msg.text?.trim();
  if (!phone || String(phone).length < 7) {
    return send(chatId, '⚠️ أرسل رقم هاتف صحيح أو اضغط الزر أدناه.', { reply_markup: kb.contact() });
  }

  sessions.patch(chatId, { checkout: { ...s.checkout, step: 'location', phone } });
  return send(chatId, '📍 ممتاز! الآن شارك موقع التوصيل:', { reply_markup: kb.location() });
}

async function handleCheckoutLocation(chatId, msg) {
  const s = sessions.get(chatId);
  if (s.checkout?.step !== 'location') return;
  if (!msg.location) return send(chatId, '⚠️ اضغط زر مشاركة الموقع.', { reply_markup: kb.location() });

  const { latitude, longitude } = msg.location;
  sessions.patch(chatId, {
    checkout: { ...s.checkout, step: 'confirm', lat: latitude, lng: longitude },
  });

  const cart = s.cart;
  return send(
    chatId,
    `${cartSummary(cart)}\n\n` +
    `📱 الهاتف: <b>${esc(s.checkout.phone)}</b>\n` +
    `📍 موقع التوصيل: محدد ✅\n\n` +
    `تأكد من الطلب قبل الإرسال:`,
    {
      reply_markup: kb.inline([
        [{ text: '✅ تأكيد الطلب', callback_data: 'confirm_order' }],
        [{ text: '✏️ تعديل السلة', callback_data: 'show_cart' }],
        [{ text: '❌ إلغاء',       callback_data: 'cancel_checkout' }],
      ]),
    }
  );
}

async function confirmOrder(chatId) {
  const s = sessions.get(chatId);
  const { checkout, cart } = s;

  if (!checkout || checkout.step !== 'confirm' || !cart.length) {
    return send(chatId, '⚠️ انتهت صلاحية الجلسة. ابدأ الطلب من جديد.', { reply_markup: kb.main() });
  }

  // Re-validate products and prices
  const orderItems = [];
  let total = 0;
  for (const item of cart) {
    const fresh = await getProduct(item.id);
    if (!fresh || !fresh.is_available) {
      return send(chatId, `⚠️ المنتج <b>${esc(item.name)}</b> لم يعد متاحاً.\nعدّل سلتك وحاول مجدداً.`);
    }
    const lineTotal = fresh.price * item.qty;
    orderItems.push({ product_id: item.id, name: fresh.name, price: fresh.price, qty: item.qty, total: lineTotal });
    total += lineTotal;
  }

  const notes = orderItems.map((x) => `${x.name} × ${x.qty} = ${formatAmount(x.total)}`).join('\n');
  const orderNumber = await generateOrderNumber();

  const { data: order, error } = await supabase.from('orders').insert({
    order_number:          orderNumber,
    merchant_id:           cart[0].merchant_id,
    customer_telegram_id:  String(chatId),
    customer_phone:        checkout.phone,
    customer_lat:          checkout.lat,
    customer_lng:          checkout.lng,
    address:               mapsUrl(checkout.lat, checkout.lng),
    notes,
    order_items:           orderItems,
    total_amount:          total,
    status:                'pending',
  }).select('*, merchants(store_name, telegram_id)').single();

  if (error) throw error;

  await upsertCustomer(chatId, {
    phone:    checkout.phone,
    last_lat: checkout.lat,
    last_lng: checkout.lng,
  });

  sessions.clearCart(chatId);

  // Notify customer
  await send(
    chatId,
    `🎉 <b>تم إرسال طلبك بنجاح!</b>\n\n` +
    `🆔 رقم الطلب: <code>${order.order_number}</code>\n` +
    `🏪 المتجر: <b>${esc(order.merchants?.store_name ?? '')}</b>\n` +
    `💰 المجموع: <b>${formatAmount(total)}</b>\n\n` +
    `⏳ ستصلك إشعارات بتحديثات طلبك.`,
    {
      reply_markup: kb.inline([
        [{ text: '🔄 متابعة الطلب', callback_data: `order_status:${order.id}` }],
        [{ text: '❌ إلغاء الطلب',   callback_data: `try_cancel:${order.id}` }],
      ]),
    }
  );

  // Notify merchant
  if (order.merchants?.telegram_id) {
    merchantBot.sendMessage(
      order.merchants.telegram_id,
      `🔔 <b>طلب جديد وارد!</b>\n\n` +
      `🆔 رقم الطلب: <code>${order.order_number}</code>\n` +
      `📱 الزبون: ${esc(checkout.phone)}\n` +
      `💰 المجموع: <b>${formatAmount(total)}</b>\n\n` +
      `🛒 <b>المنتجات:</b>\n${notes}\n\n` +
      `📍 <a href="${mapsUrl(checkout.lat, checkout.lng)}">موقع الزبون</a>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: kb.inline([
          [
            { text: '✅ قبول',         callback_data: `accept_order_m:${order.id}` },
            { text: '❌ رفض',          callback_data: `reject_order_m:${order.id}` },
          ],
          [{ text: '🔄 تحديث الطلب', callback_data: `refresh_order:${order.id}` }],
        ]),
      }
    ).catch((err) => logError('notifyMerchant', err));
  }
}

// ══════════════════════════════════════════════
// 15. ORDER MANAGEMENT
// ══════════════════════════════════════════════

async function showOrders(chatId, page = 0) {
  const { orders, total, pages } = await getCustomerOrders(chatId, page);

  if (!orders.length) {
    return send(
      chatId,
      `📦 لا توجد لديك طلبات بعد.\nابدأ طلبك الأول الآن! 🚀`,
      { reply_markup: kb.inline([[{ text: '🏪 تصفح المتاجر', callback_data: 'back_stores' }]]) }
    );
  }

  if (page === 0) {
    await send(chatId, `📦 <b>طلباتك</b>  (الإجمالي: ${total})`);
  }

  for (const o of orders) {
    const canCancel = o.status === 'pending';
    const createdAt = formatDate(o.created_at);

    let extra = '';
    if (o.status === 'rejected' && o.reject_reason) {
      extra += `\n📝 <i>سبب الرفض: ${esc(o.reject_reason)}</i>`;
    }
    if (o.status === 'cancelled' && o.cancel_reason) {
      extra += `\n📝 <i>سبب الإلغاء: ${esc(o.cancel_reason)}</i>`;
    }

    const rows = [
      [{ text: '🔄 تحديث الحالة', callback_data: `order_status:${o.id}` }],
    ];

    if (['delivered'].includes(o.status)) {
      rows.push([
        { text: '🔁 إعادة الطلب',       callback_data: `reorder:${o.id}` },
        { text: '⭐ تقييم التوصيل',      callback_data: `rate_order:${o.id}` },
      ]);
    }

    if (canCancel) {
      rows.push([{ text: '❌ إلغاء الطلب', callback_data: `try_cancel:${o.id}` }]);
    }

    await send(
      chatId,
      `${STATUS_EMOJI[o.status] ?? '📦'} <b>طلب #${o.order_number ?? o.id}</b>\n` +
      `📅 ${createdAt}\n` +
      `📌 ${statusLabel(o.status)}\n` +
      `💰 ${formatAmount(o.total_amount)}` +
      extra,
      { reply_markup: kb.inline(rows) }
    );
  }

  // Pagination
  if (pages > 1) {
    const nav = [];
    if (page > 0)         nav.push({ text: '◀ السابق', callback_data: `orders_page:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'التالي ▶', callback_data: `orders_page:${page + 1}` });
    if (nav.length) await send(chatId, `الصفحة ${page + 1} / ${pages}`, { reply_markup: kb.inline([nav]) });
  }
}

async function tryCancel(chatId, orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id,order_number,status,created_at')
    .eq('id', orderId)
    .eq('customer_telegram_id', String(chatId))
    .maybeSingle();

  if (error) throw error;
  if (!order) return send(chatId, '❌ الطلب غير موجود.');

  if (order.status !== 'pending') {
    return send(
      chatId,
      `⚠️ لا يمكن إلغاء الطلب بعد قبوله من المتجر.\n\nالحالة الحالية: <b>${statusLabel(order.status)}</b>`
    );
  }

  // Check cancel window
  const elapsed = (Date.now() - new Date(order.created_at).getTime()) / 60000;
  if (elapsed > CONFIG.cancelWindowMin) {
    return send(
      chatId,
      `⚠️ انتهت مهلة الإلغاء (${CONFIG.cancelWindowMin} دقائق).\n\nتواصل مع الدعم إن أردت إلغاء الطلب.` +
      (CONFIG.supportUsername ? `\n\n👨‍💻 @${CONFIG.supportUsername}` : '')
    );
  }

  return send(
    chatId,
    `⚠️ هل أنت متأكد من إلغاء طلب رقم <code>${order.order_number}</code>؟`,
    {
      reply_markup: kb.inline([
        [
          { text: '✅ نعم، ألغِ الطلب', callback_data: `confirm_cancel:${orderId}` },
          { text: '❌ لا، احتفظ به',    callback_data: `order_status:${orderId}` },
        ],
      ]),
    }
  );
}

async function confirmCancelOrder(chatId, orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .update({ status: 'cancelled', cancel_reason: 'إلغاء بطلب الزبون', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('customer_telegram_id', String(chatId))
    .eq('status', 'pending')
    .select('order_number')
    .single();

  if (error || !order) {
    return send(chatId, '⚠️ لا يمكن إلغاء الطلب. ربما تم قبوله مسبقاً.');
  }

  return send(
    chatId,
    `✅ تم إلغاء طلب رقم <code>${order.order_number}</code> بنجاح.`,
    { reply_markup: kb.main() }
  );
}

// ══════════════════════════════════════════════
// 16. FAVOURITES
// ══════════════════════════════════════════════

async function showFavorites(chatId) {
  const { data, error } = await supabase
    .from('favorites').select('product_id, created_at')
    .eq('telegram_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  if (!data?.length) {
    return send(
      chatId,
      `⭐ قائمة المفضلة فارغة.\nابحث عن منتجات وأضفها بالضغط على 🤍`,
      { reply_markup: kb.main() }
    );
  }

  await send(chatId, `⭐ <b>مفضلتك</b>  (${data.length})`);

  for (const f of data) {
    const p = await getProduct(f.product_id);
    if (p?.is_available) await sendProductCard(chatId, p, true);
  }
}

// ══════════════════════════════════════════════
// 17. ACCOUNT
// ══════════════════════════════════════════════

async function showAccount(chatId, tgUser) {
  const customer = await getCustomer(chatId);
  const { orders } = await getCustomerOrders(chatId, 0);
  const deliveredCount = orders.filter((o) => o.status === 'delivered').length;

  return send(
    chatId,
    `👤 <b>حسابي</b>\n\n` +
    `الاسم: <b>${esc(tgUser?.first_name ?? 'زبون')}</b>\n` +
    `📱 الهاتف: ${esc(customer?.phone ?? 'غير محفوظ')}\n` +
    `📍 موقع محفوظ: ${customer?.last_lat ? '✅' : '❌'}\n` +
    `📦 طلباتي: ${orders.length}\n` +
    `🎉 مكتملة: ${deliveredCount}`,
    {
      reply_markup: kb.inline([
        [
          { text: '📱 تحديث الهاتف',  callback_data: 'update_phone' },
          { text: '📍 تحديث الموقع', callback_data: 'update_location' },
        ],
        [{ text: '📦 كل طلباتي', callback_data: 'my_orders' }],
      ]),
    }
  );
}

// ══════════════════════════════════════════════
// 18. SEARCH
// ══════════════════════════════════════════════

async function startSearch(chatId) {
  sessions.patch(chatId, { mode: 'search' });
  return send(chatId, '🔍 اكتب اسم المنتج أو الفئة:', { reply_markup: kb.remove() });
}

async function handleSearch(chatId, keyword) {
  sessions.patch(chatId, { mode: null });

  if (!keyword || keyword.length < 2) {
    return send(chatId, '⚠️ اكتب كلمة بحث أطول.', { reply_markup: kb.main() });
  }

  const products = await searchProducts(keyword);

  if (!products.length) {
    return send(
      chatId,
      `😔 لم أجد منتجات بـ "<b>${esc(keyword)}</b>".\nجرب كلمة أخرى.`,
      { reply_markup: kb.main() }
    );
  }

  await send(chatId, `🔍 <b>${products.length}</b> نتيجة لـ "<b>${esc(keyword)}</b>"`);
  for (const p of products) await sendProductCard(chatId, p);
}

// ══════════════════════════════════════════════
// 19. /start & /cancel
// ══════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await upsertCustomer(chatId, { full_name: msg.from?.first_name ?? null });

  return send(
    chatId,
    `👋 أهلاً <b>${esc(msg.from?.first_name ?? 'بك')}</b>! 🎉\n\n` +
    `اطلب من متاجرك المفضلة بسهولة وسرعة.\n\n` +
    `اختر من القائمة أدناه:`,
    { reply_markup: kb.main() }
  );
});

bot.onText(/\/cancel/, async (msg) => {
  const s = sessions.get(msg.chat.id);
  delete s.checkout;
  delete s.mode;
  sessions.save(msg.chat.id, s);
  return send(msg.chat.id, '✅ تم إلغاء العملية الحالية.', { reply_markup: kb.main() });
});

bot.onText(/\/orders/, async (msg) => {
  try { await showOrders(msg.chat.id); }
  catch (e) { logError('/orders', e); }
});

// ══════════════════════════════════════════════
// 20. MESSAGE HANDLER
// ══════════════════════════════════════════════

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();
  if (text?.startsWith('/')) return;

  const s = sessions.get(chatId);

  try {
    // Search mode
    if (s.mode === 'search') return handleSearch(chatId, text);

    // Checkout steps
    if (s.checkout?.step === 'phone')    return handleCheckoutPhone(chatId, msg);
    if (s.checkout?.step === 'location') return handleCheckoutLocation(chatId, msg);

    // Phone update flow
    if (s.mode === 'update_phone') {
      const phone = msg.contact?.phone_number ?? text;
      if (!phone || String(phone).length < 7) return send(chatId, '⚠️ رقم غير صحيح.', { reply_markup: kb.contact() });
      await upsertCustomer(chatId, { phone });
      sessions.patch(chatId, { mode: null });
      return send(chatId, '✅ تم تحديث رقم هاتفك.', { reply_markup: kb.main() });
    }

    // Location update flow
    if (s.mode === 'update_location') {
      if (!msg.location) return send(chatId, '⚠️ شارك موقعك بالزر.', { reply_markup: kb.location() });
      await upsertCustomer(chatId, { last_lat: msg.location.latitude, last_lng: msg.location.longitude });
      sessions.patch(chatId, { mode: null });
      return send(chatId, '✅ تم تحديث موقعك.', { reply_markup: kb.main() });
    }

    // Menu buttons
    const menuMap = {
      '🏪 المتاجر':       () => showStores(chatId),
      '🔍 بحث عن منتج':  () => startSearch(chatId),
      '🛒 سلتي':          () => showCart(chatId),
      '📦 طلباتي':        () => showOrders(chatId),
      '⭐ المفضلة':       () => showFavorites(chatId),
      '👤 حسابي':         () => showAccount(chatId, msg.from),
    };

    if (menuMap[text]) return menuMap[text]();
    return send(chatId, 'اختر من الأزرار 👇', { reply_markup: kb.main() });
  } catch (err) {
    logError('message', err);
    return send(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.');
  }
});

// ══════════════════════════════════════════════
// 21. CALLBACK HANDLER
// ══════════════════════════════════════════════

bot.on('callback_query', async (q) => {
  const chatId    = q.message.chat.id;
  const messageId = q.message.message_id;
  const action    = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    // ── Navigation ──
    if (action === 'back_stores')  return showStores(chatId);
    if (action === 'stores_open')  return showStores(chatId, true);
    if (action === 'stores_all')   return showStores(chatId, false);
    if (action === 'show_cart')    return showCart(chatId);
    if (action === 'checkout')     return startCheckout(chatId);
    if (action === 'confirm_order') return confirmOrder(chatId);
    if (action === 'my_orders')    return showOrders(chatId);

    if (action === 'cancel_checkout') {
      const s = sessions.get(chatId);
      delete s.checkout;
      sessions.save(chatId, s);
      return send(chatId, '❌ تم إلغاء عملية الطلب.', { reply_markup: kb.main() });
    }

    if (action === 'clear_cart') {
      return send(chatId, '⚠️ هل أنت متأكد من إفراغ السلة؟', {
        reply_markup: kb.inline([
          [
            { text: '✅ نعم', callback_data: 'confirm_clear_cart' },
            { text: '❌ لا',  callback_data: 'show_cart' },
          ],
        ]),
      });
    }

    if (action === 'confirm_clear_cart') {
      sessions.clearCart(chatId);
      return edit(chatId, messageId, '🗑 تم إفراغ السلة.');
    }

    // ── Store & Products ──
    if (action.startsWith('store:')) {
      const merchantId = action.split(':')[1];
      return showStoreMenu(chatId, merchantId);
    }

    if (action === 'back_stores') return showStores(chatId);

    if (action.startsWith('products:')) {
      const [, merchantId, cat] = action.split(':');
      return showProducts(chatId, merchantId, cat);
    }

    // ── Add to cart ──
    if (action.startsWith('add:')) {
      const productId = action.split(':')[1];
      const product   = await getProduct(productId);
      if (!product?.is_available) return send(chatId, '❌ المنتج غير متاح حالياً.');

      const result = addToCart(chatId, product);
      if (!result.ok) return send(chatId, result.msg);

      return bot.answerCallbackQuery(q.id, {
        text: `✅ تمت إضافة ${product.name}`,
        show_alert: false,
      }).then(() =>
        send(chatId, `✅ <b>${esc(product.name)}</b> أُضيف للسلة!`, {
          reply_markup: kb.inline([
            [{ text: '🛒 عرض السلة',    callback_data: 'show_cart' }],
            [{ text: '✅ إتمام الطلب', callback_data: 'checkout' }],
          ]),
        })
      ).catch(() => {});
    }

    // ── Qty control ──
    if (action.startsWith('qty_plus:')) {
      changeQty(chatId, action.split(':')[1], +1);
      return showCart(chatId);
    }
    if (action.startsWith('qty_minus:')) {
      changeQty(chatId, action.split(':')[1], -1);
      return showCart(chatId);
    }

    // ── Favourite ──
    if (action.startsWith('fav:')) {
      const productId = action.split(':')[1];
      const added = await toggleFavorite(chatId, productId);
      return bot.answerCallbackQuery(q.id, {
        text: added ? '💛 أُضيف للمفضلة' : '🤍 حُذف من المفضلة',
        show_alert: false,
      }).catch(() => {});
    }

    // ── Orders ──
    if (action.startsWith('orders_page:')) {
      return showOrders(chatId, Number(action.split(':')[1]));
    }

    if (action.startsWith('order_status:')) {
      const orderId = action.split(':')[1];
      const { data: o, error } = await supabase
        .from('orders')
        .select('id,order_number,status,total_amount,delivery_fee,reject_reason,cancel_reason,created_at')
        .eq('id', orderId)
        .eq('customer_telegram_id', String(chatId))
        .maybeSingle();
      if (error) throw error;
      if (!o) return send(chatId, '❌ الطلب غير موجود.');

      let extra = '';
      if (o.status === 'rejected' && o.reject_reason)
        extra = `\n📝 سبب الرفض: <i>${esc(o.reject_reason)}</i>`;
      if (o.status === 'cancelled' && o.cancel_reason)
        extra = `\n📝 سبب الإلغاء: <i>${esc(o.cancel_reason)}</i>`;

      const rows = [];
      if (o.status === 'pending') {
        rows.push([{ text: '❌ إلغاء الطلب', callback_data: `try_cancel:${o.id}` }]);
      }
      if (o.status === 'delivered') {
        rows.push([
          { text: '🔁 إعادة الطلب', callback_data: `reorder:${o.id}` },
          { text: '⭐ تقييم',        callback_data: `rate_order:${o.id}` },
        ]);
      }

      return send(
        chatId,
        `${STATUS_EMOJI[o.status] ?? '📦'} <b>طلب #${o.order_number}</b>\n` +
        `📅 ${formatDate(o.created_at)}\n` +
        `📌 <b>${statusLabel(o.status)}</b>\n` +
        `💰 ${formatAmount(o.total_amount)}` +
        (o.delivery_fee ? `\n💵 توصيل: ${formatAmount(o.delivery_fee)}` : '') +
        extra,
        { reply_markup: kb.inline([...rows, [{ text: '🔄 تحديث', callback_data: `order_status:${o.id}` }]]) }
      );
    }

    // ── Cancel order ──
    if (action.startsWith('try_cancel:')) {
      return tryCancel(chatId, action.split(':')[1]);
    }

    if (action.startsWith('confirm_cancel:')) {
      return confirmCancelOrder(chatId, action.split(':')[1]);
    }

    // ── Reorder ──
    if (action.startsWith('reorder:')) {
      const orderId = action.split(':')[1];
      const { data: o, error } = await supabase
        .from('orders')
        .select('order_items,merchant_id')
        .eq('id', orderId)
        .eq('customer_telegram_id', String(chatId))
        .maybeSingle();
      if (error) throw error;
      if (!o?.order_items?.length) return send(chatId, '❌ لا يمكن إعادة هذا الطلب.');

      const s = sessions.get(chatId);
      s.cart = o.order_items.map((x) => ({
        id: x.product_id, merchant_id: o.merchant_id,
        name: x.name, price: x.price, qty: x.qty,
      }));
      sessions.save(chatId, s);

      return send(chatId, '🔁 تم وضع الطلب السابق في سلتك.', {
        reply_markup: kb.inline([
          [{ text: '🛒 عرض السلة',    callback_data: 'show_cart' }],
          [{ text: '✅ إتمام الطلب', callback_data: 'checkout' }],
        ]),
      });
    }

    // ── Rate order ──
    if (action.startsWith('rate_order:')) {
      const orderId = action.split(':')[1];
      return send(chatId, '⭐ قيّم تجربتك:', {
        reply_markup: kb.inline([
          [
            { text: '⭐⭐⭐⭐⭐ ممتاز',  callback_data: `save_rate:${orderId}:5` },
          ],
          [
            { text: '⭐⭐⭐⭐ جيد جداً',  callback_data: `save_rate:${orderId}:4` },
            { text: '⭐⭐⭐ جيد',         callback_data: `save_rate:${orderId}:3` },
          ],
          [
            { text: '⭐⭐ مقبول',         callback_data: `save_rate:${orderId}:2` },
            { text: '⭐ سيء',             callback_data: `save_rate:${orderId}:1` },
          ],
        ]),
      });
    }

    if (action.startsWith('save_rate:')) {
      const [, orderId, ratingStr] = action.split(':');
      const rating = Number(ratingStr);
      await supabase.from('order_ratings').insert({
        order_id: orderId,
        customer_telegram_id: String(chatId),
        rating,
      });
      return edit(chatId, messageId, `✅ شكراً على تقييمك! ${stars(rating)}`);
    }

    // ── Account updates ──
    if (action === 'update_phone') {
      sessions.patch(chatId, { mode: 'update_phone' });
      return send(chatId, '📱 أرسل رقم هاتفك الجديد:', { reply_markup: kb.contact() });
    }

    if (action === 'update_location') {
      sessions.patch(chatId, { mode: 'update_location' });
      return send(chatId, '📍 شارك موقعك الجديد:', { reply_markup: kb.location() });
    }

    // ── Item info (cart) ──
    if (action.startsWith('item_info:')) {
      const productId = action.split(':')[1];
      const s = sessions.get(chatId);
      const item = s.cart.find((x) => x.id === productId);
      if (!item) return;
      return bot.answerCallbackQuery(q.id, {
        text: `${item.name} — ${formatAmount(item.price)} × ${item.qty} = ${formatAmount(item.price * item.qty)}`,
        show_alert: true,
      }).catch(() => {});
    }

  } catch (err) {
    logError('callback', err);
    return send(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.');
  }
});

// ══════════════════════════════════════════════
// 22. WEB APP MENU BUTTON (persistent button next to the chat input)
// ══════════════════════════════════════════════
if (CONFIG.webAppUrl) {
  bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🛍 المتجر', web_app: { url: CONFIG.webAppUrl } },
  }).catch((err) => logError('setChatMenuButton', err));
}

// ══════════════════════════════════════════════
// 23. GLOBAL ERROR HANDLERS
// ══════════════════════════════════════════════
process.on('unhandledRejection', (r) => logError('unhandledRejection', r));
process.on('uncaughtException',  (e) => logError('uncaughtException', e));

console.log('🚀 Customer bot running...');
module.exports = bot;