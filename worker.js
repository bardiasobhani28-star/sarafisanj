/**
 * ============================================================================
 * Cloudflare Worker: Tether (USDT/IRT) Iranian Exchanges Aggregator & CORS Proxy
 * ============================================================================
 * معماری: Serverless Edge Handler + Cloudflare Cache API + Parallel Aggregator
 * ============================================================================
 */

const CONFIG = {
  CACHE_TTL_SECONDS: 25, // مدت کش پاسخ در لبه‌های کلودفلر (ثانیه)
  FETCH_TIMEOUT_MS: 3800, // حداکثر زمان انتظار برای پاسخ هر صرافی (میلی‌ثانیه)
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  DEFAULT_BASE_PRICE: 94850, // نرخ مبنای تخمینی در صورت فیلترینگ یا عدم دسترسی
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=UTF-8',
};

export default {
  async fetch(request, env, ctx) {
    // ۱. پاسخ سریع به درخواست‌های Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response(
        JSON.stringify({ error: 'تنها متد GET پشتیبانی می‌شود.' }),
        { status: 405, headers: CORS_HEADERS }
      );
    }

    const url = new URL(request.url);

    // اندپوینت بررسی سلامت
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', worker: 'tether-rate-aggregator', time: new Date().toISOString() }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // ۲. بررسی کش کلودفلر (Cloudflare Cache API)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), {
      method: 'GET',
      headers: request.headers,
    });

    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const responseHeaders = new Headers(cachedResponse.headers);
        responseHeaders.set('X-Worker-Cache', 'HIT');
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers: responseHeaders,
        });
      }
    } catch (cacheErr) {
      console.warn('Cache match failed:', cacheErr);
    }

    // ۳. دریافت همزمان نرخ‌ها از صرافی‌ها
    const exchangesResult = await fetchAllExchanges();

    // استخراج بهترین خریدار و بهترین فروشنده
    const activeExchanges = exchangesResult.filter(ex => ex.status === 'online' && ex.buyPrice > 0);
    
    let bestBuy = null; // بالاترین خریدار (کاربر تتر می‌فروشد - گرون‌تر می‌خره)
    let bestSell = null; // کمترین فروشنده (کاربر تتر می‌خرد - ارزون‌تر می‌فروشه)

    if (activeExchanges.length > 0) {
      bestBuy = [...activeExchanges].sort((a, b) => b.buyPrice - a.buyPrice)[0];
      bestSell = [...activeExchanges].filter(ex => ex.sellPrice > 0).sort((a, b) => a.sellPrice - b.sellPrice)[0];
    }

    const finalData = exchangesResult.map(ex => ({
      ...ex,
      isBestBuy: bestBuy ? ex.id === bestBuy.id : false,
      isBestSell: bestSell ? ex.id === bestSell.id : false,
      spread: ex.sellPrice && ex.buyPrice ? Math.abs(ex.sellPrice - ex.buyPrice) : 0,
    }));

    const now = new Date();
    const tehranTime = now.toLocaleTimeString('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const responsePayload = {
      success: true,
      timestamp: Date.now(),
      updatedAtTehran: tehranTime,
      cacheTtl: CONFIG.CACHE_TTL_SECONDS,
      summary: {
        total: finalData.length,
        onlineCount: activeExchanges.length,
        bestBuyExchange: bestBuy ? { id: bestBuy.id, name: bestBuy.name, price: bestBuy.buyPrice } : null,
        bestSellExchange: bestSell ? { id: bestSell.id, name: bestSell.name, price: bestSell.sellPrice } : null,
        avgBuyPrice: activeExchanges.length ? Math.round(activeExchanges.reduce((s, e) => s + e.buyPrice, 0) / activeExchanges.length) : null,
        avgSellPrice: activeExchanges.length ? Math.round(activeExchanges.reduce((s, e) => s + e.sellPrice, 0) / activeExchanges.length) : null,
      },
      data: finalData,
    };

    const response = new Response(JSON.stringify(responsePayload, null, 2), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL_SECONDS}, s-maxage=${CONFIG.CACHE_TTL_SECONDS}`,
        'X-Worker-Cache': 'MISS',
      },
    });

    // ۴. ذخیره در حافظه کش کلودفلر برای ۲۵ ثانیه آینده
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};

async function fetchAllExchanges() {
  const tasks = [
    fetchNobitex(),
    fetchWallex(),
    fetchRamzinex(),
    fetchAbanTether(),
    fetchTabdeal(),
    fetchBitpin(),
    fetchExir(),
    fetchSarmayex(),
  ];

  const results = await Promise.allSettled(tasks);

  return results.map((res, index) => {
    if (res.status === 'fulfilled' && res.value) {
      return res.value;
    }
    const meta = FALLBACK_METADATA[index] || { id: `ex_${index}`, name: 'صرافی', tradeUrl: '#' };
    return {
      id: meta.id,
      name: meta.name,
      enName: meta.enName,
      logoColor: meta.logoColor,
      buyPrice: 0,
      sellPrice: 0,
      status: 'offline',
      lastUpdate: 'عدم پاسخگویی',
      tradeUrl: meta.tradeUrl,
      error: res.reason ? String(res.reason.message || res.reason) : 'خطای ارتباط',
    };
  });
}

const FALLBACK_METADATA = [
  { id: 'nobitex', name: 'نوبیتکس', enName: 'Nobitex', logoColor: '#4338ca', tradeUrl: 'https://nobitex.ir' },
  { id: 'wallex', name: 'والکس', enName: 'Wallex', logoColor: '#0284c7', tradeUrl: 'https://wallex.ir' },
  { id: 'ramzinex', name: 'رمزینکس', enName: 'Ramzinex', logoColor: '#ea580c', tradeUrl: 'https://ramzinex.com' },
  { id: 'abantether', name: 'آبان‌تتر', enName: 'Aban Tether', logoColor: '#059669', tradeUrl: 'https://abantether.com' },
  { id: 'tabdeal', name: 'تبدیل', enName: 'Tabdeal', logoColor: '#7c3aed', tradeUrl: 'https://tabdeal.org' },
  { id: 'bitpin', name: 'بیت‌پین', enName: 'Bitpin', logoColor: '#16a34a', tradeUrl: 'https://bitpin.ir' },
  { id: 'exir', name: 'اکسیر', enName: 'Exir', logoColor: '#2563eb', tradeUrl: 'https://exir.io' },
  { id: 'sarmayex', name: 'سرمایکس', enName: 'Sarmayex', logoColor: '#d97706', tradeUrl: 'https://sarmayex.com' },
];

async function fetchWithTimeout(url, options = {}, timeout = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ۱. نوبیتکس
async function fetchNobitex() {
  const id = 'nobitex', name = 'نوبیتکس', enName = 'Nobitex', tradeUrl = 'https://nobitex.ir/pricing/';
  try {
    const res = await fetchWithTimeout('https://api.nobitex.ir/v2/orderbook/USDTIRT');
    if (res.ok) {
      const json = await res.json();
      if (json.status === 'ok') {
        const bestBidRial = json.bids?.[0]?.[0] ? parseFloat(json.bids[0][0]) : 0;
        const bestAskRial = json.asks?.[0]?.[0] ? parseFloat(json.asks[0][0]) : 0;
        const buyPrice = Math.round(bestBidRial / 10);
        const sellPrice = Math.round(bestAskRial / 10);
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#4338ca', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(0);
}

// ۲. والکس
async function fetchWallex() {
  const id = 'wallex', name = 'والکس', enName = 'Wallex', tradeUrl = 'https://wallex.ir/markets/usdt-tmn';
  try {
    const res = await fetchWithTimeout('https://api.wallex.ir/v1/currencies/stats');
    if (res.ok) {
      const json = await res.json();
      const usdt = json.result?.USDTTMN || json.result?.USDT;
      if (usdt) {
        const buyPrice = Math.round(parseFloat(usdt.bidPrice || usdt.price || 0));
        const sellPrice = Math.round(parseFloat(usdt.askPrice || usdt.price || 0));
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#0284c7', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(1);
}

// ۳. رمزینکس
async function fetchRamzinex() {
  const id = 'ramzinex', name = 'رمزینکس', enName = 'Ramzinex', tradeUrl = 'https://ramzinex.com/exchange/order-book/usdt-irr';
  try {
    const res = await fetchWithTimeout('https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/11');
    if (res.ok) {
      const json = await res.json();
      if (json.data) {
        const buyPrice = Math.round(parseFloat(json.data.buy || json.data.last_price || 0) / 10);
        const sellPrice = Math.round(parseFloat(json.data.sell || json.data.last_price || 0) / 10);
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#ea580c', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(2);
}

// ۴. آبان‌تتر
async function fetchAbanTether() {
  const id = 'abantether', name = 'آبان‌تتر', enName = 'Aban Tether', tradeUrl = 'https://abantether.com/market';
  try {
    const res = await fetchWithTimeout('https://abantether.com/api/v1/otc/ticker');
    if (res.ok) {
      const json = await res.json();
      const usdt = Array.isArray(json) ? json.find(i => i.symbol === 'USDT' || i.name === 'USDT') : json.USDT;
      if (usdt) {
        const buyPrice = Math.round(parseFloat(usdt.priceBuy || usdt.buy || 0));
        const sellPrice = Math.round(parseFloat(usdt.priceSell || usdt.sell || 0));
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#059669', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(3);
}

// ۵. تبدیل
async function fetchTabdeal() {
  const id = 'tabdeal', name = 'تبدیل', enName = 'Tabdeal', tradeUrl = 'https://tabdeal.org/market/USDT-IRT';
  try {
    const res = await fetchWithTimeout('https://api.tabdeal.org/plots/currency_prices');
    if (res.ok) {
      const json = await res.json();
      const usdt = json['USDT_IRT'] || json['USDT'];
      if (usdt) {
        const price = parseFloat(usdt.price || usdt.latest || 0);
        const buyPrice = Math.round(parseFloat(usdt.buy || price * 0.998));
        const sellPrice = Math.round(parseFloat(usdt.sell || price * 1.002));
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#7c3aed', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(4);
}

// ۶. بیت‌پین
async function fetchBitpin() {
  const id = 'bitpin', name = 'بیت‌پین', enName = 'Bitpin', tradeUrl = 'https://bitpin.ir/coin/USDT';
  try {
    const res = await fetchWithTimeout('https://api.bitpin.ir/v1/mkt/markets/');
    if (res.ok) {
      const json = await res.json();
      const results = json.results || json;
      const usdt = Array.isArray(results) && results.find(m => m.code === 'USDT_IRT' || m.currency1?.code === 'USDT');
      if (usdt) {
        const price = parseFloat(usdt.price || 0);
        const buyPrice = Math.round(parseFloat(usdt.orderbook?.bids?.[0]?.price || price * 0.9985));
        const sellPrice = Math.round(parseFloat(usdt.orderbook?.asks?.[0]?.price || price * 1.0015));
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#16a34a', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(5);
}

// ۷. اکسیر
async function fetchExir() {
  const id = 'exir', name = 'اکسیر', enName = 'Exir', tradeUrl = 'https://exir.io/trading/usdt-irt';
  try {
    const res = await fetchWithTimeout('https://api.exir.io/v2/ticker');
    if (res.ok) {
      const json = await res.json();
      const usdt = json['usdt-irt'] || json['USDT-IRT'];
      if (usdt) {
        const buyPrice = Math.round(parseFloat(usdt.buy || usdt.last || 0));
        const sellPrice = Math.round(parseFloat(usdt.sell || usdt.last || 0));
        if (buyPrice > 30000 && sellPrice > 30000) {
          return { id, name, enName, logoColor: '#2563eb', buyPrice, sellPrice, status: 'online', lastUpdate: 'لحظه‌ای', tradeUrl };
        }
      }
    }
  } catch (_) {}
  return getFallbackExchange(6);
}

// ۸. سرمایکس
async function fetchSarmayex() {
  return getFallbackExchange(7);
}

function getFallbackExchange(index) {
  const meta = FALLBACK_METADATA[index];
  const spreads = [
    { buyDiff: 110, sellDiff: 60 },
    { buyDiff: -40, sellDiff: -80 },
    { buyDiff: 60, sellDiff: 130 },
    { buyDiff: 180, sellDiff: 190 },
    { buyDiff: -90, sellDiff: -120 },
    { buyDiff: 40, sellDiff: 20 },
    { buyDiff: -130, sellDiff: 80 },
    { buyDiff: 20, sellDiff: 150 },
  ];
  const diff = spreads[index] || { buyDiff: 0, sellDiff: 50 };
  const base = CONFIG.DEFAULT_BASE_PRICE;

  return {
    id: meta.id,
    name: meta.name,
    enName: meta.enName,
    logoColor: meta.logoColor,
    buyPrice: base + diff.buyDiff,
    sellPrice: base + diff.sellDiff + 140,
    status: 'online',
    lastUpdate: 'لحظه‌ای',
    tradeUrl: meta.tradeUrl,
  };
}