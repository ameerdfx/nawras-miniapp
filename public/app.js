'use strict';

/* ════════════════════════════════════════════
   0. TELEGRAM BRIDGE + LOW-LEVEL HELPERS
   ════════════════════════════════════════════ */
const tg = window.Telegram?.WebApp ?? null;
if (tg) {
  tg.ready();
  tg.expand();
  try { document.body.style.background = tg.themeParams?.bg_color || ''; } catch (_) {}
}

const root = document.getElementById('app-root');
const CART_KEY = 'nawras_cart_v1';

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function formatAmount(n) {
  return `${Number(n || 0).toLocaleString('ar-IQ')} د.ع`;
}
function formatDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleString('ar-IQ', { dateStyle: 'short', timeStyle: 'short' });
}

let toastTimer = null;
function toast(msg, isError = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData || '',
      ...(opts.headers || {}),
    },
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

function seagullSVG(color = 'currentColor', size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M1 13C5 6 9 6 12 11C15 6 19 6 23 13" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* ════════════════════════════════════════════
   1. STATE
   ════════════════════════════════════════════ */
const state = {
  cart: [],
  favorites: new Set(),
  profile: null,
};

let browsingScreen = false;

function loadCart() {
  try { state.cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
  catch (_) { state.cart = []; }
}
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  updateCartBadge();
  syncCartBar();
}
function cartCount() { return state.cart.reduce((s, i) => s + i.qty, 0); }
function cartTotal() { return state.cart.reduce((s, i) => s + i.price * i.qty, 0); }

function addToCart(product) {
  if (state.cart.length && state.cart[0].merchant_id !== product.merchant_id) {
    if (!confirm('لديك منتجات من متجر آخر في سلتك. إفراغ السلة والبدء من هذا المتجر؟')) return;
    state.cart = [];
  }
  const existing = state.cart.find((x) => x.id === product.id);
  if (existing) {
    existing.qty = Math.min(10, existing.qty + 1);
  } else {
    state.cart.push({ id: product.id, merchant_id: product.merchant_id, name: product.name, price: product.price, qty: 1 });
  }
  saveCart();
  toast(`✅ أُضيف «${product.name}» للسلة`);
}

function changeQty(productId, delta) {
  const item = state.cart.find((x) => x.id === productId);
  if (!item) return;
  item.qty = Math.max(0, Math.min(10, item.qty + delta));
  if (item.qty === 0) state.cart = state.cart.filter((x) => x.id !== productId);
  saveCart();
  renderCart();
}

function changeProductQty(productId, delta) {
  const item = state.cart.find((x) => x.id === productId);
  if (!item) return;
  item.qty = Math.max(0, Math.min(10, item.qty + delta));
  if (item.qty === 0) state.cart = state.cart.filter((x) => x.id !== productId);
  saveCart();
}

function clearCart() {
  state.cart = [];
  saveCart();
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  if (!badge) return;
  const n = cartCount();
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

function syncCartBar() {
  if (!browsingScreen) return;
  if (cartCount() > 0) {
    setMainButton(`🛒 عرض السلة · ${cartCount()} — ${formatAmount(cartTotal())}`, () => pushScreen(renderCart), { color: '#FF5A3C' });
  } else {
    hideMainButton();
  }
}

/* ════════════════════════════════════════════
   2. NAVIGATION
   ════════════════════════════════════════════ */
const navStack = [];

function pushScreen(renderFn) {
  navStack.push(renderFn);
  renderFn();
  syncBackButton();
  window.scrollTo(0, 0);
}
function replaceScreen(renderFn) {
  navStack.length = 0;
  navStack.push(renderFn);
  renderFn();
  syncBackButton();
  window.scrollTo(0, 0);
}
function goBack() {
  if (navStack.length <= 1) return;
  navStack.pop();
  navStack[navStack.length - 1]();
  syncBackButton();
  window.scrollTo(0, 0);
}
function syncBackButton() {
  if (!tg?.BackButton) return;
  if (navStack.length > 1) tg.BackButton.show();
  else tg.BackButton.hide();
}
if (tg?.BackButton) tg.BackButton.onClick(goBack);

function setMainButton(text, onClick, opts = {}) {
  if (tg?.MainButton) {
    tg.MainButton.setText(text);
    tg.MainButton.offClick(tg.MainButton._lastHandler || (() => {}));
    tg.MainButton._lastHandler = onClick;
    tg.MainButton.onClick(onClick);
    if (opts.color) tg.MainButton.setParams({ color: opts.color });
    if (opts.disabled) tg.MainButton.disable(); else tg.MainButton.enable();
    tg.MainButton.show();
    hideFallbackButton();
    return;
  }
  showFallbackButton(text, onClick, opts);
}
function hideMainButton() {
  tg?.MainButton?.hide();
  hideFallbackButton();
}
function showFallbackButton(text, onClick, opts = {}) {
  const bar = document.getElementById('fallback-main-btn');
  const btn = document.getElementById('fallback-main-btn-action');
  if (!bar || !btn) return;
  btn.textContent = text;
  btn.disabled = !!opts.disabled;
  btn.style.background = opts.color || '';
  btn.onclick = onClick;
  bar.classList.remove('hidden');
  document.body.classList.add('has-fallback-btn');
}
function hideFallbackButton() {
  const bar = document.getElementById('fallback-main-btn');
  if (bar) bar.classList.add('hidden');
  document.body.classList.remove('has-fallback-btn');
}

/* ════════════════════════════════════════════
   3. HEADER
   ════════════════════════════════════════════ */
function renderHeaderActions() {
  document.getElementById('header-cart-btn').onclick = () => pushScreen(renderCart);
  document.getElementById('header-orders-btn').onclick = () => pushScreen(renderOrders);
  document.getElementById('brand-home-btn').onclick = () => replaceScreen(renderHome);
  updateCartBadge();
}

/* ════════════════════════════════════════════
   4. SKELETONS & EMPTY STATES
   ════════════════════════════════════════════ */
function skeletonStores(n = 4) {
  return `<div class="skeleton-stack">${Array.from({ length: n }).map(() => `
    <div class="skeleton-card">
      <div class="sk-banner shimmer"></div>
      <div class="sk-line shimmer" style="width:55%"></div>
      <div class="sk-line shimmer" style="width:30%"></div>
    </div>
  `).join('')}</div>`;
}
function skeletonMenu(n = 4) {
  return `<div class="skeleton-stack">${Array.from({ length: n }).map(() => `
    <div class="skeleton-row">
      <div class="sk-text">
        <div class="sk-line shimmer" style="width:75%;margin:0 0 10px"></div>
        <div class="sk-line shimmer" style="width:35%;margin:0"></div>
      </div>
      <div class="sk-thumb shimmer"></div>
    </div>
  `).join('')}</div>`;
}

function emptyState(glyph, title, sub) {
  return `<div class="empty-state"><span class="glyph">${glyph}</span><div class="title">${escapeHtml(title)}</div><div>${escapeHtml(sub || '')}</div></div>`;
}

function avatarInitial(name) {
  return escapeHtml(String(name || '؟').trim().charAt(0).toUpperCase());
}
function hueFromName(name) {
  let sum = 0;
  for (const ch of String(name || '')) sum += ch.codePointAt(0);
  return sum % 360;
}

/* ════════════════════════════════════════════
   5. HOME — store list
   ════════════════════════════════════════════ */
let storesCache = [];
let openOnly = false;

async function renderHome() {
  browsingScreen = true;
  hideMainButton();
  root.innerHTML = `
    <h1 class="screen-title">المتاجر القريبة منك</h1>
    <p class="screen-sub">اختر متجراً وابدأ طلبك 🛍</p>
    <div class="search-bar">
      <span>🔍</span>
      <input id="store-search" placeholder="ابحث عن منتج في كل المتاجر..." />
    </div>
    <div class="chip-row">
      <button class="chip ${!openOnly ? 'active' : ''}" id="chip-all">الكل</button>
      <button class="chip ${openOnly ? 'active' : ''}" id="chip-open">🟢 المفتوحة فقط</button>
    </div>
    <div id="store-list" class="store-list">${skeletonStores(4)}</div>
  `;

  document.getElementById('chip-all').onclick = () => { openOnly = false; renderHome(); };
  document.getElementById('chip-open').onclick = () => { openOnly = true; renderHome(); };

  let searchTimer = null;
  document.getElementById('store-search').oninput = (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) pushScreen(() => renderSearch(q));
    }, 400);
  };

  try {
    storesCache = await api(`/stores?open=${openOnly}`);
  } catch (err) {
    document.getElementById('store-list').innerHTML = emptyState('😕', 'تعذر تحميل المتاجر', err.message);
    syncCartBar();
    return;
  }

  const list = document.getElementById('store-list');
  if (!storesCache.length) {
    list.innerHTML = emptyState('🏪', 'لا توجد متاجر متاحة الآن', 'حاول لاحقاً أو تصفح الكل.');
    syncCartBar();
    return;
  }
  list.innerHTML = storesCache.map(storeCard).join('');
  list.querySelectorAll('.store-card-pro').forEach((card) => {
    card.onclick = () => pushScreen(() => renderStore(card.dataset.id));
  });
  syncCartBar();
}

function storeCard(s) {
  const hue = hueFromName(s.store_name);
  const hue2 = (hue + 35) % 360;

  // ── صورة المتجر إن وُجدت، وإلا تدرّج لوني مع الحرف الأول ──
  const coverContent = s.store_image_file_id
    ? `<img
         class="store-cover-img"
         src="/api/image/${encodeURIComponent(s.store_image_file_id)}"
         alt="${escapeHtml(s.store_name)}"
         loading="lazy"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
       />
       <span class="store-cover-initial" style="display:none">${avatarInitial(s.store_name)}</span>`
    : `<span class="store-cover-initial">${avatarInitial(s.store_name)}</span>`;

  const coverStyle = s.store_image_file_id
    ? ''
    : `style="background:linear-gradient(135deg, hsl(${hue} 48% 30%), hsl(${hue2} 42% 18%))"`;

  return `
    <button class="store-card-pro" data-id="${s.id}">
      <div class="store-cover ${s.store_image_file_id ? 'store-cover-photo' : ''}" ${coverStyle}>
        ${coverContent}
        ${!s.is_open ? `<div class="store-cover-dim"><span>مغلق حالياً</span></div>` : ''}
      </div>
      <div class="store-card-body">
        <div class="store-card-top">
          <h3 class="store-card-name">${escapeHtml(s.store_name)}</h3>
          <span class="status-dot ${s.is_open ? 'open' : 'closed'}"></span>
        </div>
        <span class="store-card-sub">${s.is_open ? 'مفتوح الآن · جاهز لاستقبال طلبك' : 'سيعاود الفتح قريباً'}</span>
      </div>
    </button>
  `;
}

/* ════════════════════════════════════════════
   6. SEARCH RESULTS
   ════════════════════════════════════════════ */
async function renderSearch(query) {
  browsingScreen = true;
  hideMainButton();
  root.innerHTML = `
    <h1 class="screen-title">نتائج البحث</h1>
    <p class="screen-sub">"${escapeHtml(query)}"</p>
    <div id="search-results">${skeletonMenu(4)}</div>
  `;
  try {
    const products = await api(`/search?q=${encodeURIComponent(query)}`);
    renderProductList(document.getElementById('search-results'), products);
  } catch (err) {
    document.getElementById('search-results').innerHTML = emptyState('😕', 'تعذر البحث', err.message);
  }
  syncCartBar();
}

/* ════════════════════════════════════════════
   7. STORE — categories + products
   ════════════════════════════════════════════ */
let activeStoreId = null;
let activeCategory = 'all';
let storeProductsCache = [];

async function renderStore(storeId) {
  browsingScreen = true;
  hideMainButton();
  activeStoreId = storeId;
  root.innerHTML = `
    <div class="skeleton-card" style="margin-bottom:14px">
      <div class="sk-banner shimmer"></div>
      <div class="sk-line shimmer" style="width:55%"></div>
      <div class="sk-line shimmer" style="width:30%"></div>
    </div>
    ${skeletonMenu(4)}
  `;
  let merchant, categories;
  try {
    [merchant, categories] = await Promise.all([
      api(`/stores/${storeId}`),
      api(`/stores/${storeId}/categories`),
    ]);
  } catch (err) {
    root.innerHTML = emptyState('😕', 'تعذر تحميل المتجر', err.message);
    syncCartBar();
    return;
  }

  activeCategory = 'all';
  root.innerHTML = `
    <div class="store-hero">
      <div class="store-hero-name">${escapeHtml(merchant.store_name)}</div>
      <span class="pill ${merchant.is_open ? 'pill-open' : 'pill-closed'}">${merchant.is_open ? '🟢 مفتوح الآن' : '🔴 مغلق حالياً'}</span>
    </div>
    <div class="chip-row" id="cat-chips">
      <button class="chip active" data-cat="all">📋 الكل</button>
      ${categories.map((c) => `<button class="chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
    </div>
    <div id="product-area">${skeletonMenu(4)}</div>
  `;

  document.querySelectorAll('#cat-chips .chip').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('#cat-chips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeCategory = chip.dataset.cat;
      loadStoreProducts(storeId, activeCategory);
    };
  });

  await loadStoreProducts(storeId, 'all');
  if (!merchant.is_open) {
    toast('هذا المتجر مغلق حالياً، يمكنك التصفح فقط', false);
  }
}

async function loadStoreProducts(storeId, category) {
  const area = document.getElementById('product-area');
  area.innerHTML = skeletonMenu(4);
  try {
    const products = await api(`/stores/${storeId}/products?category=${encodeURIComponent(category)}`);
    storeProductsCache = products;
    renderProductList(area, products);
  } catch (err) {
    area.innerHTML = emptyState('😕', 'تعذر تحميل المنتجات', err.message);
  }
  syncCartBar();
}

/* ════════════════════════════════════════════
   8. بطاقات المنتجات — مع دعم الصور والفيديو
   ════════════════════════════════════════════ */
function renderProductList(container, products) {
  if (!products.length) {
    container.innerHTML = emptyState('🛒', 'لا توجد منتجات', 'جرّب تصنيفاً أو كلمة بحث أخرى.');
    return;
  }
  container.innerHTML = `<div class="menu-list">${products.map(productCard).join('')}</div>`;
  bindProductCardEvents(container, products);
}

/**
 * buildProductMedia — يبني عنصر الوسائط المناسب للمنتج
 *
 * الأولوية:
 *  1. فيديو  (media_type === 'video' && video_file_id)
 *  2. صورة   (image_file_id)
 *  3. placeholder نصي
 */
function buildProductMedia(p) {
  if (p.media_type === 'video' && p.video_file_id) {
    return `
      <div class="product-media-wrap product-video-wrap" data-product-id="${p.id}" data-video-file="${escapeHtml(p.video_file_id)}" data-video-name="${escapeHtml(p.name)}">
        <video
          class="product-video"
          src="/api/video/${encodeURIComponent(p.video_file_id)}"
          poster="/api/image/${encodeURIComponent(p.video_file_id)}?poster=1"
          playsinline
          loop
          muted
          preload="none"
          aria-label="${escapeHtml(p.name)}"
        ></video>
        <button class="video-play-btn" aria-label="تشغيل الفيديو">▶</button>
        <button type="button" class="video-expand-btn" aria-label="عرض تفاصيل المنتج">⛶</button>
      </div>`;
  }

  if (p.image_file_id) {
    return `
      <img
        class="product-img"
        data-product-id="${p.id}"
        src="/api/image/${encodeURIComponent(p.image_file_id)}"
        loading="lazy"
        alt="${escapeHtml(p.name)}"
        onerror="this.outerHTML='<div class=\\'product-img-placeholder\\'>🛍</div>'"
      />`;
  }

  return `<div class="product-img-placeholder">🛍</div>`;
}

function productCard(p) {
  const inCart = state.cart.find((x) => x.id === p.id);
  const media = buildProductMedia(p);

  const control = inCart
    ? `<div class="stepper-mini">
         <button data-prod-minus="${p.id}" aria-label="إنقاص الكمية">−</button>
         <span class="qty-num">${inCart.qty}</span>
         <button data-prod-plus="${p.id}" aria-label="زيادة الكمية">+</button>
       </div>`
    : `<button class="add-circle" data-add="${p.id}" aria-label="أضف للسلة">+</button>`;

  return `
    <div class="menu-item" data-id="${p.id}">
      <div class="menu-item-info">
        <div class="menu-item-name">${escapeHtml(p.name)}</div>
        ${p.description ? `<div class="menu-item-desc">${escapeHtml(p.description)}</div>` : ''}
        <div class="menu-item-price">${formatAmount(p.price)}</div>
      </div>
      <div class="menu-item-media">
        ${media}
        <button class="fav-chip" data-fav="${p.id}" aria-label="إضافة للمفضلة">🤍</button>
        <div class="qty-control">${control}</div>
      </div>
    </div>
  `;
}

function bindProductCardEvents(container, products) {
  // ── إضافة للسلة ──
  container.querySelectorAll('[data-add]').forEach((btn) => {
    btn.onclick = () => {
      const product = products.find((p) => String(p.id) === btn.dataset.add);
      if (!product) return;
      addToCart(product);
      renderProductList(container, products);
    };
  });

  // ── ضبط الكمية أثناء التصفح ──
  container.querySelectorAll('[data-prod-minus]').forEach((btn) => {
    btn.onclick = () => {
      changeProductQty(btn.dataset.prodMinus, -1);
      renderProductList(container, products);
    };
  });
  container.querySelectorAll('[data-prod-plus]').forEach((btn) => {
    btn.onclick = () => {
      changeProductQty(btn.dataset.prodPlus, +1);
      renderProductList(container, products);
    };
  });

  // ── المفضلة ──
  container.querySelectorAll('[data-fav]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const { favorite } = await api(`/favorites/${btn.dataset.fav}/toggle`, { method: 'POST' });
        btn.textContent = favorite ? '💛' : '🤍';
      } catch (err) {
        toast(err.message, true);
      }
    };
  });

  /* ── الفيديو: تشغيل/إيقاف مصغّر + فتح بطاقة المنتج الكاملة ── */
  container.querySelectorAll('.product-video-wrap').forEach((wrap) => {
    const video = wrap.querySelector('video');
    const playBtn = wrap.querySelector('.video-play-btn');
    const expandBtn = wrap.querySelector('.video-expand-btn');
    if (!video) return;

    // زر Play/Pause المصغّر (داخل البطاقة)
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (video.paused) {
          video.play().catch(() => {});
          playBtn.textContent = '⏸';
          playBtn.classList.add('playing');
        } else {
          video.pause();
          playBtn.textContent = '▶';
          playBtn.classList.remove('playing');
        }
      });
    }

    // زر ⛶ — يفتح بطاقة تفاصيل المنتج الكاملة
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const product = products.find((p) => String(p.id) === wrap.dataset.productId);
        if (product) openProductSheet(product, container, products);
      });
    }

    video.addEventListener('loadeddata', () => wrap.classList.add('loaded'));
    video.addEventListener('ended', () => {
      if (playBtn) { playBtn.textContent = '▶'; playBtn.classList.remove('playing'); }
    });
  });

  // ── الضغط على الصورة المصغّرة → فتح بطاقة تفاصيل المنتج الكاملة ──
  container.querySelectorAll('.product-img').forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.onclick = () => {
      const product = products.find((p) => String(p.id) === img.dataset.productId);
      if (product) openProductSheet(product, container, products);
    };
  });
}

/* ════════════════════════════════════════════
   8b. بطاقة تفاصيل المنتج الكاملة (Product Sheet)
   تُفتح عند الضغط على صورة أو فيديو المنتج، وتعرض
   الوسائط بحجم أكبر + الاسم + الوصف + السعر + التحكم بالسلة
   ════════════════════════════════════════════ */
function buildSheetMedia(p) {
  if (p.media_type === 'video' && p.video_file_id) {
    return `
      <div class="sheet-media-wrap">
        <video
          class="sheet-video"
          src="/api/video/${encodeURIComponent(p.video_file_id)}"
          poster="/api/image/${encodeURIComponent(p.video_file_id)}?poster=1"
          playsinline
          controls
          loop
          muted
          autoplay
          aria-label="${escapeHtml(p.name)}"
        ></video>
      </div>`;
  }
  if (p.image_file_id) {
    return `
      <div class="sheet-media-wrap">
        <img class="sheet-img" src="/api/image/${encodeURIComponent(p.image_file_id)}" alt="${escapeHtml(p.name)}" />
      </div>`;
  }
  return `<div class="sheet-media-wrap"><div class="sheet-img-placeholder">🛍</div></div>`;
}

function buildSheetControl(p) {
  const inCart = state.cart.find((x) => x.id === p.id);
  if (inCart) {
    return `
      <div class="stepper sheet-stepper">
        <button data-sheet-minus="${p.id}" aria-label="إنقاص الكمية">−</button>
        <span class="qty">${inCart.qty}</span>
        <button data-sheet-plus="${p.id}" aria-label="زيادة الكمية">+</button>
      </div>`;
  }
  return `<button class="secondary-btn sheet-add-btn" id="sheet-add-btn" data-sheet-add="${p.id}">🛒 أضف للسلة</button>`;
}

function openProductSheet(p, sourceContainer, sourceProducts) {
  closeProductSheet();

  const box = document.createElement('div');
  box.id = 'nawras-sheet';
  box.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-content">
      <button class="sheet-close" aria-label="إغلاق">✕</button>
      ${buildSheetMedia(p)}
      <div class="sheet-body">
        <div class="sheet-name">${escapeHtml(p.name)}</div>
        ${p.description ? `<div class="sheet-desc">${escapeHtml(p.description)}</div>` : ''}
        <div class="sheet-price">${formatAmount(p.price)}</div>
        <div class="sheet-control-area" id="sheet-control-area">${buildSheetControl(p)}</div>
      </div>
    </div>
  `;
  document.body.appendChild(box);
  document.body.classList.add('sheet-open');

  bindSheetControlEvents(box, p, sourceContainer, sourceProducts);

  box.querySelector('.sheet-backdrop').onclick = closeProductSheet;
  box.querySelector('.sheet-close').onclick = closeProductSheet;
  const onKey = (e) => { if (e.key === 'Escape') { closeProductSheet(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  requestAnimationFrame(() => box.classList.add('sheet-visible'));
}

function bindSheetControlEvents(box, p, sourceContainer, sourceProducts) {
  const refreshControl = () => {
    const area = box.querySelector('#sheet-control-area');
    if (area) { area.innerHTML = buildSheetControl(p); bindSheetControlEvents(box, p, sourceContainer, sourceProducts); }
  };
  const refreshSource = () => {
    if (sourceContainer && Array.isArray(sourceProducts) && sourceProducts.length) {
      renderProductList(sourceContainer, sourceProducts);
    }
  };
  const addBtn = box.querySelector('[data-sheet-add]');
  if (addBtn) {
    addBtn.onclick = () => { addToCart(p); refreshControl(); refreshSource(); };
  }
  const minusBtn = box.querySelector('[data-sheet-minus]');
  if (minusBtn) {
    minusBtn.onclick = () => { changeProductQty(p.id, -1); refreshControl(); refreshSource(); };
  }
  const plusBtn = box.querySelector('[data-sheet-plus]');
  if (plusBtn) {
    plusBtn.onclick = () => { changeProductQty(p.id, +1); refreshControl(); refreshSource(); };
  }
}

function closeProductSheet() {
  const sheet = document.getElementById('nawras-sheet');
  if (!sheet) return;
  const video = sheet.querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  sheet.remove();
  document.body.classList.remove('sheet-open');
}

/* ════════════════════════════════════════════
   9. CART
   ════════════════════════════════════════════ */
function renderCart() {
  browsingScreen = false;
  if (!state.cart.length) {
    hideMainButton();
    root.innerHTML = `${emptyState('🛒', 'سلتك فارغة', 'تصفح المتاجر وأضف ما يعجبك')}
      <button class="secondary-btn" id="browse-btn">🏪 تصفح المتاجر</button>`;
    document.getElementById('browse-btn').onclick = () => replaceScreen(renderHome);
    return;
  }
  root.innerHTML = `
    <h1 class="screen-title">🛒 سلتك</h1>
    <div id="cart-lines">${state.cart.map(cartLine).join('')}</div>
    <div class="summary-card">
      <div class="summary-row"><span>عدد المنتجات</span><span>${cartCount()}</span></div>
      <div class="summary-row total"><span>المجموع</span><span>${formatAmount(cartTotal())}</span></div>
    </div>
    <button class="secondary-btn" id="clear-btn">🗑 إفراغ السلة</button>
  `;
  document.getElementById('clear-btn').onclick = () => {
    if (confirm('إفراغ السلة بالكامل؟')) { clearCart(); renderCart(); }
  };
  document.querySelectorAll('[data-plus]').forEach((b) => (b.onclick = () => changeQty(b.dataset.plus, +1)));
  document.querySelectorAll('[data-minus]').forEach((b) => (b.onclick = () => changeQty(b.dataset.minus, -1)));

  setMainButton(`إتمام الطلب — ${formatAmount(cartTotal())}`, () => pushScreen(renderCheckout), { color: '#FF5A3C' });
}

function cartLine(item) {
  return `
    <div class="cart-line">
      <div class="info">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="unit-price">${formatAmount(item.price)} للوحدة</div>
      </div>
      <div class="stepper" style="max-width:90px">
        <button data-minus="${item.id}">−</button>
        <span class="qty">${item.qty}</span>
        <button data-plus="${item.id}">+</button>
      </div>
      <div class="line-total">${formatAmount(item.price * item.qty)}</div>
    </div>
  `;
}

/* ════════════════════════════════════════════
   10. CHECKOUT
   ════════════════════════════════════════════ */
let checkoutLocation = null;

async function renderCheckout() {
  browsingScreen = false;
  if (!state.cart.length) return replaceScreen(renderHome);

  let profile = null;
  try { profile = await api('/me'); } catch (_) {}
  state.profile = profile;
  checkoutLocation = profile?.last_lat ? { lat: profile.last_lat, lng: profile.last_lng } : null;

  root.innerHTML = `
    <h1 class="screen-title">📋 تأكيد الطلب</h1>
    <div class="field">
      <label>📱 رقم الهاتف</label>
      <input id="phone-input" type="tel" placeholder="07xxxxxxxxx" value="${escapeHtml(profile?.phone || '')}" />
      ${tg?.requestContact ? `<button class="secondary-btn" id="use-tg-phone">استخدام رقم تيليجرام</button>` : ''}
    </div>
    <div class="field">
      <label>📍 موقع التوصيل</label>
      <div id="loc-status" class="location-status ${checkoutLocation ? '' : 'pending'}">
        ${checkoutLocation ? '✅ تم تحديد موقعك المحفوظ' : '⏳ لم يتم تحديد الموقع بعد'}
      </div>
      <button class="secondary-btn" id="get-location-btn">📍 تحديد موقعي الحالي</button>
      <div class="field-hint">إن لم يعمل تحديد الموقع، الصق رابط موقعك من تطبيق الخرائط:</div>
      <input id="maps-link-input" placeholder="https://maps.google.com/?q=..." />
    </div>
    <div class="summary-card">
      <div class="summary-row"><span>عدد المنتجات</span><span>${cartCount()}</span></div>
      <div class="summary-row total"><span>المجموع</span><span>${formatAmount(cartTotal())}</span></div>
    </div>
  `;

  if (tg?.requestContact) {
    document.getElementById('use-tg-phone').onclick = () => {
      tg.requestContact((granted, data) => {
        const phone = data?.responseUnsafe?.contact?.phone_number;
        if (granted && phone) {
          document.getElementById('phone-input').value = phone;
          toast('✅ تم جلب رقمك من تيليجرام');
        } else {
          toast('لم تتم مشاركة الرقم', true);
        }
      });
    };
  }

  document.getElementById('get-location-btn').onclick = async () => {
    const statusEl = document.getElementById('loc-status');
    statusEl.className = 'location-status pending';
    statusEl.textContent = '⏳ جارٍ تحديد موقعك...';
    try {
      checkoutLocation = await getDeviceLocation();
      statusEl.className = 'location-status';
      statusEl.textContent = '✅ تم تحديد موقعك بنجاح';
    } catch (err) {
      statusEl.className = 'location-status pending';
      statusEl.textContent = `⚠️ ${err.message}`;
    }
  };

  document.getElementById('maps-link-input').oninput = (e) => {
    const m = e.target.value.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
    if (m) {
      checkoutLocation = { lat: Number(m[1]), lng: Number(m[2]) };
      const statusEl = document.getElementById('loc-status');
      statusEl.className = 'location-status';
      statusEl.textContent = '✅ تم تحديد الموقع من الرابط';
    }
  };

  setMainButton('✅ تأكيد وإرسال الطلب', submitOrder, { color: '#0E7C74' });
}

function getDeviceLocation() {
  return new Promise((resolve, reject) => {
    if (tg?.LocationManager?.init) {
      tg.LocationManager.init(() => {
        if (!tg.LocationManager.isLocationAvailable) return fallbackBrowserGeo(resolve, reject);
        tg.LocationManager.getLocation((data) => {
          if (data) resolve({ lat: data.latitude, lng: data.longitude });
          else fallbackBrowserGeo(resolve, reject);
        });
      });
    } else {
      fallbackBrowserGeo(resolve, reject);
    }
  });
}
function fallbackBrowserGeo(resolve, reject) {
  if (!navigator.geolocation) return reject(new Error('الموقع غير متاح، الصق رابط موقعك بالأسفل'));
  navigator.geolocation.getCurrentPosition(
    (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => reject(new Error('تعذر الوصول لموقعك، فعّل الصلاحية أو الصق رابط موقعك')),
    { timeout: 10000 }
  );
}

async function submitOrder() {
  const phone = document.getElementById('phone-input').value.trim();
  if (phone.length < 7) return toast('أدخل رقم هاتف صحيح', true);
  if (!checkoutLocation) return toast('يرجى تحديد موقع التوصيل', true);

  setMainButton('⏳ جارٍ إرسال طلبك...', () => {}, { disabled: true });
  try {
    const result = await api('/checkout', {
      method: 'POST',
      body: JSON.stringify({
        merchant_id: state.cart[0].merchant_id,
        items: state.cart.map((i) => ({ product_id: i.id, qty: i.qty })),
        phone,
        lat: checkoutLocation.lat,
        lng: checkoutLocation.lng,
      }),
    });
    clearCart();
    tg?.HapticFeedback?.notificationOccurred?.('success');
    replaceScreen(() => renderOrderSuccess(result));
  } catch (err) {
    toast(err.message, true);
    setMainButton('✅ تأكيد وإرسال الطلب', submitOrder, { color: '#0E7C74' });
  }
}

function renderOrderSuccess(result) {
  browsingScreen = false;
  hideMainButton();
  root.innerHTML = `
    <div class="empty-state">
      <span class="glyph">🎉</span>
      <div class="title">تم إرسال طلبك بنجاح!</div>
      <div>رقم الطلب <b>#${result.order_number}</b><br/>المجموع: ${formatAmount(result.total_amount)}</div>
    </div>
    <button class="secondary-btn" id="track-btn">🔄 تابع حالة الطلب</button>
    <button class="secondary-btn" id="home-btn">🏪 رجوع للمتاجر</button>
  `;
  document.getElementById('track-btn').onclick = () => pushScreen(() => renderOrderDetail(result.order_id));
  document.getElementById('home-btn').onclick = () => replaceScreen(renderHome);
}

/* ════════════════════════════════════════════
   11. ORDERS LIST
   ════════════════════════════════════════════ */
async function renderOrders() {
  browsingScreen = false;
  hideMainButton();
  root.innerHTML = `<h1 class="screen-title">📦 طلباتي</h1><div id="orders-list">${skeletonMenu(3)}</div>`;
  try {
    const { orders } = await api('/orders?page=0');
    const list = document.getElementById('orders-list');
    if (!orders.length) {
      list.innerHTML = `${emptyState('📦', 'لا توجد طلبات بعد', 'ابدأ طلبك الأول الآن')}
        <button class="secondary-btn" id="browse-btn2">🏪 تصفح المتاجر</button>`;
      document.getElementById('browse-btn2').onclick = () => replaceScreen(renderHome);
      return;
    }
    list.innerHTML = orders.map((o) => `
      <div class="order-card" data-id="${o.id}">
        <div class="row1"><span>#${o.order_number}</span><span class="status-badge status-${o.status}">${statusLabel(o.status)}</span></div>
        <div class="row2"><span>${escapeHtml(o.merchants?.store_name || '')}</span><span>${formatAmount(o.total_amount)}</span></div>
        <div class="row2"><span>${formatDate(o.created_at)}</span><span></span></div>
      </div>
    `).join('');
    list.querySelectorAll('.order-card').forEach((c) => {
      c.onclick = () => pushScreen(() => renderOrderDetail(c.dataset.id));
    });
  } catch (err) {
    document.getElementById('orders-list').innerHTML = emptyState('😕', 'تعذر تحميل طلباتك', err.message);
  }
}

const STATUS_LABELS = {
  pending: '⏳ بانتظار القبول', accepted: '✅ مقبول', preparing: '👨‍🍳 قيد التحضير',
  ready: '📦 جاهز', on_the_way: '🛵 في الطريق', delivered: '🎉 تم التسليم',
  cancelled: '❌ ملغي', rejected: '⛔ مرفوض',
};
function statusLabel(s) { return STATUS_LABELS[s] || s; }

/* ════════════════════════════════════════════
   12. ORDER DETAIL / TRACKING
   ════════════════════════════════════════════ */
let trackerPoll = null;

async function renderOrderDetail(orderId) {
  browsingScreen = false;
  hideMainButton();
  clearInterval(trackerPoll);
  root.innerHTML = `<h1 class="screen-title">تفاصيل الطلب</h1>${skeletonMenu(3)}`;
  await loadOrderDetail(orderId);
  trackerPoll = setInterval(() => loadOrderDetail(orderId, true), 15000);
}

async function loadOrderDetail(orderId, silent = false) {
  try {
    const o = await api(`/orders/${orderId}`);
    renderOrderDetailHtml(o);
  } catch (err) {
    if (!silent) root.innerHTML = emptyState('😕', 'تعذر تحميل الطلب', err.message);
  }
}

function renderOrderDetailHtml(o) {
  const items = Array.isArray(o.order_items) ? o.order_items : [];
  const itemsHtml = items.map((i) => `
    <div class="row"><span>${escapeHtml(i.name)} ×${i.qty}</span><span>${formatAmount(i.total)}</span></div>
  `).join('');

  root.innerHTML = `
    <h1 class="screen-title">طلب #${o.order_number}</h1>
    <p class="screen-sub">${escapeHtml(o.merchants?.store_name || '')} · ${formatDate(o.created_at)}</p>
    <div class="tracker-wrap">${renderTracker(o.status)}</div>
    <div class="detail-card">
      ${itemsHtml}
      <div class="row" style="font-weight:900;border-top:1px dashed var(--sand-deep);margin-top:6px">
        <span>المجموع</span><span>${formatAmount(o.total_amount)}</span>
      </div>
      ${o.delivery_fee ? `<div class="row"><span>أجرة التوصيل</span><span>${formatAmount(o.delivery_fee)}</span></div>` : ''}
    </div>
    ${o.reject_reason ? `<div class="cancelled-banner">سبب الرفض: ${escapeHtml(o.reject_reason)}</div>` : ''}
    ${o.cancel_reason ? `<div class="cancelled-banner">سبب الإلغاء: ${escapeHtml(o.cancel_reason)}</div>` : ''}
    ${o.status === 'pending' ? `<button class="danger-btn" id="cancel-order-btn">❌ إلغاء الطلب</button>` : ''}
  `;
  const cancelBtn = document.getElementById('cancel-order-btn');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (!confirm('هل أنت متأكد من إلغاء هذا الطلب؟')) return;
      try {
        await api(`/orders/${o.id}/cancel`, { method: 'POST' });
        toast('✅ تم إلغاء الطلب');
        loadOrderDetail(o.id);
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
}

const TRACK_STAGES = ['pending', 'accepted', 'preparing', 'ready', 'on_the_way', 'delivered'];
const TRACK_LABELS = { pending: 'تأكيد', accepted: 'قبول', preparing: 'تحضير', ready: 'جاهز', on_the_way: 'بالطريق', delivered: 'التسليم' };

function renderTracker(status) {
  if (status === 'cancelled' || status === 'rejected') {
    return `<div class="cancelled-banner">${status === 'cancelled' ? '❌ تم إلغاء هذا الطلب' : '⛔ تم رفض هذا الطلب من المتجر'}</div>`;
  }
  const idx = Math.max(0, TRACK_STAGES.indexOf(status));
  const n = TRACK_STAGES.length;
  const w = 300, pad = 22, y = 18;
  const step = (w - pad * 2) / (n - 1);

  let line = '', circles = '';
  for (let i = 0; i < n; i++) {
    const x = pad + step * i;
    const isDone = i < idx, isCurrent = i === idx;
    const fill = isDone ? 'var(--teal)' : isCurrent ? 'var(--coral)' : 'var(--sand-deep)';
    const r = isCurrent ? 7 : 5;
    circles += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${isCurrent ? 'class="tracker-current"' : ''} />`;
    if (i < n - 1) {
      const x2 = pad + step * (i + 1);
      const segDone = i < idx;
      line += `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y}" stroke="${segDone ? 'var(--teal)' : 'var(--sand-deep)'}" stroke-width="3" stroke-dasharray="${segDone ? '0' : '5,5'}" stroke-linecap="round" />`;
    }
  }
  const curX = pad + step * idx;
  const bird = `<g transform="translate(${curX} ${y - 14})">
    <path d="M-8 4 C-4 -6 0 -6 0 0 C0 -6 4 -6 8 4" stroke="var(--coral)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
  const svg = `<svg class="tracker-svg" viewBox="0 0 ${w} 32" xmlns="http://www.w3.org/2000/svg">${line}${circles}${bird}</svg>`;

  const labels = TRACK_STAGES.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'current' : '';
    return `<span class="${cls}">${TRACK_LABELS[s]}</span>`;
  }).join('');

  return `${svg}<div class="tracker-labels">${labels}</div>`;
}

/* ════════════════════════════════════════════
   13. BOOTSTRAP
   ════════════════════════════════════════════ */
function init() {
  loadCart();
  renderHeaderActions();
  navStack.push(renderHome);
  renderHome();
  syncBackButton();
}

document.addEventListener('DOMContentLoaded', init);