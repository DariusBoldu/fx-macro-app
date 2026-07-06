/* ============================================================================
 * price-adapter.js — swappable live-price layer.
 *
 * One normalized interface, three back ends:
 *   • twelvedata : direct browser fetch (CORS-OK; free-tier key in config).
 *   • oanda      : via the tiny ./proxy (holds the practice token server-side).
 *   • forexcom   : same proxy contract — drop-in when Darius has GAIN creds.
 *
 * Normalized quote shape returned to the app:
 *   { mid:Number, bid:Number|null, ask:Number|null, changePct:Number|null, ts:ISO }
 *
 * Proxy contract (oanda/forexcom), so the broker can change without touching
 * the app:
 *   GET {proxyUrl}/quotes?symbols=EUR/USD,GBP/USD
 *       -> { "EUR/USD": {mid,bid,ask,changePct,ts}, ... }
 *   GET {proxyUrl}/sparkline?symbol=EUR/USD&points=24
 *       -> { "closes": [Number, ...] }   // oldest -> newest
 * ==========================================================================*/
(function () {
  'use strict';

  var CFG = (window.FX_CONFIG && window.FX_CONFIG.price) || { provider: 'none' };

  // The 18 tradable FX pairs (display form). Indices/synthetic (DXY, GER40,
  // JPYBASKET) are intentionally excluded — they are not FX quotes.
  var FX_PAIRS = {
    'EUR/USD': 1, 'GBP/USD': 1, 'USD/JPY': 1, 'USD/CAD': 1, 'AUD/USD': 1,
    'NZD/USD': 1, 'EUR/JPY': 1, 'EUR/AUD': 1, 'EUR/NZD': 1, 'GBP/JPY': 1,
    'GBP/AUD': 1, 'GBP/NZD': 1, 'AUD/JPY': 1, 'NZD/JPY': 1, 'CAD/JPY': 1,
    'AUD/NZD': 1, 'AUD/CAD': 1, 'NZD/CAD': 1
  };

  // Commodities with a live quote. XAU/USD works on the Twelve Data FREE tier;
  // XAG/USD and WTI/USD are plan-gated — flip them to 1 if the key is upgraded
  // (Grow plan) and silver/oil quotes light up with no other change.
  // (USOIL maps to Twelve Data's "WTI/USD".)
  // GER40 (DAX index) is EUR-quoted; Twelve Data's free tier does NOT serve the
  // real index ("DAX" resolves to a wrong US ticker), so it stays 0 until a
  // paid plan + the correct index symbol are set in TD_SYMBOL_MAP below.
  var QUOTABLE_COMMODITIES = { 'XAU/USD': 1, 'XAG/USD': 0, 'USOIL': 0, 'GER40': 0 };
  var TD_SYMBOL_MAP = { 'USOIL': 'WTI/USD' };

  function isFxPair(sym) { return !!FX_PAIRS[sym]; }
  function isQuotable(sym) { return !!FX_PAIRS[sym] || QUOTABLE_COMMODITIES[sym] === 1; }
  function toOanda(sym) { return sym.replace('/', '_'); }      // EUR/USD -> EUR_USD
  function toTwelve(sym) { return TD_SYMBOL_MAP[sym] || sym; } // USOIL -> WTI/USD
  function pipFactor(sym) { return sym.indexOf('JPY') >= 0 ? 1000 : 100000; }

  function num(x) { var n = parseFloat(x); return isFinite(n) ? n : null; }

  // ---- simple sparkline cache (keep free-tier requests sane) ----
  var sparkCache = {}; // sym -> { ts, closes }
  var SPARK_TTL = 15 * 60 * 1000;

  // ========================= Twelve Data =========================
  // Free "Basic" tier = 8 credits/min, 800/day; a multi-symbol quote costs one
  // credit per symbol. So we never request more than TD_BATCH symbols at once,
  // throttle to ~one batch per minute, and rotate through the universe — cached
  // quotes fill the gaps so every pair stays reasonably fresh (~3-4 min cycle).
  var tdCache = {};          // sym -> { mid, changePct, t(ms), iso }
  var tdLastFetch = 0;
  var TD_BATCH = 8;          // == per-minute credit cap
  var TD_THROTTLE = 65000;   // >= 1 min between batches
  var TD_TTL = 300000;       // refetch a symbol once older than 5 min (saves daily credits)

  var twelvedata = {
    label: 'Twelve Data',
    configured: function () { return !!(CFG.twelvedata && CFG.twelvedata.apiKey); },
    quotes: function (symbols) {
      var key = CFG.twelvedata.apiKey;
      var list = symbols.filter(isQuotable);
      var now = Date.now();
      function result() {
        var out = {};
        list.forEach(function (s) {
          var c = tdCache[s];
          if (c) out[s] = { mid: c.mid, bid: null, ask: null, changePct: c.changePct, ts: c.iso };
        });
        return out;
      }
      if (now - tdLastFetch < TD_THROTTLE) return Promise.resolve(result());
      // oldest-first so the rotation always refreshes the most stale pairs
      var stale = list.filter(function (s) { var c = tdCache[s]; return !c || (now - c.t) > TD_TTL; })
        .sort(function (a, b) { return (tdCache[a] ? tdCache[a].t : 0) - (tdCache[b] ? tdCache[b].t : 0); });
      if (!stale.length) return Promise.resolve(result());
      var toFetch = stale.slice(0, TD_BATCH);
      tdLastFetch = now;
      var url = 'https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(toFetch.map(toTwelve).join(',')) +
        '&apikey=' + encodeURIComponent(key);
      return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        if (j && (j.code || j.status === 'error')) return result();   // rate-limited/etc: keep cache
        var rows = (toFetch.length === 1) ? (function () { var o = {}; o[toTwelve(toFetch[0])] = j; return o; })() : j;
        var t = Date.now();
        toFetch.forEach(function (s) {
          var q = rows[toTwelve(s)]; if (!q || q.code || q.status === 'error') return;
          var mid = num(q.close); if (mid == null) return;
          tdCache[s] = { mid: mid, changePct: num(q.percent_change), t: t, iso: new Date().toISOString() };
        });
        return result();
      }).catch(function () { return result(); });
    },
    // Sparklines disabled on the free tier — each is an extra credit, and the
    // 8/min budget is reserved for live quotes (price + day% still show).
    sparkline: function () { return Promise.resolve([]); }
  };

  // ===================== Proxy-backed (OANDA / FOREX.COM) =====================
  function proxyProvider(label, getUrl) {
    return {
      label: label,
      configured: function () { return !!getUrl(); },
      quotes: function (symbols) {
        var base = getUrl();
        var list = symbols.filter(isQuotable);
        if (!list.length) return Promise.resolve({});
        var url = base.replace(/\/$/, '') + '/quotes?symbols=' + encodeURIComponent(list.join(','));
        return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
          var out = {};
          list.forEach(function (sym) {
            var q = j[sym]; if (!q) return;
            out[sym] = {
              mid: num(q.mid != null ? q.mid : (q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null)),
              bid: num(q.bid), ask: num(q.ask),
              changePct: num(q.changePct),
              ts: q.ts || new Date().toISOString()
            };
          });
          return out;
        });
      },
      sparkline: function (sym, points) {
        var base = getUrl();
        var url = base.replace(/\/$/, '') + '/sparkline?symbol=' + encodeURIComponent(sym) + '&points=' + (points || 24);
        return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
          return (j && j.closes ? j.closes : []).map(num).filter(function (x) { return x != null; });
        });
      }
    };
  }

  var oanda = proxyProvider('OANDA (practice)', function () { return CFG.oanda && CFG.oanda.proxyUrl; });
  var forexcom = proxyProvider('FOREX.COM', function () { return CFG.forexcom && CFG.forexcom.proxyUrl; });

  var noop = {
    label: 'none', configured: function () { return false; },
    quotes: function () { return Promise.resolve({}); },
    sparkline: function () { return Promise.resolve([]); }
  };

  var PROVIDERS = { twelvedata: twelvedata, oanda: oanda, forexcom: forexcom, none: noop };
  var active = PROVIDERS[CFG.provider] || noop;

  // ============================ Public API ============================
  window.PriceAdapter = {
    isFxPair: isFxPair,
    isQuotable: isQuotable,
    pipFactor: pipFactor,
    providerKey: CFG.provider,
    providerLabel: function () { return active.label; },
    isConfigured: function () { return active.configured(); },

    /* Batch quotes. Resolves to a map keyed by display symbol; never rejects —
     * on error returns {} so the UI degrades gracefully. */
    quotes: function (symbols) {
      if (!active.configured()) return Promise.resolve({});
      try {
        return active.quotes(symbols).catch(function (e) {
          console.warn('[price] quotes failed:', e); return {};
        });
      } catch (e) { return Promise.resolve({}); }
    },

    /* Best-effort sparkline with a 15-min cache to respect free-tier limits. */
    sparkline: function (sym, points) {
      if (!active.configured() || !isQuotable(sym)) return Promise.resolve([]);
      var c = sparkCache[sym];
      if (c && (Date.now() - c.ts) < SPARK_TTL) return Promise.resolve(c.closes);
      return active.sparkline(sym, points).then(function (closes) {
        if (closes && closes.length) sparkCache[sym] = { ts: Date.now(), closes: closes };
        return closes || [];
      }).catch(function () { return (c && c.closes) || []; });
    },

    formatPrice: function (sym, v) {
      if (v == null) return '—';
      if (sym === 'XAU/USD' || sym === 'USOIL') return v.toFixed(2);
      if (sym === 'XAG/USD') return v.toFixed(3);
      if (sym === 'GER40') return v.toFixed(1);
      return v.toFixed(sym.indexOf('JPY') >= 0 ? 3 : 5);
    }
  };
})();
