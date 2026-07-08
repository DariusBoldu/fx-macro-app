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
      // journal sync token — derived from the raw passcode, never committed
      try { localStorage.setItem('fx_jtoken', sha256('journal:' + val)); } catch (e) {}
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
    if (v === 'signals') refreshPrices();
    if (v === 'trades') { computeSize(); renderTrades(); }
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
    renderMeta(D); renderToday(D); renderStrength(D); renderMacro(D); renderSignals(D.symbols);
    renderCalendar(D); renderPricesUniverse(D);
    renderBookBanner(); renderTrades();
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

  var fullReadOpen = false;
  function syncFullRead(collapsible) {
    $('fullReadTitle').textContent = collapsible ? 'Full daily read' : 'What changed';
    $('fullReadChev').style.display = collapsible ? '' : 'none';
    $('fullReadChev').classList.toggle('open', fullReadOpen);
    $('dailyRead').style.display = (!collapsible || fullReadOpen) ? '' : 'none';
    $('fullReadHdr').style.cursor = collapsible ? 'pointer' : 'default';
  }
  $('fullReadHdr').addEventListener('click', function () {
    if ($('fullReadChev').style.display === 'none') return;   // not collapsible
    fullReadOpen = !fullReadOpen;
    syncFullRead(true);
  });

  function renderToday(D) {
    var m = D.meta || {};
    $('bigevent').innerHTML =
      '<div class="ic">📌</div><div><div class="k">Next big event</div>' +
      '<div class="v">' + esc(m.nextBigEvent || '—') + '</div></div>';
    $('dailyRead').textContent = D.dailyRead || '';
    $('geo').textContent = D.geopolitics || '';

    // per-currency reads, movers first (order comes from the task)
    var list = Array.isArray(D.today) ? D.today.filter(function (t) { return t && t.ccy; }) : [];
    var scores = {};
    (D.strength || []).forEach(function (c) { scores[c.ccy] = c.score; });
    if (list.length) {
      $('todayCcy').innerHTML = list.map(function (t) {
        var sc = scores[t.ccy];
        var scHtml = (sc != null)
          ? '<span class="tscore" style="color:' + (sc > 0 ? 'var(--long)' : sc < 0 ? 'var(--short)' : 'var(--range)') + '">' + (sc > 0 ? '+' : '') + sc + '</span>' : '';
        return '<div class="tccy' + (t.moved ? '' : ' quiet') + '">' +
          '<div class="thead"><span class="tccy-code">' + esc(t.ccy) + '</span>' + scHtml +
            '<span class="tmoved' + (t.moved ? '' : ' q') + '">' + (t.moved ? 'MOVED' : 'QUIET') + '</span></div>' +
          '<div class="thl">' + esc(t.headline || '') + '</div>' +
          (t.read ? '<div class="tread">' + esc(t.read) + '</div>' : '') +
          '</div>';
      }).join('');
      syncFullRead(true);
    } else {
      // fallback: no structured block in this report -> classic layout
      $('todayCcy').innerHTML = '';
      syncFullRead(false);
    }
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

  /* -------- Macro pillars: Inflation · Growth · Labour (Unemp+Jobs) · Rates ---- */
  function trendColor(t) { return t === 'rising' ? 'var(--long)' : t === 'falling' ? 'var(--short)' : 'var(--range)'; }

  function macroSpark(hist, trend) {
    var color = trendColor(trend);
    if (!hist || hist.length < 2) return '<svg class="mspark"></svg>';
    var min = Math.min.apply(null, hist), max = Math.max.apply(null, hist);
    var rng = (max - min) || 1, n = hist.length;
    var pts = hist.map(function (v, i) {
      var x = (i / (n - 1)) * 66 + 3;
      var y = 23 - ((v - min) / rng) * 20;
      return x.toFixed(1) + ' ' + y.toFixed(1);
    });
    var last = pts[pts.length - 1].split(' ');
    return '<svg class="mspark" viewBox="0 0 72 26">' +
      '<path d="M' + pts.join(' L') + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="1.8" fill="' + color + '"/></svg>';
  }

  function macroTrail(hist) {
    if (!hist || !hist.length) return '';
    var dec = 0;   // match the most precise reading so 4 shows as 4.0, 3.25 stays 3.25
    hist.forEach(function (v) { var d = (String(v).split('.')[1] || '').length; if (d > dec) dec = d; });
    dec = Math.min(dec, 2);
    return hist.map(function (v, i) {
      var s = v.toFixed(dec);
      return i === hist.length - 1 ? '<b>' + s + '</b>' : s;
    }).join(' · ');
  }

  function renderMacro(D) {
    var macro = D.macro || {};
    var order = (D.strength || []).map(function (c) { return c.ccy; });   // strongest → weakest
    var verdict = {}; (D.strength || []).forEach(function (c) { verdict[c.ccy] = c.verdict; });
    if (!order.length || !Object.keys(macro).length) {
      $('macro').innerHTML = '<div class="panel"><div class="legend" style="margin:0">Macro pillar data will appear here once the daily report includes it.</div></div>';
      return;
    }
    var metrics = [['inflation', 'Inflation'], ['growth', 'Growth'],
      ['unemployment', 'Unemployment'], ['jobs', 'Jobs'], ['rates', 'Interest rate']];
    var arrows = { rising: '▲', falling: '▼', stable: '▬' };
    $('macro').innerHTML = order.map(function (ccy) {
      var m = macro[ccy]; if (!m) return '';
      var rows = metrics.map(function (p) {
        var d = m[p[0]]; if (!d) return '';
        var trend = d.trend || 'stable';
        var label = trend.charAt(0).toUpperCase() + trend.slice(1);
        return '<div class="mrow">' +
          '<div class="mrhead"><span class="mrlabel">' + p[1] + '</span>' +
            '<span class="mtag ' + trend + '">' + (arrows[trend] || '▬') + ' ' + label + '</span></div>' +
          '<div class="mrbody"><div class="mrleft">' +
              '<span class="mrval">' + esc(d.value || '') + '</span>' +
              (d.note ? '<span class="mrnote">' + esc(d.note) + '</span>' : '') +
              '<div class="mrtrail">' + macroTrail(d.hist) + '</div>' +
            '</div>' + macroSpark(d.hist, trend) + '</div></div>';
      }).join('');
      return '<div class="mcard"><div class="mtop"><span class="mccy">' + esc(ccy) + '</span>' +
        '<span class="mverdict">' + esc(verdict[ccy] || '') + '</span></div>' + rows + '</div>';
    }).join('');
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
        var pxCell = window.PriceAdapter.isQuotable(s.sym)
          ? '<div class="px" data-px="' + esc(s.sym) + '"><span class="pxna">·</span></div>' : '';
        return '<div class="card ' + s.bias + '" data-sym="' + esc(s.sym) + '">' +
          '<div class="top"><div class="symwrap"><span class="sym">' + esc(s.sym) + '</span>' +
            '<span class="chip ' + s.bias + '">' + s.bias + '</span>' +
            '<span class="conv">' + esc(s.conv) + '</span></div>' + pxCell + '</div>' +
          '<div class="why">' + esc(s.why) + '</div>' +
          '<div class="rk"><b>Risk:</b> ' + esc(s.risk) + '</div></div>';
      }).join('');
    $('signals').innerHTML = html;
    document.querySelectorAll('#signals .card[data-sym]').forEach(function (c) {
      c.addEventListener('click', function () { openDetail(c.getAttribute('data-sym')); });
    });
    applyQuotesToSignals();
  }

  function renderCalendar(D) {
    $('cal').innerHTML = (D.catalysts || []).map(function (c) {
      return '<div class="cal"><div class="cdate">' + esc(c.date) + '</div>' +
        '<div><div class="cev"><span class="dot ' + esc(c.impact) + '"></span>' + esc(c.event) + '</div>' +
        '<div class="cnote">' + esc(c.note || '') + '</div></div></div>';
    }).join('');
  }

  /* ===================== Signals live quotes (per card) ===================== */
  var priceUniverse = [];   // 18 FX pairs, in Signals order — feeds the cards
  var lastQuotes = {};
  var priceTimer = null;

  function renderPricesUniverse(D) {
    priceUniverse = (D.symbols || []).map(function (s) { return s.sym; })
      .filter(function (s) { return window.PriceAdapter.isQuotable(s); });
  }

  function fmtChg(p) {
    if (p == null) return { cls: 'flat', txt: '·' };
    var cls = p > 0.001 ? 'up' : p < -0.001 ? 'down' : 'flat';
    var sign = p > 0 ? '+' : '';
    return { cls: cls, txt: sign + p.toFixed(2) + '%' };
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

  function refreshPrices() {
    if (!window.PriceAdapter.isConfigured() || !priceUniverse.length) return;
    window.PriceAdapter.quotes(priceUniverse).then(function (q) {
      lastQuotes = q || {};
      applyQuotesToSignals();
    });
    // (re)arm the poll only while Signals is open & the app is foregrounded
    clearTimeout(priceTimer);
    priceTimer = setTimeout(function () {
      if (!document.hidden && current === 'signals') refreshPrices();
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

  /* ============================ Size calculator ============================ */
  var CALC_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CAD', 'AUD/USD', 'NZD/USD',
    'EUR/JPY', 'EUR/AUD', 'EUR/NZD', 'GBP/JPY', 'GBP/AUD', 'GBP/NZD', 'AUD/JPY',
    'NZD/JPY', 'CAD/JPY', 'AUD/NZD', 'AUD/CAD', 'NZD/CAD'];
  // Non-FX CFDs: stop loss is entered as a price move (not pips).
  //  kind 'cash'   -> stop is a $/€ price move; contract = units per lot
  //  kind 'points' -> stop is in index points; contract = money per point per lot
  // `quote` is the instrument's quote currency (converted to the deposit ccy).
  var CALC_COMMODITIES = {
    'XAU/USD': { contract: 100,  label: '100 oz/lot',    quote: 'USD', kind: 'cash' },
    'XAG/USD': { contract: 5000, label: '5,000 oz/lot',  quote: 'USD', kind: 'cash' },
    'USOIL':   { contract: 1000, label: '1,000 bbl/lot', quote: 'USD', kind: 'cash' },
    // GER40 (DAX): quoted in EUR, stop in index points. FOREX.COM Germany 40 =
    // €1.00 per point per 1.0 lot (confirmed from their contract spec).
    'GER40':   { contract: 1,    label: '€1 / point / lot', quote: 'EUR', kind: 'points' }
  };
  var CALC_INSTRUMENTS = CALC_PAIRS.concat(Object.keys(CALC_COMMODITIES));
  var CALC_CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD'];
  var CCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', NZD: 'NZ$', CAD: 'C$' };
  var CALC_KEY = 'fx_calc_inputs';

  // rates: how many QUOTE units per 1 DEPOSIT unit (rates[dep]=1). Cached ~12h.
  // Primary: frankfurter.dev (ECB daily). Fallback: open.er-api.com. Both keyless + CORS.
  function getRates(dep) {
    var ck = 'fx_rates_' + dep, cached = null;
    try { cached = JSON.parse(localStorage.getItem(ck) || 'null'); } catch (e) {}
    if (cached && (Date.now() - cached.t) < 12 * 3600 * 1000) return Promise.resolve(cached);
    function store(rates, date) {
      rates[dep] = 1; var obj = { t: Date.now(), rates: rates, date: date };
      try { localStorage.setItem(ck, JSON.stringify(obj)); } catch (e) {}
      return obj;
    }
    return fetch('https://api.frankfurter.dev/v1/latest?base=' + dep)
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) { if (!j.rates) throw 0; return store(j.rates, j.date); })
      .catch(function () {
        return fetch('https://open.er-api.com/v6/latest/' + dep)
          .then(function (r) { return r.json(); })
          .then(function (j) { if (!j || !j.rates) throw 0; return store(j.rates, (j.time_last_update_utc || '').slice(0, 16)); })
          .catch(function () { return cached; });
      });
  }

  function fmtMoney(dep, v) {
    var sym = CCY_SYMBOL[dep] || (dep + ' ');
    var n = (dep === 'JPY')
      ? Math.round(v).toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym + n;
  }

  function saveCalcInputs() {
    try {
      localStorage.setItem(CALC_KEY, JSON.stringify({
        pair: $('cPair').value, dep: $('cDep').value, bal: $('cBal').value,
        risk: $('cRisk').value, mode: $('cRiskMode').value, sl: $('cSl').value
      }));
    } catch (e) {}
  }

  function setCalcRes(lots, units, risk) { $('rLots').textContent = lots; $('rUnits').textContent = units; $('rRisk').textContent = risk; }

  // accept both "100.5" and "100,5" (the phone keypad only offers a comma)
  function numVal(id) { return parseFloat(($(id).value || '').replace(',', '.').replace(/\s/g, '')); }

  function computeSize() {
    var pair = $('cPair').value, dep = $('cDep').value, mode = $('cRiskMode').value;
    var bal = numVal('cBal'), risk = numVal('cRisk'), sl = numVal('cSl');
    var commodity = CALC_COMMODITIES[pair];
    var isPoints = commodity && commodity.kind === 'points';
    // non-FX: SL is a price move so pipSize is 1 unit; FX keeps broker pips
    var pipSize = commodity ? 1 : (pair.indexOf('JPY') >= 0 ? 0.01 : 0.0001);
    $('cSlLabel').textContent = commodity ? (isPoints ? 'Stop loss (points)' : 'Stop loss ($ move)') : 'Stop loss (pips)';
    $('cPipLabel').textContent = commodity ? 'Contract size' : '1 pip size';
    $('cPip').textContent = commodity ? commodity.label : pipSize.toString();
    $('rUnitsLabel').textContent = isPoints ? (commodity.quote + '/point') : 'Units';
    $('cRate').textContent = '';
    saveCalcInputs();

    if (!(bal > 0) || !(risk > 0) || !(sl > 0)) {
      setCalcRes('—', '—', '—');
      $('cNote').className = 'calcnote'; $('cNote').textContent = commodity
        ? (isPoints ? 'Enter balance, risk and the stop distance in index points (e.g. 40 = a 40-point move).'
                    : 'Enter balance, risk and the stop distance as a $ price move (e.g. 5 = a $5 move).')
        : 'Enter balance, risk and stop loss to size the trade.';
      lastCalc = null; updateLogUi();
      return;
    }
    var riskAmount = mode === 'pct' ? bal * risk / 100 : risk;
    var quote = commodity ? commodity.quote : pair.split('/')[1];
    var contract = commodity ? commodity.contract : 100000;
    var pvQuote = pipSize * contract;   // value per lot of one SL unit, in quote ccy

    function finish(rateObj) {
      var pvDep;
      if (quote === dep) pvDep = pvQuote;
      else if (rateObj && rateObj.rates && rateObj.rates[quote]) {
        pvDep = pvQuote / rateObj.rates[quote];
        $('cRate').textContent = rateObj.date ? ('rates ' + rateObj.date) : 'rates';
      } else {
        setCalcRes('—', '—', '—');
        $('cNote').className = 'calcnote warn';
        $('cNote').textContent = 'Could not get the ' + quote + '→' + dep + ' rate — connect once and it caches for offline use.';
        lastCalc = null; updateLogUi();
        return;
      }
      var riskPerLot = sl * pvDep;
      var exactLots = riskAmount / riskPerLot;
      var lots = Math.round(exactLots * 100) / 100;            // broker step 0.01
      var belowMin = exactLots < 0.01;
      var useLots = belowMin ? exactLots : lots;               // show precise if sub-minimum
      var unitsRaw = useLots * contract;   // FX/cash: units; points: quote$/point
      var units = isPoints ? (Math.round(unitsRaw * 100) / 100) : Math.round(unitsRaw);
      var actualRisk = useLots * riskPerLot;
      setCalcRes(belowMin ? exactLots.toFixed(3) : lots.toFixed(2),
        units.toLocaleString('en-US'), fmtMoney(dep, actualRisk));
      var riskShown = mode === 'pct' ? (risk + '% = ' + fmtMoney(dep, riskAmount)) : fmtMoney(dep, riskAmount);
      $('cNote').className = 'calcnote' + (belowMin ? ' warn' : '');
      $('cNote').innerHTML = belowMin
        ? 'Risking <b>' + riskShown + '</b> needs ≈' + exactLots.toFixed(3) + ' lots — <b>below the 0.01 minimum</b>; raise risk or balance.'
        : 'Risking <b>' + riskShown + '</b> · ' + (commodity
            ? (isPoints ? '1 point = <b>' + fmtMoney(dep, pvDep) + '/lot</b> · ' + sl + '-pt stop'
                        : '$1 move = <b>' + fmtMoney(dep, pvDep) + '/lot</b> · $' + sl + ' stop')
            : 'pip value <b>' + fmtMoney(dep, pvDep) + '/lot</b> · ' + sl + '-pip stop');
      lastCalc = belowMin ? null : {
        sym: pair, dep: dep, lots: lots.toFixed(2),
        riskAmt: Math.round(actualRisk * 100) / 100,
        sl: sl + (commodity ? (isPoints ? ' pts' : ' $') : ' pips')
      };
      updateLogUi();
    }

    if (quote === dep) finish(null);
    else getRates(dep).then(finish);
  }

  function setupSizeCalc() {
    var pairSel = $('cPair');
    if (!pairSel || pairSel.options.length) return;   // once
    pairSel.innerHTML = CALC_INSTRUMENTS.map(function (p) { return '<option>' + p + '</option>'; }).join('');
    $('cDep').innerHTML = CALC_CCYS.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(CALC_KEY) || '{}') || {}; } catch (e) {}
    if (saved.pair && CALC_INSTRUMENTS.indexOf(saved.pair) >= 0) pairSel.value = saved.pair;
    $('cDep').value = (saved.dep && CALC_CCYS.indexOf(saved.dep) >= 0) ? saved.dep : 'USD';
    if (saved.bal) $('cBal').value = saved.bal;
    $('cRisk').value = (saved.risk != null && saved.risk !== '') ? saved.risk : 1;
    $('cRiskMode').value = saved.mode === 'amt' ? 'amt' : 'pct';
    if (saved.sl) $('cSl').value = saved.sl;
    ['cPair', 'cDep', 'cBal', 'cRisk', 'cRiskMode', 'cSl'].forEach(function (id) {
      $(id).addEventListener('input', computeSize);
      $(id).addEventListener('change', computeSize);
    });
    computeSize();
  }

  /* ============================ History summary ============================ */
  var HIST = null;
  function fetchHistory() {
    if (HIST) return Promise.resolve(HIST);
    return fetch('history/summary.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { HIST = j; try { localStorage.setItem('fx_hist', JSON.stringify(j)); } catch (e) {} return j; })
      .catch(function () {
        try { HIST = JSON.parse(localStorage.getItem('fx_hist') || 'null'); } catch (e) {}
        return HIST;
      });
  }

  /* ============================ Symbol detail view ============================ */
  var LEG_MAP = { 'DXY': ['USD'], 'JPYBASKET': ['JPY'], 'GER40': ['EUR'], 'XAU/USD': ['USD'], 'XAG/USD': ['USD'], 'USOIL': ['USD'] };
  var TV_MAP = { 'DXY': 'TVC:DXY', 'JPYBASKET': 'FXCM:JPYBASKET', 'GER40': 'GER40', 'XAU/USD': 'OANDA:XAUUSD', 'XAG/USD': 'OANDA:XAGUSD', 'USOIL': 'TVC:USOIL' };
  var CAT_KEYS = {
    USD: /US |USD|Fed|FOMC|ISM|NFP/i, EUR: /ECB|EZ |euro|Germany|HICP/i, GBP: /BoE|UK |GBP/i,
    JPY: /BoJ|Japan|JPY|MoF|ambush/i, AUD: /RBA|Aussie|Australia|AUD/i, NZD: /RBNZ|NZ |NZD/i,
    CAD: /BoC|Canada|CAD|oil|WTI|Brent/i
  };
  var COMMODITY_CAT = { 'XAU/USD': /gold|Fed|CPI|Hormuz|Iran/i, 'XAG/USD': /silver|gold|CPI/i, 'USOIL': /oil|WTI|Brent|Hormuz|Iran|OPEC|Saudi/i };

  function legsOf(sym) {
    if (LEG_MAP[sym]) return LEG_MAP[sym];
    return sym.indexOf('/') > 0 ? sym.split('/') : [sym];
  }
  function trendArrow(t) {
    return t === 'rising' ? '<span class="up">▲</span>' : t === 'falling' ? '<span class="down">▼</span>' : '<span class="flat">▬</span>';
  }

  function openDetail(sym) {
    var s = (DATA.symbols || []).find(function (x) { return x.sym === sym; });
    if (!s) return;
    var q = lastQuotes[sym];
    var px = q ? '<span class="dpx">' + window.PriceAdapter.formatPrice(sym, q.mid) +
      '<span class="pxchg ' + fmtChg(q.changePct).cls + '">' + fmtChg(q.changePct).txt + '</span></span>' : '';

    var html = '<div class="dhead"><span class="sym">' + esc(sym) + '</span>' +
      '<span class="chip ' + s.bias + '">' + s.bias + '</span>' +
      '<span class="conv">' + esc(s.conv) + '</span>' + px + '</div>' +
      '<div class="dsec"><h3>Today\'s read</h3><div class="why">' + esc(s.why) + '</div>' +
      '<div class="rk"><b>Risk:</b> ' + esc(s.risk) + '</div></div>' +
      '<div class="dsec"><h3>Bias history</h3><div id="dTimeline" class="skeleton">Loading…</div></div>';

    // both legs' macro pillars
    var legs = legsOf(sym).filter(function (c) { return DATA.macro && DATA.macro[c]; });
    if (legs.length) {
      html += '<div class="dsec"><h3>Macro pillars</h3><div class="legsgrid" style="grid-template-columns:repeat(' + legs.length + ',1fr)">' +
        legs.map(function (c) {
          var m = DATA.macro[c];
          var rows = [['inflation', 'Inflation'], ['growth', 'Growth'], ['unemployment', 'Unemp'], ['jobs', 'Jobs'], ['rates', 'Rate']]
            .map(function (p) {
              var d = m[p[0]]; if (!d) return '';
              return '<div class="lrow"><span>' + p[1] + '</span><span><b>' + esc(d.value) + '</b> ' + trendArrow(d.trend) + '</span></div>';
            }).join('');
          return '<div class="leg"><h4>' + c + '</h4>' + rows + '</div>';
        }).join('') + '</div></div>';
    }

    // related catalysts
    var pats = legsOf(sym).map(function (c) { return CAT_KEYS[c]; }).filter(Boolean);
    if (COMMODITY_CAT[sym]) pats = [COMMODITY_CAT[sym]];
    var cats = (DATA.catalysts || []).filter(function (c) {
      var txt = (c.event || '') + ' ' + (c.note || '');
      return pats.some(function (p) { return p.test(txt); });
    }).slice(0, 5);
    if (cats.length) {
      html += '<div class="dsec"><h3>Related catalysts</h3>' + cats.map(function (c) {
        return '<div class="dcat"><span class="dot ' + esc(c.impact) + '"></span><b>' + esc(c.date) + '</b> — ' +
          esc(c.event) + '<div class="cnote">' + esc(c.note || '') + '</div></div>';
      }).join('') + '</div>';
    }

    var tv = TV_MAP[sym] || sym.replace('/', '');
    html += '<a class="tvlink" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(tv) +
      '" target="_blank" rel="noopener">Open ' + esc(sym) + ' on TradingView ↗</a>';

    $('detailBody').innerHTML = html;
    $('detail').classList.add('show');
    document.body.style.overflow = 'hidden';

    fetchHistory().then(function (h) {
      var el = document.getElementById('dTimeline');
      if (!el) return;
      var tl = (h && h.symbols && h.symbols[sym]) || [];
      if (tl.length < 2) { el.innerHTML = '<div class="legend" style="margin:0">History builds up as daily reports accumulate.</div>'; return; }
      var last = tl.slice(-21);
      var cells = last.map(function (x) {
        return '<div class="tcell ' + x.bias + '" title="' + x.d + ' ' + x.bias + '"></div>';
      }).join('');
      // current streak
      var cur = tl[tl.length - 1].bias, streak = 0;
      for (var i = tl.length - 1; i >= 0 && tl[i].bias === cur; i--) streak++;
      el.className = '';
      el.innerHTML = '<div class="tl">' + cells + '</div>' +
        '<div class="tldates"><span>' + last[0].d.slice(5) + '</span><span>' + last[last.length - 1].d.slice(5) + '</span></div>' +
        '<div class="tlsummary"><b>' + cur + '</b> for ' + streak + ' report day' + (streak > 1 ? 's' : '') +
        ' · <span style="color:var(--long)">■</span> long <span style="color:var(--short)">■</span> short <span style="color:#3c4757">■</span> range</div>';
    });
  }
  $('detailClose').addEventListener('click', closeDetail);
  $('detail').addEventListener('click', function (e) { if (e.target === $('detail')) closeDetail(); });
  function closeDetail() { $('detail').classList.remove('show'); document.body.style.overflow = ''; }

  /* ============================ Trade journal ============================ */
  var JSTATE = { trades: [] };
  try { JSTATE = JSON.parse(localStorage.getItem('fx_jcache') || '{"trades":[]}'); } catch (e) {}
  var lastCalc = null;
  var logDir = null;

  function jToken() { return localStorage.getItem('fx_jtoken') || ''; }
  function jFetch(method, body) {
    var base = (CFG.workerUrl || '').replace(/\/$/, '');
    if (!base || !jToken()) return Promise.reject(new Error('no sync'));
    return fetch(base + '/journal', {
      method: method,
      headers: { 'x-fx-auth': jToken(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      JSTATE = j;
      try { localStorage.setItem('fx_jcache', JSON.stringify(j)); } catch (e) {}
      return j;
    });
  }
  function loadJournal() {
    return jFetch('GET').then(function () { renderTrades(); renderBookBanner(); })
      .catch(function () { renderTrades(); renderBookBanner(); });
  }

  function alignOf(bias, dir) {
    if (bias === 'LONG' && dir === 'LONG') return 'with';
    if (bias === 'SHORT' && dir === 'SHORT') return 'with';
    if (bias === 'LONG' || bias === 'SHORT') return 'against';
    return 'neutral';
  }
  function currentBias(sym) {
    var s = (DATA && DATA.symbols || []).find(function (x) { return x.sym === sym; });
    return s ? s.bias : null;
  }
  function flipState(t) {
    var b = currentBias(t.sym);
    if (!b) return null;
    if (b === 'RANGE') return { cls: 'warn', txt: 'Report now RANGE — edge faded' };
    if ((b === 'LONG') === (t.dir === 'LONG')) return { cls: 'ok', txt: 'Report aligned (' + b + ')' };
    return { cls: 'bad', txt: '⚠ Report flipped to ' + b + ' — against your ' + t.dir };
  }

  /* ---- log form ---- */
  function updateLogUi() {
    var btn = $('logBtn'); if (!btn) return;
    btn.style.display = lastCalc ? '' : 'none';
    if (!lastCalc) $('logForm').style.display = 'none';
  }
  function wireLogForm() {
    $('logBtn').addEventListener('click', function () {
      $('logForm').style.display = ''; $('logBtn').style.display = 'none';
      logDir = null;
      $('dirLong').classList.remove('sel'); $('dirShort').classList.remove('sel');
    });
    $('dirLong').addEventListener('click', function () { logDir = 'LONG'; $('dirLong').classList.add('sel'); $('dirShort').classList.remove('sel'); });
    $('dirShort').addEventListener('click', function () { logDir = 'SHORT'; $('dirShort').classList.add('sel'); $('dirLong').classList.remove('sel'); });
    $('logCancel').addEventListener('click', function () { $('logForm').style.display = 'none'; updateLogUi(); });
    $('logSave').addEventListener('click', function () {
      if (!lastCalc || !logDir) { $('logSave').textContent = logDir ? 'Save trade' : 'Pick a direction'; return; }
      var s = (DATA.symbols || []).find(function (x) { return x.sym === lastCalc.sym; });
      var trade = {
        ts: new Date().toISOString(), sym: lastCalc.sym, dir: logDir,
        lots: lastCalc.lots, riskAmt: lastCalc.riskAmt, riskCcy: lastCalc.dep, sl: lastCalc.sl,
        biasAtEntry: s ? s.bias : null, convAtEntry: s ? s.conv : null,
        align: alignOf(s ? s.bias : null, logDir), status: 'open',
        note: ($('logNote').value || '').slice(0, 140)
      };
      $('logSave').disabled = true; $('logSave').textContent = 'Saving…';
      jFetch('POST', { op: 'add', trade: trade }).then(function () {
        $('logForm').style.display = 'none'; $('logNote').value = '';
        $('logSave').disabled = false; $('logSave').textContent = 'Save trade';
        updateLogUi(); renderTrades(); renderBookBanner();
      }).catch(function () {
        $('logSave').disabled = false; $('logSave').textContent = 'Sync failed — retry';
      });
    });
    $('jauthBtn').addEventListener('click', function () {
      var v = $('jauthPin').value || '';
      if (sha256(v) === (CFG.passcodeSha256 || '')) {
        localStorage.setItem('fx_jtoken', sha256('journal:' + v));
        $('jauthPin').value = ''; $('jauthErr').textContent = '';
        loadJournal();
      } else { $('jauthErr').textContent = 'Wrong passcode.'; }
    });
  }

  /* ---- open book + exposure ---- */
  function renderBook(open) {
    $('bookPanel').style.display = open.length ? '' : 'none';
    if (!open.length) return;
    $('bookCount').textContent = open.length + ' open';

    // per-currency risk-weighted exposure; commodities count as their own leg
    var COMMODITY_LEG = { 'XAU/USD': 'XAU', 'XAG/USD': 'XAG', 'USOIL': 'OIL' };
    var exp = {}, touch = {};
    open.forEach(function (t) {
      var sign = t.dir === 'LONG' ? 1 : -1;
      var r = Number(t.riskAmt) || 0;
      if (COMMODITY_LEG[t.sym]) {
        var cc = COMMODITY_LEG[t.sym];
        exp[cc] = (exp[cc] || 0) + sign * r; (touch[cc] = touch[cc] || []).push(sign);
        return;
      }
      var b = t.sym.split('/')[0], qc = t.sym.split('/')[1];
      exp[b] = (exp[b] || 0) + sign * r; (touch[b] = touch[b] || []).push(sign);
      exp[qc] = (exp[qc] || 0) - sign * r; (touch[qc] = touch[qc] || []).push(-sign);
    });

    // warnings
    var warns = [];
    Object.keys(touch).forEach(function (c) {
      var arr = touch[c];
      if (arr.length >= 2 && arr.every(function (s) { return s === arr[0]; })) {
        var word = arr[0] > 0 ? 'long' : 'short';
        warns.push({ red: arr.length >= 3, txt: '<b>Concentrated:</b> net ' + word + ' ' + esc(c) + ' across ' + arr.length + ' trades — one ' + esc(c) + ' print hits all of them.' });
      }
    });
    if (open.some(function (t) { return t.sym.indexOf('JPY') >= 0; })) {
      warns.push({ red: false, txt: '<b>JPY book:</b> MoF intervention is the shared master variable — one strike moves every JPY position at once.' });
    }
    var flips = open.map(function (t) { return { t: t, f: flipState(t) }; }).filter(function (x) { return x.f && x.f.cls === 'bad'; });
    flips.forEach(function (x) {
      warns.push({ red: true, txt: '<b>' + esc(x.t.sym) + ':</b> ' + esc(x.f.txt) + '.' });
    });
    $('bookWarns').innerHTML = warns.map(function (w) {
      return '<div class="bwarn' + (w.red ? ' red' : '') + '">' + w.txt + '</div>';
    }).join('');

    // exposure bars
    var keys = Object.keys(exp).filter(function (c) { return Math.abs(exp[c]) > 0.004; })
      .sort(function (a, b) { return Math.abs(exp[b]) - Math.abs(exp[a]); });
    var max = Math.max.apply(null, keys.map(function (c) { return Math.abs(exp[c]); })) || 1;
    $('bookExposure').innerHTML = keys.map(function (c) {
      var v = exp[c], pct = Math.abs(v) / max * 50;
      var left = v >= 0 ? 50 : 50 - pct;
      return '<div class="exprow"><span class="eccy">' + esc(c) + '</span>' +
        '<div class="expbar"><div class="mid"></div><div class="fill" style="left:' + left + '%;width:' + pct + '%;background:' + (v >= 0 ? 'var(--long)' : 'var(--short)') + '"></div></div>' +
        '<span class="eval">' + (v >= 0 ? 'long' : 'short') + ' · risk ' + Math.abs(v).toFixed(0) + '</span></div>';
    }).join('');

    // open trade rows
    $('bookTrades').innerHTML = open.map(function (t) {
      var f = flipState(t);
      return '<div class="jrow" data-id="' + t.id + '">' +
        '<div class="jtop"><span class="jsym">' + esc(t.sym) + '</span>' +
          '<span class="jdir ' + t.dir + '">' + t.dir + '</span>' +
          '<span class="conv">' + esc(t.lots) + ' lots</span>' +
          '<span class="jr">risk ' + esc(String(t.riskAmt)) + ' ' + esc(t.riskCcy || '') + '</span></div>' +
        '<div class="jmeta">' + new Date(t.ts).toLocaleDateString() + ' · SL ' + esc(t.sl || '—') +
          ' · entered ' + (t.align === 'with' ? 'WITH' : t.align === 'against' ? 'AGAINST' : 'no') + ' bias (' + esc(t.biasAtEntry || '—') + ')' +
          (t.note ? ' · ' + esc(t.note) : '') + '</div>' +
        (f ? '<div class="jflip ' + f.cls + '">' + esc(f.txt) + '</div>' : '') +
        '<div class="jact"><button class="btn ghost jclose">Close…</button><button class="jdel">delete</button></div>' +
        '<div class="closeform" style="display:none"><input type="text" inputmode="text" placeholder="Result in R, e.g. +1,5 or -1">' +
          '<button class="btn jcsave">Save</button></div></div>';
    }).join('');

    document.querySelectorAll('#bookTrades .jrow').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('.jclose').addEventListener('click', function () {
        row.querySelector('.closeform').style.display = 'flex';
      });
      row.querySelector('.jcsave').addEventListener('click', function () {
        var raw = (row.querySelector('.closeform input').value || '').replace(',', '.').replace(/[Rr\s]/g, '');
        var r = parseFloat(raw);
        if (!isFinite(r)) { row.querySelector('.closeform input').placeholder = 'Enter a number, e.g. -1 or +2'; return; }
        jFetch('POST', { op: 'close', id: id, resultR: Math.round(r * 100) / 100 })
          .then(function () { renderTrades(); renderBookBanner(); });
      });
      row.querySelector('.jdel').addEventListener('click', function () {
        if (confirm('Delete this trade from the journal?')) {
          jFetch('POST', { op: 'delete', id: id }).then(function () { renderTrades(); renderBookBanner(); });
        }
      });
    });
  }

  /* ---- stats + closed history ---- */
  // Breakeven (0R) is NOT a loss: excluded from win rate AND avg R (it also
  // contributes 0 to total R). Win rate = wins / (wins + losses).
  function aggTrades(list) {
    var wins = 0, losses = 0, be = 0, tot = 0;
    list.forEach(function (t) {
      var r = Number(t.resultR) || 0; tot += r;
      if (r > 0) wins++; else if (r < 0) losses++; else be++;
    });
    var decisive = wins + losses;
    var avg = decisive ? tot / decisive : null;
    return {
      n: list.length, wins: wins, losses: losses, be: be,
      winTxt: decisive ? Math.round(wins / decisive * 100) + '%' : '—',
      avgTxt: avg == null ? '—' : (avg >= 0 ? '+' : '') + avg.toFixed(2) + 'R',
      totTxt: (tot >= 0 ? '+' : '') + tot.toFixed(1) + 'R',
      avgCls: avg == null ? '' : avg >= 0 ? 'pos' : 'neg',
      totCls: tot > 0 ? 'pos' : tot < 0 ? 'neg' : ''
    };
  }

  function renderStats(closed) {
    $('jpanel').style.display = closed.length ? '' : 'none';
    if (!closed.length) return;
    $('jCount').textContent = closed.length + ' closed';
    var a = aggTrades(closed);
    function box(v, k, cls) { return '<div class="jstat"><div class="v ' + (cls || '') + '">' + v + '</div><div class="k">' + k + '</div></div>'; }
    $('jstats').innerHTML =
      '<div class="jstatgrid">' +
        box(a.n, 'Total trades', '') +
        box(a.wins, 'Wins', a.wins ? 'pos' : '') +
        box(a.losses, 'Losses', a.losses ? 'neg' : '') +
        box(a.be, 'Breakeven', '') +
      '</div>' +
      '<div class="jstatgrid three">' +
        box(a.winTxt, 'Win rate', '') +
        box(a.avgTxt, 'Avg R', a.avgCls) +
        box(a.totTxt, 'Total R', a.totCls) +
      '</div>' +
      '<table class="aligntbl"><tr><th>vs report bias</th><th>n</th><th>win%</th><th>avg R</th><th>total R</th></tr>' +
      [['with', 'With bias'], ['against', 'Against bias'], ['neutral', 'No bias (range)']].map(function (g) {
        var x = aggTrades(closed.filter(function (t) { return t.align === g[0]; }));
        return '<tr><td>' + g[1] + '</td><td>' + x.n + '</td><td>' + x.winTxt + '</td>' +
          '<td class="' + x.avgCls + '">' + x.avgTxt + '</td><td class="' + x.totCls + '">' + x.totTxt + '</td></tr>';
      }).join('') + '</table>' +
      '<div class="legend" style="margin-top:8px">Win rate = wins ÷ (wins + losses). Breakeven (0R) trades are excluded from win rate and avg R.</div>';

    $('jhist').innerHTML = closed.slice(0, 40).map(function (t) {
      var r = Number(t.resultR) || 0;
      var rcls = r > 0 ? 'pos' : r < 0 ? 'neg' : '';
      var rtxt = r === 0 ? 'BE · 0R' : (r > 0 ? '+' : '') + r + 'R';
      var rval = r === 0 ? '0' : (r > 0 ? '+' : '') + r;
      return '<div class="jrow" data-id="' + t.id + '"><div class="jtop"><span class="jsym">' + esc(t.sym) + '</span>' +
        '<span class="jdir ' + t.dir + '">' + t.dir + '</span>' +
        '<span class="conv">' + (t.align === 'with' ? 'with bias' : t.align === 'against' ? 'against bias' : 'no bias') + '</span>' +
        '<span class="jr ' + rcls + '">' + rtxt + '</span></div>' +
        '<div class="jmeta">' + new Date(t.ts).toLocaleDateString() + ' → ' + (t.closedTs ? new Date(t.closedTs).toLocaleDateString() : '') +
        (t.note ? ' · ' + esc(t.note) : '') + '</div>' +
        '<div class="jact"><button class="btn ghost jedit">Edit result</button><button class="jdel">delete</button></div>' +
        '<div class="closeform jeditform" style="display:none"><input type="text" inputmode="text" placeholder="Result in R (0 = breakeven), e.g. +1,5 · 0 · -1" value="' + rval + '">' +
        '<button class="btn jesave">Save</button></div></div>';
    }).join('');

    document.querySelectorAll('#jhist .jrow').forEach(function (row) {
      var id = row.getAttribute('data-id');
      var t = closed.find(function (x) { return x.id === id; });
      row.querySelector('.jedit').addEventListener('click', function () {
        var f = row.querySelector('.jeditform'); f.style.display = f.style.display === 'flex' ? 'none' : 'flex';
      });
      row.querySelector('.jesave').addEventListener('click', function () {
        var raw = (row.querySelector('.jeditform input').value || '').replace(',', '.').replace(/[Rr\s]/g, '');
        var nr = parseFloat(raw);
        if (!isFinite(nr)) { row.querySelector('.jeditform input').placeholder = 'Enter a number: 0, -1, +2…'; return; }
        // reuse the close op to update the result; keep the original close date
        jFetch('POST', { op: 'close', id: id, resultR: Math.round(nr * 100) / 100, closedTs: t && t.closedTs })
          .then(function () { renderTrades(); renderBookBanner(); });
      });
      row.querySelector('.jdel').addEventListener('click', function () {
        if (confirm('Delete this closed trade from the journal?')) {
          jFetch('POST', { op: 'delete', id: id }).then(function () { renderTrades(); renderBookBanner(); });
        }
      });
    });
  }

  function renderTrades() {
    if (!$('bookPanel')) return;
    var hasToken = !!jToken();
    $('jauth').style.display = hasToken ? 'none' : '';
    var trades = (JSTATE && JSTATE.trades) || [];
    renderBook(trades.filter(function (t) { return t.status === 'open'; }));
    renderStats(trades.filter(function (t) { return t.status === 'closed' && t.resultR != null; }));
  }

  /* ---- Today-tab open-book banner ---- */
  function renderBookBanner() {
    var el = $('bookBanner'); if (!el) return;
    var open = ((JSTATE && JSTATE.trades) || []).filter(function (t) { return t.status === 'open'; });
    if (!open.length) { el.innerHTML = ''; return; }
    var flips = open.map(function (t) { return { t: t, f: flipState(t) }; });
    var bad = flips.filter(function (x) { return x.f && x.f.cls === 'bad'; });
    var warn = flips.filter(function (x) { return x.f && x.f.cls === 'warn'; });
    var line = '<b>Open book:</b> ' + open.map(function (t) { return t.dir === 'LONG' ? '▲' + t.sym : '▼' + t.sym; }).join(' · ');
    if (bad.length) line += '<br><span class="bb-bad">⚠ Report flipped against: ' + bad.map(function (x) { return x.t.sym; }).join(', ') + '</span>';
    else if (warn.length) line += '<br><span class="bb-warn">Edge faded to RANGE on: ' + warn.map(function (x) { return x.t.sym; }).join(', ') + '</span>';
    else line += '<br><span style="color:var(--long)">All open trades still aligned with today\'s report ✓</span>';
    el.innerHTML = '<div class="bookbanner">' + line + '</div>';
    el.querySelector('.bookbanner').addEventListener('click', function () { showView('trades'); });
  }

  /* ============================ Version badge ============================ */
  // Bump this together with CACHE in sw.js on every release. Shown in the header
  // so you can confirm the running version; tap it to force-fetch the latest.
  var APP_VERSION = 'v16';
  function initVersion() {
    var el = $('appver'); if (!el) return;
    el.textContent = APP_VERSION + ' ⟳';
    el.addEventListener('click', function () {
      el.textContent = 'updating…';
      (function () {
        var done = function () { location.reload(); };
        var jobs = [];
        if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
        if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.update(); })); }));
        Promise.all(jobs).then(done, done);
        setTimeout(done, 2500); // safety: reload even if the above stalls
      })();
    });
  }

  /* ============================ Boot ============================ */
  function boot() {
    initVersion();
    setupSizeCalc();
    wireLogForm();
    fetchData(false).then(function () {
      refreshPrices();          // warm signals quotes
      setupPush();
      loadJournal();            // shared journal -> book, stats, Today banner
      fetchHistory();           // warm the bias-history cache
    });
    // poll for a fresh report
    setInterval(function () { fetchData(true); }, (CFG.dataPollMs) || 300000);
    // also re-check when returning to the app
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { fetchData(true); if (current === 'signals') refreshPrices(); }
    });
  }

  /* ---- start ---- */
  if (isUnlocked()) { unlock(); } else { setTimeout(function () { $('pin').focus(); }, 300); }
})();
