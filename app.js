/* ============================================================================
 * FX Macro PWA — app logic.
 *   - passcode gate (hashed)        - 5 screens rendered from data.json
 *   - offline cache of last report  - live prices via the swappable adapter
 *   - fresh-report detection + toast - optional Web Push subscribe
 * ==========================================================================*/
(function () {
  'use strict';
  var CFG = window.FX_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ---------------- compact SHA-256 (works on file:// and https) ---------- */
  function sha256(ascii) {
    function rr(n, x) { return (x >>> n) | (x << (32 - n)); }
    var K = [], H = [], i, j, p = 2, primes = [], isP;
    function frac(x) { return ((x - (x | 0)) * 4294967296) | 0; }
    for (i = 2; primes.length < 64; i++) { isP = true; for (j = 2; j * j <= i; j++) if (i % j === 0) { isP = false; break; } if (isP) primes.push(i); }
    for (i = 0; i < 8; i++) H[i] = frac(Math.pow(primes[i], 0.5));
    for (i = 0; i < 64; i++) K[i] = frac(Math.pow(primes[i], 1 / 3));
    var words = [], asciiBitLength = ascii.length * 8, result = '', bytes = [];
    for (i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i));
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
    words[words.length] = (asciiBitLength / 4294967296) | 0;
    words[words.length] = asciiBitLength | 0;
    var a, b, c, d, e, f, g, h2, t1, t2, w = [];
    for (j = 0; j < words.length; j += 16) {
      a = H[0]; b = H[1]; c = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h2 = H[7];
      for (i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[j + i] | 0;
        else {
          var s0 = rr(7, w[i - 15]) ^ rr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
          var s1 = rr(17, w[i - 2]) ^ rr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        var S1 = rr(6, e) ^ rr(11, e) ^ rr(25, e);
        var ch = (e & f) ^ (~e & g);
        t1 = (h2 + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rr(2, a) ^ rr(13, a) ^ rr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (S0 + maj) | 0;
        h2 = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h2) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j >= 0; j--) { var bb = (H[i] >> (j * 8)) & 255; result += ((bb < 16) ? '0' : '') + bb.toString(16); }
    return result;
  }

  /* ============================ Passcode gate ============================ */
  var UNLOCK_KEY = 'fx_unlocked';
  function isUnlocked() {
    return CFG.rememberUnlock && localStorage.getItem(UNLOCK_KEY) === CFG.passcodeSha256;
  }
  function unlock() {
    $('gate').classList.add('hidden');
    $('app').classList.add('show');
    boot();
  }
  function tryPass() {
    var val = $('pin').value || '';
    if (!val) return;
    if (sha256(val) === (CFG.passcodeSha256 || '')) {
      if (CFG.rememberUnlock) localStorage.setItem(UNLOCK_KEY, CFG.passcodeSha256);
      $('gateErr').textContent = '';
      unlock();
    } else {
      $('gateErr').textContent = 'Wrong passcode.';
      $('pin').value = '';
      $('pin').focus();
    }
  }
  $('gobtn').addEventListener('click', tryPass);
  $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPass(); });

  /* ============================ Tab navigation ============================ */
  var current = 'today';
  function showView(v) {
    current = v;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.remove('active');
    $('v-' + v).classList.add('active');
    var tabs = document.querySelectorAll('.tabbtn');
    for (var k = 0; k < tabs.length; k++) tabs[k].classList.toggle('active', tabs[k].dataset.v === v);
    window.scrollTo(0, 0);
    if (v === 'prices') refreshPrices(true);
    if (v === 'signals') refreshPrices(false);
  }
  document.querySelectorAll('.tabbtn').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.v); });
  });

  /* ============================ Data loading ============================ */
  var DATA = null, lastSeenUpdatedAt = null;
  var CACHE_KEY = 'fx_data_cache';

  function loadCachedData() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }

  function fetchData(announce) {
    var url = (CFG.dataUrl || 'data.json') + '?t=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var fresh = DATA && d.updatedAt && d.updatedAt !== DATA.updatedAt;
      DATA = d;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
      renderAll(d);
      if (announce && fresh) showToast('New report published');
      return d;
    }).catch(function (e) {
      console.warn('[data] fetch failed, using cache:', e);
      if (!DATA) { var c = loadCachedData(); if (c) { DATA = c; renderAll(c); } else showLoadError(); }
    });
  }

  function showLoadError() {
    $('regime').innerHTML = '<b>Could not load data.</b> Check your connection — the last report will show once cached.';
  }

  /* ============================ Renderers ============================ */
  function renderAll(D) {
    renderMeta(D); renderToday(D); renderStrength(D); renderSignals(D.symbols);
    renderCalendar(D); renderPricesUniverse(D);
  }

  function relTime(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime(); if (isNaN(t)) return '—';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function renderMeta(D) {
    var m = D.meta || {};
    $('reportLabel').textContent = (m.reportLabel || '') + (m.horizon ? '  ·  ' + m.horizon : '');
    var stale = D.updatedAt && (Date.now() - new Date(D.updatedAt).getTime()) > 36 * 3600 * 1000;
    $('updated').classList.toggle('stale', !!stale);
    $('updatedTxt').textContent = 'Updated ' + relTime(D.updatedAt);
    $('regime').innerHTML = '<b>Regime:</b> ' + esc(m.regime || '');
  }

  function renderToday(D) {
    var m = D.meta || {};
    $('bigevent').innerHTML =
      '<div class="ic">📌</div><div><div class="k">Next big event</div>' +
      '<div class="v">' + esc(m.nextBigEvent || '—') + '</div></div>';
    $('dailyRead').textContent = D.dailyRead || '';
    $('geo').textContent = D.geopolitics || '';
  }

  function barColor(s) { return s > 0 ? 'var(--up)' : s < 0 ? 'var(--down)' : 'var(--neutral)'; }
  function renderStrength(D) {
    var html = (D.strength || []).map(function (c) {
      var pct = Math.abs(c.score) / 3 * 50;
      var left = c.score >= 0 ? 50 : 50 - pct;
      var signed = (c.score > 0 ? '+' : '') + c.score;
      return '<div class="srow">' +
        '<div><div class="ccy">' + esc(c.ccy) + '</div><div class="sc">' + signed + '</div></div>' +
        '<div>' +
          '<div class="verdict">' + esc(c.verdict || '') +
            (c.tag ? ' <span class="tag">' + esc(c.tag) + '</span>' : '') + '</div>' +
          '<div class="bar"><div class="mid"></div><div class="fill" style="left:' + left + '%;width:' + pct + '%;background:' + barColor(c.score) + '"></div></div>' +
          '<div class="fwd">' + esc(c.forward || '') + '</div>' +
          '<div class="drivers">' + esc(c.drivers || '') + '</div>' +
        '</div></div>';
    }).join('');
    $('strength').innerHTML = html;
  }

  var signalFilter = 'ALL';
  function renderFilters(symbols) {
    var counts = { ALL: symbols.length, LONG: 0, SHORT: 0, RANGE: 0 };
    symbols.forEach(function (s) { if (counts[s.bias] != null) counts[s.bias]++; });
    var order = ['ALL', 'LONG', 'SHORT', 'RANGE'];
    $('filters').innerHTML = order.map(function (f) {
      return '<div class="fbtn' + (f === signalFilter ? ' active' : '') + '" data-f="' + f + '">' +
        f + '<span class="n">' + counts[f] + '</span></div>';
    }).join('');
    document.querySelectorAll('#filters .fbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        signalFilter = b.dataset.f;
        document.querySelectorAll('#filters .fbtn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        renderSignalCards(DATA.symbols);
      });
    });
  }
  function renderSignals(symbols) { renderFilters(symbols); renderSignalCards(symbols); }
  function renderSignalCards(symbols) {
    var html = symbols.filter(function (s) { return signalFilter === 'ALL' || s.bias === signalFilter; })
      .map(function (s) {
        var pxCell = window.PriceAdapter.isFxPair(s.sym)
          ? '<div class="px" data-px="' + esc(s.sym) + '"><span class="pxna">·</span></div>' : '';
        return '<div class="card ' + s.bias + '">' +
          '<div class="top"><div class="symwrap"><span class="sym">' + esc(s.sym) + '</span>' +
            '<span class="chip ' + s.bias + '">' + s.bias + '</span>' +
            '<span class="conv">' + esc(s.conv) + '</span></div>' + pxCell + '</div>' +
          '<div class="why">' + esc(s.why) + '</div>' +
          '<div class="rk"><b>Risk:</b> ' + esc(s.risk) + '</div></div>';
      }).join('');
    $('signals').innerHTML = html;
    applyQuotesToSignals();
  }

  function renderCalendar(D) {
    $('cal').innerHTML = (D.catalysts || []).map(function (c) {
      return '<div class="cal"><div class="cdate">' + esc(c.date) + '</div>' +
        '<div><div class="cev"><span class="dot ' + esc(c.impact) + '"></span>' + esc(c.event) + '</div>' +
        '<div class="cnote">' + esc(c.note || '') + '</div></div></div>';
    }).join('');
  }

  /* ============================ Prices ============================ */
  var priceUniverse = [];   // display symbols, FX pairs only, in Signals order
  var lastQuotes = {};
  var priceTimer = null;

  function renderPricesUniverse(D) {
    priceUniverse = (D.symbols || []).map(function (s) { return s.sym; })
      .filter(function (s) { return window.PriceAdapter.isFxPair(s); });
    $('priceProvider').textContent = window.PriceAdapter.isConfigured()
      ? window.PriceAdapter.providerLabel() : '';
    if (!window.PriceAdapter.isConfigured()) {
      $('prices').innerHTML =
        '<div class="notice"><b>Live prices are not configured yet.</b><br>' +
        'Pick a provider in <code>config.js</code> → <code>price.provider</code> and add the key, ' +
        'then reload. Default is OANDA practice (via the bundled proxy) with Twelve Data as a ' +
        'no-proxy fallback. Everything else in the app works without it.</div>';
      return;
    }
    // initial skeleton rows
    $('prices').innerHTML = priceUniverse.map(function (sym) {
      return '<div class="prow" data-row="' + esc(sym) + '">' +
        '<div class="psym">' + esc(sym) + '</div>' +
        '<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"></svg>' +
        '<div class="pvals"><div class="pmid">—</div><div class="pchg flat">·</div><div class="pba"></div></div></div>';
    }).join('');
  }

  function fmtChg(p) {
    if (p == null) return { cls: 'flat', txt: '·' };
    var cls = p > 0.001 ? 'up' : p < -0.001 ? 'down' : 'flat';
    var sign = p > 0 ? '+' : '';
    return { cls: cls, txt: sign + p.toFixed(2) + '%' };
  }

  function sparkPath(closes) {
    if (!closes || closes.length < 2) return { d: '', up: true };
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    var rng = (max - min) || 1, n = closes.length;
    var d = closes.map(function (v, i) {
      var x = (i / (n - 1)) * 100;
      var y = 32 - ((v - min) / rng) * 30;
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    return { d: d, up: closes[closes.length - 1] >= closes[0] };
  }

  function applyQuotesToSignals() {
    document.querySelectorAll('[data-px]').forEach(function (el) {
      var q = lastQuotes[el.getAttribute('data-px')];
      if (!q) { el.innerHTML = '<span class="pxna">·</span>'; return; }
      var c = fmtChg(q.changePct);
      el.innerHTML = '<span class="pxmid">' + window.PriceAdapter.formatPrice(el.getAttribute('data-px'), q.mid) + '</span>' +
        '<span class="pxchg ' + c.cls + '">' + c.txt + '</span>';
    });
  }

  function applyQuotesToPrices() {
    priceUniverse.forEach(function (sym) {
      var row = document.querySelector('.prow[data-row="' + cssEsc(sym) + '"]');
      if (!row) return;
      var q = lastQuotes[sym];
      var mid = row.querySelector('.pmid'), chg = row.querySelector('.pchg'), ba = row.querySelector('.pba');
      if (!q) return;
      mid.textContent = window.PriceAdapter.formatPrice(sym, q.mid);
      var c = fmtChg(q.changePct);
      chg.className = 'pchg ' + c.cls; chg.textContent = c.txt;
      ba.textContent = (q.bid != null && q.ask != null)
        ? window.PriceAdapter.formatPrice(sym, q.bid) + ' / ' + window.PriceAdapter.formatPrice(sym, q.ask) : '';
    });
  }
  function cssEsc(s) { return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  function loadSparklines() {
    if (!window.PriceAdapter.isConfigured()) return;
    priceUniverse.forEach(function (sym) {
      window.PriceAdapter.sparkline(sym, 24).then(function (closes) {
        var row = document.querySelector('.prow[data-row="' + cssEsc(sym) + '"]');
        if (!row) return;
        var svg = row.querySelector('.spark'); if (!svg) return;
        var p = sparkPath(closes);
        if (!p.d) return;
        svg.innerHTML = '<path d="' + p.d + '" fill="none" stroke="' +
          (p.up ? 'var(--up)' : 'var(--down)') + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
      });
    });
  }

  function refreshPrices(includeSparklines) {
    if (!window.PriceAdapter.isConfigured() || !priceUniverse.length) return;
    window.PriceAdapter.quotes(priceUniverse).then(function (q) {
      lastQuotes = q || {};
      applyQuotesToPrices();
      applyQuotesToSignals();
    });
    if (includeSparklines) loadSparklines();
    // (re)arm the poll while a price-bearing screen is open
    clearTimeout(priceTimer);
    priceTimer = setTimeout(function () {
      if (current === 'prices' || current === 'signals') refreshPrices(false);
    }, (CFG.price && CFG.price.refreshMs) || 60000);
  }

  /* ============================ Fresh-report toast ============================ */
  function showToast(msg) {
    $('toastTxt').textContent = msg;
    $('toast').classList.add('show');
  }
  $('toastBtn').addEventListener('click', function () {
    $('toast').classList.remove('show');
    fetchData(false);
  });

  /* ============================ Web Push (optional) ============================ */
  function urlB64ToUint8(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function setupPush() {
    var p = CFG.push || {};
    if (!p.enabled || !p.subscribeUrl || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // surface a button on Today
    var bar = document.createElement('div');
    bar.className = 'panel';
    bar.innerHTML = '<h2>Alerts</h2><button class="btn" id="pushBtn">Enable push alerts</button>' +
      '<div class="legend" style="margin-top:8px">Get a notification when a new report publishes or a high-impact event fires.</div>';
    $('v-today').insertBefore(bar, $('v-today').firstChild.nextSibling);
    $('pushBtn').addEventListener('click', function () {
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') return;
        navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8(p.vapidPublicKey)
          });
        }).then(function (sub) {
          return fetch(p.subscribeUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub)
          });
        }).then(function () { $('pushBtn').textContent = 'Alerts enabled ✓'; $('pushBtn').disabled = true; })
          .catch(function (e) { console.warn('push subscribe failed', e); });
      });
    });
  }

  /* ============================ Boot ============================ */
  function boot() {
    fetchData(false).then(function () {
      refreshPrices(false);     // warm signals quotes
      setupPush();
    });
    // poll for a fresh report
    setInterval(function () { fetchData(true); }, (CFG.dataPollMs) || 300000);
    // also re-check when returning to the app
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { fetchData(true); if (current === 'prices' || current === 'signals') refreshPrices(current === 'prices'); }
    });
  }

  /* ---- start ---- */
  if (isUnlocked()) { unlock(); } else { setTimeout(function () { $('pin').focus(); }, 300); }
})();
