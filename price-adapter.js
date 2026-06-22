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

  function isFxPair(sym) { return !!FX_PAIRS[sym]; }
  function toOanda(sym) { return sym.replace('/', '_'); }      // EUR/USD -> EUR_USD
  function toTwelve(sym) { return sym; }                       // EUR/USD -> EUR/USD
  function pipFactor(sym) { return sym.indexOf('JPY') >= 0 ? 1000 : 100000; }

  function num(x) { var n = parseFloat(x); return isFinite(n) ? n : null; }

  // ---- simple sparkline cache (keep free-tier requests sane) ----
  var sparkCache = {}; // sym -> { ts, closes }
  var SPARK_TTL = 15 * 60 * 1000;

  // ========================= Twelve Data =========================
  var twelvedata = {
    label: 'Twelve Data',
    configured: function () { return !!(CFG.twelvedata && CFG.twelvedata.apiKey); },
    quotes: function (symbols) {
      var key = CFG.twelvedata.apiKey;
      var list = symbols.filter(isFxPair);
      if (!list.length) return Promise.resolve({});
      var url = 'https://api.twelvedata.com/quote?symbol=' +
        encodeURIComponent(list.map(toTwelve).join(',')) + '&apikey=' + encodeURIComponent(key);
      return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        var out = {};
        // API returns a single object for one symbol, or {SYM:{...}} for many.
        var rows = (list.length === 1) ? (function () { var o = {}; o[list[0]] = j; return o; })() : j;
        list.forEach(function (sym) {
          var q = rows[sym];
          if (!q || q.status === 'error' || q.code) return;
          var mid = num(q.close);
          if (mid == null) return;
          out[sym] = {
            mid: mid,
            bid: null, ask: null,
            changePct: num(q.percent_change),
            ts: new Date().toISOString()
          };
        });
        return out;
      });
    },
    sparkline: function (sym, points) {
      var key = CFG.twelvedata.apiKey;
      var url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(toTwelve(sym)) +
        '&interval=1h&outputsize=' + (points || 24) + '&apikey=' + encodeURIComponent(key);
      return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.values) return [];
        return j.values.map(function (v) { return num(v.close); })
          .filter(function (x) { return x != null; }).reverse();
      });
    }
  };

  // ===================== Proxy-backed (OANDA / FOREX.COM) =====================
  function proxyProvider(label, getUrl) {
    return {
      label: label,
      configured: function () { return !!getUrl(); },
      quotes: function (symbols) {
        var base = getUrl();
        var list = symbols.filter(isFxPair);
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
      if (!active.configured() || !isFxPair(sym)) return Promise.resolve([]);
      var c = sparkCache[sym];
      if (c && (Date.now() - c.ts) < SPARK_TTL) return Promise.resolve(c.closes);
      return active.sparkline(sym, points).then(function (closes) {
        if (closes && closes.length) sparkCache[sym] = { ts: Date.now(), closes: closes };
        return closes || [];
      }).catch(function () { return (c && c.closes) || []; });
    },

    formatPrice: function (sym, v) {
      if (v == null) return '—';
      return v.toFixed(sym.indexOf('JPY') >= 0 ? 3 : 5);
    }
  };
})();
