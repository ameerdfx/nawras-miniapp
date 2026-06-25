'use strict';

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ──────────────────────────────────────────────
// 1. ENV VALIDATION
// ──────────────────────────────────────────────
const REQUIRED_ENV = ['CUSTOMER_BOT_TOKEN', 'MERCHANT_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`⛔ متغير البيئة مفقود: ${key}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
});

const CONFIG = Object.freeze({
  customerBotToken: process.env.CUSTOMER_BOT_TOKEN,
  merchantBotToken: process.env.MERCHANT_BOT_TOKEN,
  port: Number(process.env.PORT || 3000),
  cancelWindowMin: Number(process.env.CANCEL_WINDOW_MIN || 5),
  maxCartItems: Number(process.env.MAX_CART_ITEMS || 20),
  maxQtyPerItem: Number(process.env.MAX_QTY_PER_ITEM || 10),
  ordersPageSize: Number(process.env.ORDERS_PAGE_SIZE || 10),
  // Set to true only while testing locally without a real Telegram session.
  allowInsecureDevAuth: process.env.DEV_ALLOW_INSECURE_AUTH === 'true',
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// 2. HELPERS (mirrors customer-bot.js so behaviour stays identical)
// ──────────────────────────────────────────────
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mapsUrl(lat, lng) {
  return lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : '#';
}
function formatAmount(n) {
  return `${Number(n || 0).toLocaleString('ar-IQ')} د.ع`;
}
function logError(scope, err) {
  console.error(`[${new Date().toISOString()}][${scope}]`, err?.message ?? err);
}

const STATUS_TEXT = {
  pending: 'بانتظار قبول المتجر',
  accepted: 'تم القبول',
  preparing: 'قيد التحضير',
  ready: 'جاهز للاستلام',
  on_the_way: 'في الطريق إليك',
  delivered: 'تم التسليم بنجاح',
  cancelled: 'ملغي',
  rejected: 'مرفوض من المتجر',
};
function statusLabel(s) {
  return STATUS_TEXT[s] ?? s ?? 'غير معروف';
}

async function tgApi(token, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) logError(`tgApi:${method}`, data.description ?? data);
    return data;
  } catch (err) {
    logError(`tgApi:${method}`, err);
    return null;
  }
}

// ──────────────────────────────────────────────
// 3. TELEGRAM WEBAPP AUTH (validates initData per Telegram docs)
// ──────────────────────────────────────────────
function verifyInitData(initData, botToken) {
  if (!initData) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (_) {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // older than 24h

  let user = null;
  try {
    user = JSON.parse(params.get('user'));
  } catch (_) {
    return null;
  }
  if (!user?.id) return null;
  return user;
}

function auth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const user = verifyInitData(initData, CONFIG.customerBotToken);
  if (user) {
    req.tgUser = user;
    return next();
  }
  // Local-dev escape hatch only — never enable this in production.
  if (CONFIG.allowInsecureDevAuth && req.headers['x-dev-telegram-id']) {
    req.tgUser = { id: Number(req.headers['x-dev-telegram-id']), first_name: 'Dev' };
    return next();
  }
  return res.status(401).json({ error: 'جلسة غير صالحة. أعد فتح المتجر من تيليجرام.' });
}

// ──────────────────────────────────────────────
// 4. DB LAYER (same tables/shape as the three bots)
// ──────────────────────────────────────────────
async function getStores({ open, search } = {}) {
let q = supabase.from('merchants').select('id,store_name,phone,lat,lng,is_open,active,store_image_file_id').eq('active', true);  if (open) q = q.eq('is_open', true);
  if (search) q = q.ilike('store_name', `%${search}%`);
  q = q.order('store_name');
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function getMerchant(merchantId) {
  const { data, error } = await supabase.from('merchants').select('*').eq('id', merchantId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getProductCategories(merchantId) {
  const { data, error } = await supabase
    .from('products').select('category').eq('merchant_id', merchantId).eq('is_available', true);
  if (error) throw error;
  return [...new Set((data ?? []).map((x) => x.category).filter(Boolean))].sort();
}

async function getProducts(merchantId, category) {
  let q = supabase.from('products').select('*').eq('merchant_id', merchantId).eq('is_available', true);
  if (category && category !== 'all') q = q.eq('category', category);
  q = q.order('category').order('name');
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function getProduct(productId) {
  const { data, error } = await supabase.from('products').select('*').eq('id', productId).maybeSingle();
  if (error) throw error;
  return data;
}

async function searchProducts(keyword) {
  const { data, error } = await supabase
    .from('products').select('*, merchants(store_name,is_open)')
    .eq('is_available', true)
    .or(`name.ilike.%${keyword}%,description.ilike.%${keyword}%,category.ilike.%${keyword}%`)
    .order('name').limit(30);
  if (error) throw error;
  return data ?? [];
}

async function getCustomer(telegramId) {
  const { data, error } = await supabase.from('customers').select('*').eq('telegram_id', String(telegramId)).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertCustomer(telegramId, patch) {
  const { error } = await supabase
    .from('customers')
    .upsert({ telegram_id: String(telegramId), ...patch }, { onConflict: 'telegram_id' });
  if (error) logError('upsertCustomer', error);
}

async function generateOrderNumber() {
  for (let i = 0; i < 30; i++) {
    const n = Math.floor(100_000 + Math.random() * 900_000);
    const { data } = await supabase.from('orders').select('id').eq('order_number', n).maybeSingle();
    if (!data) return n;
  }
  throw new Error('فشل توليد رقم الطلب');
}

async function getCustomerOrders(telegramId, page = 0) {
  const limit = CONFIG.ordersPageSize;
  const { data, error, count } = await supabase
    .from('orders')
    .select(
      'id,order_number,status,total_amount,delivery_fee,created_at,order_items,reject_reason,cancel_reason,merchant_id,merchants(store_name)',
      { count: 'exact' }
    )
    .eq('customer_telegram_id', String(telegramId))
    .order('created_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  if (error) throw error;
  return { orders: data ?? [], total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) };
}

async function getOrderForCustomer(orderId, telegramId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, merchants(store_name,lat,lng,phone)')
    .eq('id', orderId)
    .eq('customer_telegram_id', String(telegramId))
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ──────────────────────────────────────────────
// 5. ROUTES — read-only catalog
// ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/stores', async (req, res) => {
  try {
    const open = req.query.open === 'true';
    const search = req.query.search ? String(req.query.search) : null;
    res.json(await getStores({ open, search }));
  } catch (err) {
    logError('GET /api/stores', err);
    res.status(500).json({ error: 'تعذر تحميل المتاجر' });
  }
});

app.get('/api/stores/:id', async (req, res) => {
  try {
    const merchant = await getMerchant(req.params.id);
    if (!merchant?.active) return res.status(404).json({ error: 'المتجر غير موجود' });
    res.json(merchant);
  } catch (err) {
    logError('GET /api/stores/:id', err);
    res.status(500).json({ error: 'تعذر تحميل بيانات المتجر' });
  }
});

app.get('/api/stores/:id/categories', async (req, res) => {
  try {
    res.json(await getProductCategories(req.params.id));
  } catch (err) {
    logError('GET categories', err);
    res.status(500).json({ error: 'تعذر تحميل التصنيفات' });
  }
});

app.get('/api/stores/:id/products', async (req, res) => {
  try {
    const category = req.query.category ? String(req.query.category) : null;
    res.json(await getProducts(req.params.id, category));
  } catch (err) {
    logError('GET products', err);
    res.status(500).json({ error: 'تعذر تحميل المنتجات' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    res.json(await searchProducts(q));
  } catch (err) {
    logError('GET /api/search', err);
    res.status(500).json({ error: 'تعذر البحث' });
  }
});

// Proxies a Telegram-hosted product photo without exposing the bot token to the client.
// ── helper مشترك لجلب الملف من تيليجرام ──
async function fetchTgFile(fileId, res, contentTypeFallback) {
  // نجرب merchantBotToken أولاً ثم customerBotToken كاحتياط
  for (const token of [CONFIG.merchantBotToken, CONFIG.customerBotToken]) {
    try {
      const infoRes = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const info = await infoRes.json();
      if (!info.ok) continue;

      const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) continue;

      const contentType = fileRes.headers.get('content-type') || contentTypeFallback;
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Accept-Ranges', 'bytes');
      res.send(buffer);
      return true;
    } catch (_) {
      continue;
    }
  }
  return false;
}

// ── صور المنتجات والمتاجر ──
app.get('/api/image/:fileId', async (req, res) => {
  try {
    const ok = await fetchTgFile(req.params.fileId, res, 'image/jpeg');
    if (!ok) res.status(404).end();
  } catch (err) {
    logError('GET /api/image', err);
    res.status(500).end();
  }
});

// ── فيديوهات المنتجات ──
app.get('/api/video/:fileId', async (req, res) => {
  try {
    const ok = await fetchTgFile(req.params.fileId, res, 'video/mp4');
    if (!ok) res.status(404).end();
  } catch (err) {
    logError('GET /api/video', err);
    res.status(500).end();
  }
});

// ──────────────────────────────────────────────
// 6. ROUTES — authenticated (customer identity)
// ──────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  try {
    const customer = await getCustomer(req.tgUser.id);
    res.json({
      telegram_id: req.tgUser.id,
      first_name: req.tgUser.first_name ?? null,
      phone: customer?.phone ?? null,
      last_lat: customer?.last_lat ?? null,
      last_lng: customer?.last_lng ?? null,
    });
  } catch (err) {
    logError('GET /api/me', err);
    res.status(500).json({ error: 'تعذر تحميل حسابك' });
  }
});

app.get('/api/orders', auth, async (req, res) => {
  try {
    const page = Number(req.query.page || 0);
    res.json(await getCustomerOrders(req.tgUser.id, page));
  } catch (err) {
    logError('GET /api/orders', err);
    res.status(500).json({ error: 'تعذر تحميل طلباتك' });
  }
});

app.get('/api/orders/:id', auth, async (req, res) => {
  try {
    const order = await getOrderForCustomer(req.params.id, req.tgUser.id);
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json(order);
  } catch (err) {
    logError('GET /api/orders/:id', err);
    res.status(500).json({ error: 'تعذر تحميل الطلب' });
  }
});

app.post('/api/orders/:id/cancel', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { data: order, error } = await supabase
      .from('orders').select('id,order_number,status,created_at')
      .eq('id', orderId).eq('customer_telegram_id', String(req.tgUser.id)).maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `لا يمكن إلغاء الطلب بعد قبوله. الحالة الحالية: ${statusLabel(order.status)}` });
    }
    const elapsedMin = (Date.now() - new Date(order.created_at).getTime()) / 60000;
    if (elapsedMin > CONFIG.cancelWindowMin) {
      return res.status(400).json({ error: `انتهت مهلة الإلغاء (${CONFIG.cancelWindowMin} دقائق).` });
    }
    const { data: updated, error: upErr } = await supabase
      .from('orders')
      .update({ status: 'cancelled', cancel_reason: 'إلغاء بطلب الزبون', updated_at: new Date().toISOString() })
      .eq('id', orderId).eq('customer_telegram_id', String(req.tgUser.id)).eq('status', 'pending')
      .select('order_number').single();
    if (upErr || !updated) return res.status(400).json({ error: 'تعذر إلغاء الطلب، ربما تم قبوله للتو.' });
    res.json({ ok: true, order_number: updated.order_number });
  } catch (err) {
    logError('POST cancel', err);
    res.status(500).json({ error: 'حدث خطأ أثناء الإلغاء' });
  }
});

app.get('/api/favorites', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('favorites').select('product_id').eq('telegram_id', String(req.tgUser.id));
    if (error) throw error;
    res.json((data ?? []).map((x) => x.product_id));
  } catch (err) {
    logError('GET favorites', err);
    res.status(500).json({ error: 'تعذر تحميل المفضلة' });
  }
});

app.post('/api/favorites/:productId/toggle', auth, async (req, res) => {
  try {
    const productId = req.params.productId;
    const { data: existing } = await supabase
      .from('favorites').select('id').eq('telegram_id', String(req.tgUser.id)).eq('product_id', productId).maybeSingle();
    if (existing) {
      await supabase.from('favorites').delete().eq('telegram_id', String(req.tgUser.id)).eq('product_id', productId);
      return res.json({ favorite: false });
    }
    await supabase.from('favorites').insert({ telegram_id: String(req.tgUser.id), product_id: productId });
    res.json({ favorite: true });
  } catch (err) {
    logError('POST favorites toggle', err);
    res.status(500).json({ error: 'تعذر تحديث المفضلة' });
  }
});

// ──────────────────────────────────────────────
// 7. CHECKOUT — creates the order exactly like the customer bot does,
//    then notifies the merchant bot and the customer bot for follow-up.
// ──────────────────────────────────────────────
app.post('/api/checkout', auth, async (req, res) => {
  try {
    const { merchant_id, items, phone, lat, lng } = req.body || {};

    if (!merchant_id) return res.status(400).json({ error: 'المتجر غير محدد' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'السلة فارغة' });
    if (items.length > CONFIG.maxCartItems) return res.status(400).json({ error: 'عدد المنتجات أكبر من الحد المسموح' });
    if (!phone || String(phone).trim().length < 7) return res.status(400).json({ error: 'رقم هاتف غير صحيح' });
    if (!lat || !lng) return res.status(400).json({ error: 'يرجى تحديد موقع التوصيل' });

    const merchant = await getMerchant(merchant_id);
    if (!merchant?.active) return res.status(400).json({ error: 'المتجر غير متاح حالياً' });
    if (!merchant.is_open) return res.status(400).json({ error: 'المتجر مغلق حالياً، حاول لاحقاً' });

    const orderItems = [];
    let total = 0;
    for (const raw of items) {
      const qty = Math.max(1, Math.min(CONFIG.maxQtyPerItem, Math.round(Number(raw.qty) || 1)));
      const product = await getProduct(raw.product_id);
      if (!product || !product.is_available || String(product.merchant_id) !== String(merchant_id)) {
        return res.status(400).json({ error: `أحد المنتجات لم يعد متاحاً، حدّث السلة وحاول مجدداً.` });
      }
      const lineTotal = product.price * qty;
      orderItems.push({ product_id: product.id, name: product.name, price: product.price, qty, total: lineTotal });
      total += lineTotal;
    }

    const notes = orderItems.map((x) => `${x.name} × ${x.qty} = ${formatAmount(x.total)}`).join('\n');
    const orderNumber = await generateOrderNumber();

    const { data: order, error } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        merchant_id,
        customer_telegram_id: String(req.tgUser.id),
        customer_phone: String(phone).trim(),
        customer_lat: lat,
        customer_lng: lng,
        address: mapsUrl(lat, lng),
        notes,
        order_items: orderItems,
        total_amount: total,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) throw error;

    await upsertCustomer(req.tgUser.id, {
      full_name: req.tgUser.first_name ?? null,
      phone: String(phone).trim(),
      last_lat: lat,
      last_lng: lng,
    });

    // Notify the merchant — same accept/reject buttons the merchant bot already handles.
    if (merchant.telegram_id) {
      await tgApi(CONFIG.merchantBotToken, 'sendMessage', {
        chat_id: merchant.telegram_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          `🔔 <b>طلب جديد عبر المتجر الإلكتروني</b>\n\n` +
          `🆔 رقم الطلب: <code>${orderNumber}</code>\n` +
          `📱 الزبون: ${esc(phone)}\n` +
          `💰 المجموع: <b>${formatAmount(total)}</b>\n\n` +
          `🛒 <b>المنتجات:</b>\n${esc(notes)}\n\n` +
          `📍 <a href="${mapsUrl(lat, lng)}">موقع الزبون</a>`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ قبول', callback_data: `accept_order_m:${order.id}` },
              { text: '❌ رفض', callback_data: `reject_order_m:${order.id}` },
            ],
            [{ text: '🔄 تحديث الطلب', callback_data: `refresh_order:${order.id}` }],
          ],
        },
      });
    }

    // Confirm in the customer bot chat too, so follow-up works from Telegram as well.
    await tgApi(CONFIG.customerBotToken, 'sendMessage', {
      chat_id: req.tgUser.id,
      parse_mode: 'HTML',
      text:
        `🎉 <b>تم إرسال طلبك من المتجر الإلكتروني!</b>\n\n` +
        `🆔 رقم الطلب: <code>${orderNumber}</code>\n` +
        `🏪 ${esc(merchant.store_name)}\n` +
        `💰 ${formatAmount(total)}\n\n` +
        `⏳ تابع حالته هنا في المحادثة أو من داخل المتجر الإلكتروني.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 متابعة الطلب', callback_data: `order_status:${order.id}` }],
          [{ text: '❌ إلغاء الطلب', callback_data: `try_cancel:${order.id}` }],
        ],
      },
    });

    res.json({ ok: true, order_id: order.id, order_number: orderNumber, total_amount: total });
  } catch (err) {
    logError('POST /api/checkout', err);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الطلب، حاول مجدداً' });
  }
});

// ──────────────────────────────────────────────
// 8. START
// ──────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`🛍 Nawras mini app server running on port ${CONFIG.port}`);
});

process.on('unhandledRejection', (r) => logError('unhandledRejection', r));
process.on('uncaughtException', (e) => logError('uncaughtException', e));