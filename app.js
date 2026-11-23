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
  /* Every clock time the app shows is Bucharest time (Darius, 2026-11-10).
   * Reports and feeds are UTC — the analyst writes "13:30Z" / "13:30 GMT" — so
   * all rendered text is converted here, in the one function every text field
   * passes through. The report's own date decides summer vs winter time, and a
   * time that falls on the next Bucharest day is marked. Machine fields (`when`)
   * stay UTC. */
  var BUC_TZ = 'Europe/Bucharest';
  var bucRef = Date.now();          // set to the report date in renderAll()
  var bucClock = new Intl.DateTimeFormat('en-GB', { timeZone: BUC_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var bucIsoDay = new Intl.DateTimeFormat('en-CA', { timeZone: BUC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var bucDay = new Intl.DateTimeFormat('en-GB', { timeZone: BUC_TZ, weekday: 'short', day: 'numeric', month: 'short' });
  function bucText(s) {
    return s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s?(?:Z|UTC|GMT)\b/g, function (m, h, mi) {
      var r = new Date(bucRef);
      var t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), +h, +mi);
      var nextDay = bucIsoDay.format(t) !== new Date(t).toISOString().slice(0, 10);
      return bucClock.format(t) + (nextDay ? ' (next day)' : '');
    });
  }
  var esc = function (s) {
    return bucText(String(s == null ? '' : s)).replace(/[&<>"]/g, function (c) {
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
    if (v === 'trades') { computeSize(); renderTrades(); }
    if (IDX[v]) { loadIdxTrack(v); if (DATA) renderIdx(v, DATA); }
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
    var rd = Date.parse(((D.meta && D.meta.reportDate) || '') + 'T12:00:00Z');
    bucRef = isNaN(rd) ? Date.now() : rd;
    renderMeta(D); renderToday(D); renderMacro(D); renderSignals(D.symbols);
    renderRates(D); renderCalendar(D); renderIdx('us30', D);
    renderBookBanner(); renderTrades();
  }

  /* ============================ Theme (light/dark) ============================ */
  function applyTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    var btn = $('thToggle'); if (btn) btn.textContent = t === 'dark' ? '☀' : '☾';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0f17' : '#f2f5fa');
  }
  var THEME = localStorage.getItem('fx_theme') || 'light';
  applyTheme(THEME);
  $('thToggle').addEventListener('click', function () {
    THEME = THEME === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fx_theme', THEME);
    applyTheme(THEME);
  });

  function relTime(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime(); if (isNaN(t)) return '—';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  /* The headline is clamped to two lines in the sticky appbar and expands on tap.
   * Without this a long report (2,805 characters on 2026-09-23) covered the whole
   * phone screen on every tab. The choice is remembered per device. */
  var labelOpen = false;
  try { labelOpen = localStorage.getItem('fx_label_open') === '1'; } catch (e) {}
  function syncLabelClamp() {
    var lab = $('reportLabel'), more = $('labelMore');
    if (!lab || !more) return;
    lab.classList.toggle('open', labelOpen);
    // Offer the toggle only when the text is actually longer than the clamp.
    more.hidden = !(labelOpen || lab.scrollHeight > lab.clientHeight + 2);
    more.textContent = labelOpen ? 'less ⌃' : 'more ⌄';
    more.setAttribute('aria-expanded', labelOpen ? 'true' : 'false');
  }
  function toggleLabel() {
    labelOpen = !labelOpen;
    try { localStorage.setItem('fx_label_open', labelOpen ? '1' : '0'); } catch (e) {}
    syncLabelClamp();
  }
  $('reportLabel').addEventListener('click', toggleLabel);
  $('labelMore').addEventListener('click', toggleLabel);
  window.addEventListener('resize', syncLabelClamp);

  function renderMeta(D) {
    var m = D.meta || {};
    $('reportLabel').textContent = (m.reportLabel || '') + (m.horizon ? '  ·  ' + m.horizon : '');
    syncLabelClamp();
    var stale = D.updatedAt && (Date.now() - new Date(D.updatedAt).getTime()) > 36 * 3600 * 1000;
    $('updated').classList.toggle('stale', !!stale);
    $('updatedTxt').textContent = 'Updated ' + relTime(D.updatedAt);
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

  var geoOpen = false;
  $('geoHdr').addEventListener('click', function () {
    geoOpen = !geoOpen;
    $('geo').style.display = geoOpen ? '' : 'none';
    $('geoChev').classList.toggle('open', geoOpen);
  });

  function scoreColor(s) { return s > 0 ? 'var(--long)' : s < 0 ? 'var(--short)' : 'var(--range)'; }

  var openCcy = null;
  function renderToday(D) {
    var m = D.meta || {};
    renderBigEvent(D);
    $('dailyRead').textContent = D.dailyRead || '';
    $('geo').textContent = D.geopolitics || '';

    // world snapshot (fallback: regime prose if the report has no snapshot yet)
    var snap = Array.isArray(D.snapshot) ? D.snapshot : [];
    $('snapshot').innerHTML = snap.length
      ? snap.map(function (r) {
          // ALWAYS stacked: `t` renders as a bold headline with `s` beneath it.
          // Darius chose this layout on 2026-09-07 and wants it every day, so it
          // is unconditional — a short `t` becomes a short heading rather than
          // flipping the page back to the old label-column look. (That two-column
          // style is why `s` once collapsed into a one-word-per-line sliver.)
          var t = r.t || '', s = r.s || '';
          return '<div class="snaprow stack">' +
            '<span class="si">' + esc(r.icon || '•') + '</span>' +
            (t ? '<span class="st">' + esc(t) + '</span>' : '') +
            (s ? '<span class="ss">' + esc(s) + '</span>' : '') + '</div>';
        }).join('')
      : '<div class="read" style="font-size:13px">' + esc(m.regime || '') + '</div>';

    // strongest -> weakest ranking strip (strength[] is already ordered)
    var st = D.strength || [];
    $('rankstrip').innerHTML = st.map(function (c, i) {
      return (i ? '<span class="rankarrow">›</span>' : '') +
        '<div class="rankchip" data-ccy="' + esc(c.ccy) + '"><span class="rc">' + esc(c.ccy) + '</span>' +
        '<span class="rs" style="color:' + scoreColor(c.score) + '">' + (c.score > 0 ? '+' : '') + c.score + '</span></div>';
    }).join('');
    $('rankstrip').querySelectorAll('.rankchip').forEach(function (ch) {
      ch.addEventListener('click', function () {
        openCcy = ch.getAttribute('data-ccy');
        renderCcyGrid(D);
        var el = document.querySelector('.cbox.open');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });

    renderCcyGrid(D);
    syncFullRead(true);
  }

  /* currency accordion grid — merges the old Strength details with the daily read */
  function renderCcyGrid(D) {
    var tmap = {};
    (D.today || []).forEach(function (t) { tmap[t.ccy] = t; });
    $('ccyGrid').innerHTML = (D.strength || []).map(function (c) {
      var t = tmap[c.ccy] || {};
      var open = openCcy === c.ccy;
      var pct = Math.abs(c.score) / 3 * 50, left = c.score >= 0 ? 50 : 50 - pct;
      var det = '<div class="cdetail">' +
        (t.headline ? '<div class="thl">' + esc(t.headline) + '</div>' : '') +
        (t.read ? '<div class="ctx" style="margin-top:4px">' + esc(t.read) + '</div>' : '') +
        '<div class="cbar"><div class="mid"></div><div class="fill" style="left:' + left + '%;width:' + pct + '%;background:' + scoreColor(c.score) + '"></div></div>' +
        '<div class="csec">Forward bias</div><div class="ctx">' + esc(c.forward || '') + '</div>' +
        '<div class="csec">Drivers</div><div class="ctx">' + esc(c.drivers || '') + '</div>' +
        '<div class="cclose">Close ▴</div></div>';
      return '<div class="cbox' + (open ? ' open' : '') + '" data-ccy="' + esc(c.ccy) + '">' +
        '<div class="chead"><span class="cc">' + esc(c.ccy) + '</span>' +
        '<span class="cs" style="color:' + scoreColor(c.score) + '">' + (c.score > 0 ? '+' : '') + c.score + '</span>' +
        '<span class="cdot' + (t.moved ? '' : ' q') + '"></span></div>' +
        '<div class="cverdict">' + esc(c.verdict || '') + (c.tag ? ' · ' + esc(c.tag) : '') + '</div>' + det + '</div>';
    }).join('');
    $('ccyGrid').querySelectorAll('.cbox').forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (e.target.closest('.cclose')) { openCcy = null; renderCcyGrid(D); return; }
        if (b.classList.contains('open')) return;
        openCcy = b.getAttribute('data-ccy');
        renderCcyGrid(D);
      });
    });
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
      var open = openMacro === ccy;
      var rate = m.rates ? m.rates.value : '—';
      var cpi = m.inflation ? m.inflation.value : '—';
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
      return '<div class="mcard" data-mccy="' + esc(ccy) + '" style="cursor:pointer">' +
        '<div class="mtop"><span class="mccy">' + esc(ccy) + '</span>' +
        '<span class="mverdict">' + esc(verdict[ccy] || '') + '</span>' +
        '<span class="mverdict" style="margin-left:auto">' + esc(rate) + ' · CPI ' + esc(cpi) + ' <span class="chev' + (open ? ' open' : '') + '" style="display:inline-block;transition:transform .15s">▸</span></span></div>' +
        '<div class="mbody" style="display:' + (open ? 'block' : 'none') + '">' + rows + '</div></div>';
    }).join('');
    $('macro').querySelectorAll('.mcard').forEach(function (card) {
      card.addEventListener('click', function () {
        var c = card.getAttribute('data-mccy');
        openMacro = openMacro === c ? null : c;
        renderMacro(DATA);
      });
    });
  }
  var openMacro = null;

  /* grouped compact rows: LONG / SHORT / RANGE sections; tap a row -> detail sheet */
  /* ---- Signals filters ------------------------------------------------
   * Conviction strings are NOT consistent across reports ("HIGH", "MEDIUM",
   * "MED", "LOW-MED", "LOW"), so rank them instead of matching text, and filter
   * on a minimum rank. Order matters below: LOW-MED must be tested before LOW,
   * or it would be caught by /^LOW/. */
  var CONV_RANK = [
    [/^HIGH/i, 3],
    [/^MED(IUM)?\b/i, 2],
    [/LOW[\s\-\/]*MED|MED[\s\-\/]*LOW/i, 1.5],
    [/^LOW/i, 1]
  ];
  function convRank(c) {
    var s = String(c || '').trim();
    for (var i = 0; i < CONV_RANK.length; i++) if (CONV_RANK[i][0].test(s)) return CONV_RANK[i][1];
    return 0;
  }
  var SIG_DIR = [['all', 'All'], ['LONG', 'Long'], ['SHORT', 'Short'], ['RANGE', 'Range']];
  var SIG_CONV = [['all', 'Any'], ['med', 'Med+'], ['high', 'High']];
  function dirPass(k, s) { return k === 'all' || s.bias === k; }
  function convPass(k, s) {
    if (k === 'high') return convRank(s.conv) >= 3;
    if (k === 'med') return convRank(s.conv) >= 2;   // HIGH + MEDIUM (LOW-MED excluded)
    return true;
  }
  var sigFilter = { dir: 'all', conv: 'all' };
  try {
    var _sf = JSON.parse(localStorage.getItem('fx_sig_filter') || 'null');
    if (_sf && typeof _sf.dir === 'string' && typeof _sf.conv === 'string') sigFilter = _sf;
  } catch (e) { /* private mode / cleared storage — defaults are fine */ }

  var lastSymbols = [];
  function renderSignals(symbols) {
    if (symbols) lastSymbols = symbols;
    var all = lastSymbols || [];

    // Faceted counts: each chip shows what you'd get if you tapped it, given the
    // OTHER axis's current selection — so the number never contradicts the list.
    function chips(defs, axis) {
      return defs.map(function (d) {
        var n = all.filter(function (s) {
          return axis === 'dir'
            ? dirPass(d[0], s) && convPass(sigFilter.conv, s)
            : convPass(d[0], s) && dirPass(sigFilter.dir, s);
        }).length;
        return '<button class="fchip' + (sigFilter[axis] === d[0] ? ' on' : '') +
          (n ? '' : ' zero') + '" data-axis="' + axis + '" data-v="' + d[0] + '">' +
          esc(d[1]) + '<span class="fn">' + n + '</span></button>';
      }).join('');
    }
    $('fDir').innerHTML = chips(SIG_DIR, 'dir');
    $('fConv').innerHTML = chips(SIG_CONV, 'conv');

    var shown = all.filter(function (s) { return dirPass(sigFilter.dir, s) && convPass(sigFilter.conv, s); });
    var active = sigFilter.dir !== 'all' || sigFilter.conv !== 'all';
    $('fCount').textContent = active ? 'Showing ' + shown.length + ' of ' + all.length : all.length + ' instruments';
    $('fClear').hidden = !active;

    var groups = [['LONG', 'Long'], ['SHORT', 'Short'], ['RANGE', 'Range / stand aside']];
    var html = groups.map(function (g) {
      var list = shown.filter(function (s) { return s.bias === g[0]; })
        .sort(function (x, y) { return x.sym.localeCompare(y.sym); });   // alphabetical within each bias group
      if (!list.length) return '';
      var rows = list.map(function (s) {
        return '<div class="srowc ' + s.bias + '" data-sym="' + esc(s.sym) + '">' +
          '<span class="ssym">' + esc(s.sym) + '</span>' +
          '<span class="sconv">' + esc(s.conv) + '</span>' +
          '<span class="swhy">' + esc(s.why || '') + '</span>' +
          '<span class="schev">›</span></div>';
      }).join('');
      return '<div class="sgroup"><div class="sgh"><span class="chip ' + g[0] + '">' + g[1] + '</span>' +
        '<span class="n">' + list.length + '</span></div>' + rows + '</div>';
    }).join('');

    $('signals').innerHTML = html ||
      '<div class="panel" style="text-align:center;color:var(--mut);font-size:13px">' +
      'Nothing matches this filter today.<br><span style="color:var(--dim);font-size:12px">' +
      'No ' + (sigFilter.conv === 'high' ? 'high-conviction' : sigFilter.conv === 'med' ? 'medium-or-better' : '') +
      ' setups in that direction — try widening it.</span></div>';

    $('signals').querySelectorAll('.srowc').forEach(function (r) {
      r.addEventListener('click', function () { openDetail(r.getAttribute('data-sym')); });
    });
  }

  // Filter chips: single-select per axis, remembered on this device.
  ['fDir', 'fConv'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('.fchip');
      if (!b) return;
      sigFilter[b.getAttribute('data-axis')] = b.getAttribute('data-v');
      try { localStorage.setItem('fx_sig_filter', JSON.stringify(sigFilter)); } catch (err) {}
      renderSignals();
    });
  });
  $('fClear').addEventListener('click', function () {
    sigFilter = { dir: 'all', conv: 'all' };
    try { localStorage.setItem('fx_sig_filter', JSON.stringify(sigFilter)); } catch (err) {}
    renderSignals();
  });

  var calOtherOpen = false;
  $('calOtherHdr').addEventListener('click', function () {
    calOtherOpen = !calOtherOpen;
    $('calOther').classList.toggle('open', calOtherOpen);
    $('calOtherChev').classList.toggle('open', calOtherOpen);
  });
  /* Released figures on red-folder catalysts. Two sources, merged:
   *   1) the Worker's GET /results — ForexFactory red-folder figures recorded at
   *      release time, keyed by release time + currency
   *   2) c.result — written into data.json by the post-release follow-up task
   * Red-folder lines are ForexFactory-style strings ({title, actual:"-0.1%",
   * forecast, previous, cmp}); results stored before 2026-09-14 are numeric
   * TradingView lines and still render.
   * ccyOf() mirrors inferCurrency() in proxy/release-match.js. */
  var liveResults = {}, resultsFetchedAt = 0, calData = null;
  var CCY_RULES_APP = [
    ['USD', /\b(United States|Federal Reserve|nonfarm|non-farm|payrolls|jobless claims|Powell|Warsh)\b/i, /\b(US|U\.S\.|FOMC|Fed|NFP|ISM|PCE)\b/],
    ['EUR', /\b(euro ?area|eurozone|Lagarde|German[y]?|France|French|Spain|Spanish|Ital(y|ian))\b/i, /\b(ECB|EZ|HICP|Ifo|ZEW)\b/],
    ['GBP', /\b(United Kingdom|Britain|British|Bank of England)\b/i, /\b(UK|U\.K\.|BoE|MPC)\b/],
    ['JPY', /\b(Japan|Japanese|Bank of Japan|Tokyo)\b/i, /\b(BoJ|JGB)\b/],
    ['AUD', /\b(Australia|Australian)\b/i, /\b(RBA)\b/],
    ['NZD', /\b(New Zealand)\b/i, /\b(RBNZ|NZ)\b/],
    ['CAD', /\b(Canada|Canadian|Bank of Canada)\b/i, /\b(BoC)\b/],
    ['CHF', /\b(Swiss|Switzerland)\b/i, /\b(SNB)\b/]
  ];
  function ccyOf(text) {
    var s = String(text || '');
    for (var i = 0; i < CCY_RULES_APP.length; i++) {
      if (CCY_RULES_APP[i][1].test(s) || CCY_RULES_APP[i][2].test(s)) return CCY_RULES_APP[i][0];
    }
    return null;
  }
  function resultKey(when, ccy) { return Date.parse(when) + '|' + ccy; }
  function fmtVal(v, unit) {
    if (v == null || v === '') return '—';
    if (typeof v === 'string') return v;
    var n = Number(v), s = isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
    return unit ? s + unit : s;
  }
  function numOf(v) {
    if (typeof v === 'number') return v;
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*[%KMBT]?\s*$/i.exec(String(v == null ? '' : v));
    return m ? Number(m[1]) : null;
  }
  function resultHtml(c) {
    var live = c.when ? liveResults[resultKey(c.when, ccyOf(c.event))] : null;
    var src = (live && live.lines && live.lines.length) ? live.lines : (c.result || []);
    var lines = src.filter(function (l) { return l && l.actual != null; }).slice(0, 4);
    if (!lines.length) return '';
    return '<div class="cres">' + lines.map(function (l) {
      var cmp = l.cmp;
      if (cmp == null) {                      // older numeric lines carry no comparison
        var a = numOf(l.actual), f = numOf(l.forecast);
        cmp = (a != null && f != null) ? (Math.abs(a - f) < 1e-9 ? 'in line' : a > f ? '▲ above' : '▼ below') : '';
      }
      var fc = (l.forecast == null || l.forecast === '') ? '' :
        ' <span class="crx">exp ' + esc(fmtVal(l.forecast, l.unit)) + '</span>';
      return '<div class="crl"><span class="crt">' +
        esc(String(l.title).replace(/\bRate (?=(YoY|MoM|QoQ)\b)/, '')) + '</span> <b>' +
        esc(fmtVal(l.actual, l.unit)) + '</b>' + fc +
        (cmp ? ' <span class="cmp">' + esc(cmp) + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function loadResults() {
    if (!CFG.workerUrl || Date.now() - resultsFetchedAt < 60000) return;
    resultsFetchedAt = Date.now();
    fetch(CFG.workerUrl.replace(/\/$/, '') + '/results', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        var m = {};
        (Array.isArray(list) ? list : []).forEach(function (x) {
          if (x && x.when && x.ccy) m[resultKey(x.when, x.ccy)] = x;
        });
        liveResults = m;
        if (calData) renderCalendar(calData);
        if (DATA) renderBigEvent(DATA);
      })
      .catch(function () { /* Worker unreachable: results already in data.json still show */ });
  }
  // pick up figures released while the app is open
  setInterval(function () { if (!document.hidden && calData) loadResults(); }, 120000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && calData) { loadResults(); if (DATA) renderBigEvent(DATA); } });

  // The release's own UTC timestamp, shown as Bucharest day + time. The text
  // `date` ("Nov 12") is the UTC day, so an Asian release late in the UTC evening
  // would otherwise show a day early.
  function whenLabel(c, inline) {
    var t = c.when ? Date.parse(c.when) : NaN;
    if (isNaN(t)) return esc(c.date);
    return inline ? esc(bucDay.format(t) + ' ' + bucClock.format(t))
      : esc(bucDay.format(t)) + '<span class="ctime">' + esc(bucClock.format(t)) + '</span>';
  }
  function calRow(c) {
    return '<div class="cal"><div class="cdate">' + whenLabel(c) + '</div>' +
      '<div><div class="cev"><span class="dot ' + esc(c.impact) + '"></span>' + esc(c.event) + '</div>' +
      resultHtml(c) +
      '<div class="cnote">' + esc(c.note || '') + '</div></div></div>';
  }
  function renderCalendar(D) {
    calData = D;
    loadResults();
    var all = D.catalysts || [];
    var red = all.filter(function (c) { return c.impact === 'high'; });
    var rest = all.filter(function (c) { return c.impact !== 'high'; });
    $('cal').innerHTML = red.length ? red.map(calRow).join('')
      : '<div class="legend" style="margin:0">No red-folder events in the current report.</div>';
    $('calOtherLabel').textContent = 'Other events (' + rest.length + ')';
    $('calOtherHdr').style.display = rest.length ? '' : 'none';
    $('calOther').innerHTML = rest.map(calRow).join('');
  }

  /* ============ Next big event card (Today tab) ============
   * Was one paragraph doing three jobs (the event, why it matters, the rest of
   * the calendar); Darius asked for structure on 2026-11-10. Now:
   *   header  flag + event, Bucharest day/time, live countdown (or Released)
   *   figures forecast / previous, plus the actual once the Worker has it
   *   why     why it matters; `priced` = what the market prices going in
   *   if/then the 2-3 tradeable outcomes (hidden once released)
   *   coming up / later  the next dated catalysts, straight from catalysts[]
   * Source: meta.nextEvent (structured, from the analyst). When it is missing
   * (reports before v32) or its event is more than RELEASED_KEEP_MS in the past,
   * the card builds itself from the next red folder in catalysts[]. */
  var CCY_FLAG = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭' };
  var RELEASED_KEEP_MS = 2 * 3600 * 1000;
  var UPCOMING_MS = 7 * 86400 * 1000;
  var MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var bigWhyOpen = false, bigLaterOpen = true;
  try { bigLaterOpen = localStorage.getItem('fx_later_open') !== '0'; } catch (e) {}

  // A catalyst's time: the exact `when`, else the day in its `date` text
  // ("Wed Dec 9") at midday UTC. Rolling items have neither and are skipped.
  function catTime(c) {
    var t = c.when ? Date.parse(c.when) : NaN;
    if (!isNaN(t)) return { t: t, exact: true };
    var m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(c.date || '');
    if (!m) return null;
    var ref = new Date(Date.now()), y = ref.getUTCFullYear(), mo = MON_IDX[m[1].toLowerCase()];
    if (mo < ref.getUTCMonth() - 6) y++;          // a January date seen in December
    return { t: Date.UTC(y, mo, +m[2], 12), exact: false };
  }
  function countdownTxt(t, now) {
    var mins = Math.round((t - now) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return 'in ' + mins + ' min';
    var h = Math.floor(mins / 60), mm = mins % 60;
    if (h < 24) return 'in ' + h + 'h' + (mm ? ' ' + mm + 'm' : '');
    var d = Math.floor(h / 24), hh = h % 24;
    return 'in ' + d + 'd' + (hh ? ' ' + hh + 'h' : '');
  }
  function shortWhen(t, exact, now) {
    var day = bucIsoDay.format(t) === bucIsoDay.format(now) ? 'Today' : bucDay.format(t);
    return exact ? (day === 'Today' ? 'Today' : day.split(' ')[0]) + ' ' + bucClock.format(t) : day;
  }
  // Released figures for a time+currency: the Worker's record first, then the
  // result the post-release pass wrote onto the matching catalyst.
  function releasedLines(D, when, ccy) {
    var live = liveResults[resultKey(when, ccy)];
    if (live && live.lines && live.lines.length) return live.lines;
    var t = Date.parse(when), hit = null;
    (D.catalysts || []).forEach(function (c) {
      if (!hit && c.when && Date.parse(c.when) === t && ccyOf(c.event) === ccy && c.result && c.result.length) hit = c.result;
    });
    return hit || [];
  }
  function pickBigEvent(D, now) {
    var ne = (D.meta || {}).nextEvent;
    var t = ne && ne.when ? Date.parse(ne.when) : NaN;
    if (ne && ne.event && !isNaN(t) && t > now - RELEASED_KEEP_MS) {
      return { event: ne.event, ccy: ne.ccy || ccyOf(ne.event), when: ne.when, t: t,
        figures: ne.figures || [], why: ne.why || '', priced: ne.priced || '', scenarios: ne.scenarios || [] };
    }
    var best = null;
    (D.catalysts || []).forEach(function (c) {
      if (c.impact !== 'high' || !c.when) return;
      var ct = Date.parse(c.when);
      if (isNaN(ct) || ct <= now - RELEASED_KEEP_MS) return;
      if (!best || ct < best.t) best = { t: ct, c: c };
    });
    if (!best) return null;
    return { event: best.c.event, ccy: ccyOf(best.c.event), when: best.c.when, t: best.t,
      figures: [], why: best.c.note || '', priced: '', scenarios: [], auto: true };
  }
  function bigFiguresHtml(ev, released, lines) {
    var rows, head;
    if (released && lines.length) {
      head = ['Actual', 'Fcst', 'Prev'];
      rows = lines.filter(function (l) { return l && l.actual != null; }).slice(0, 4).map(function (l) {
        var cmp = String(l.cmp || ''), arrow = /above/.test(cmp) ? ' ▲' : /below/.test(cmp) ? ' ▼' : '';
        return [String(l.title).replace(/\bRate (?=(YoY|MoM|QoQ)\b)/, ''),
          '<b class="nea">' + esc(fmtVal(l.actual, l.unit)) + esc(arrow) + '</b>',
          esc(fmtVal(l.forecast, l.unit)), esc(fmtVal(l.previous, l.unit))];
      });
    } else if (ev.figures.length) {
      head = ['Fcst', 'Prev'];
      rows = ev.figures.slice(0, 4).map(function (f) {
        return [f.label || '', '<b>' + esc(f.forecast == null ? '—' : f.forecast) + '</b>', esc(f.previous == null ? '—' : f.previous)];
      });
    }
    if (!rows || !rows.length) return '';
    return '<div class="nefig" style="grid-template-columns:1fr repeat(' + head.length + ',auto)">' +
      '<span></span>' + head.map(function (h) { return '<span class="nefh">' + h + '</span>'; }).join('') +
      rows.map(function (r) {
        return '<span class="nefl">' + esc(r[0]) + '</span>' + r.slice(1).map(function (v) { return '<span class="nefv">' + v + '</span>'; }).join('');
      }).join('') + '</div>';
  }
  function bigListRow(x, now) {
    return '<div class="neup"><span class="neut">' + esc(shortWhen(x.t, x.exact, now)) + '</span>' +
      '<span class="dot ' + esc(x.c.impact) + '"></span><span class="neue">' + esc(x.c.event) + '</span></div>';
  }
  function renderBigEvent(D) {
    var box = $('bigevent');
    if (!box || !D) return;
    var now = Date.now(), ev = pickBigEvent(D, now);
    if (!ev) {                                   // nothing dated: the old prose line
      box.innerHTML = '<div class="nehdr"><span class="ic">📌</span><span class="k">Next big event</span></div>' +
        '<div class="v">' + esc((D.meta || {}).nextBigEvent || '—') + '</div>';
      return;
    }
    var released = ev.t <= now, lines = released && ev.ccy ? releasedLines(D, ev.when, ev.ccy) : [];
    var chip = released ? (lines.length ? 'Released' : 'Out now') : countdownTxt(ev.t, now);
    var html = '<div class="nehdr"><span class="ic">📌</span><span class="k">Next big event</span>' +
      '<span class="nechip' + (released ? ' done' : (ev.t - now < 3600000 ? ' soon' : '')) + '">' + esc(chip) + '</span></div>' +
      '<div class="netitle">' + (ev.ccy && CCY_FLAG[ev.ccy] ? CCY_FLAG[ev.ccy] + ' ' : '') + esc(ev.event) + '</div>' +
      '<div class="newhen">' + esc(bucDay.format(ev.t) + ' · ' + bucClock.format(ev.t)) + '</div>' +
      bigFiguresHtml(ev, released, lines);
    if (ev.why) {
      html += '<div class="newhy' + (ev.auto ? ' clamp' : '') + (bigWhyOpen ? ' open' : '') + '" id="bigWhy">' +
        '<span class="nelab">Why it matters</span>' + esc(ev.why) + '</div>' +
        (ev.auto ? '<button class="nemorewhy" id="bigWhyMore" hidden></button>' : '');
    }
    if (!released && ev.priced) html += '<div class="neprice"><span class="nelab">Priced in</span>' + esc(ev.priced) + '</div>';
    if (!released && ev.scenarios.length) {
      html += '<div class="nesc">' + ev.scenarios.slice(0, 3).map(function (s) {
        return '<div class="nesr"><span class="neif">' + esc(s.if) + '</span><span class="nethen">' + esc(s.then) + '</span></div>';
      }).join('') + '</div>';
    }
    // The rest of the calendar: exact-time events in the next 7 days, then later dated ones.
    var soon = [], later = [];
    (D.catalysts || []).forEach(function (c) {
      if (c.impact !== 'high' && c.impact !== 'med') return;
      var ct = catTime(c);
      if (!ct || ct.t <= now || (ct.exact && ct.t === ev.t && ccyOf(c.event) === ev.ccy)) return;
      var x = { t: ct.t, exact: ct.exact, c: c };
      (ct.exact && ct.t - now < UPCOMING_MS ? soon : later).push(x);
    });
    var byT = function (a, b) { return a.t - b.t; };
    soon.sort(byT); later.sort(byT);
    // At most 6 rows, but never drop a red folder: trim the latest amber ones first.
    while (soon.length > 6) {
      var cut = -1;
      for (var i = soon.length - 1; i >= 0; i--) if (soon[i].c.impact !== 'high') { cut = i; break; }
      soon.splice(cut < 0 ? soon.length - 1 : cut, 1);
    }
    if (soon.length) html += '<div class="nesec">Coming up</div>' + soon.map(function (x) { return bigListRow(x, now); }).join('');
    if (later.length) {
      html += '<div class="nesec tog" id="bigLaterHdr">Later (' + Math.min(later.length, 10) + ') <span class="chev' + (bigLaterOpen ? ' open' : '') + '">▸</span></div>' +
        '<div id="bigLater"' + (bigLaterOpen ? '' : ' hidden') + '>' + later.slice(0, 10).map(function (x) { return bigListRow(x, now); }).join('') + '</div>';
    }
    html += '<button class="nemore" id="bigCal">Full calendar ›</button>';
    box.innerHTML = html;
    $('bigCal').addEventListener('click', function () { showView('cal'); });
    var why = $('bigWhy'), whyMore = $('bigWhyMore');
    if (why && whyMore) {                         // long catalyst note: clamp to 4 lines, tap to expand
      var syncWhy = function () {
        why.classList.toggle('open', bigWhyOpen);
        whyMore.hidden = !(bigWhyOpen || why.scrollHeight > why.clientHeight + 2);
        whyMore.textContent = bigWhyOpen ? 'less ⌃' : 'more ⌄';
      };
      var flip = function () { bigWhyOpen = !bigWhyOpen; syncWhy(); };
      why.addEventListener('click', flip); whyMore.addEventListener('click', flip);
      syncWhy();
    }
    var lh = $('bigLaterHdr');
    if (lh) lh.addEventListener('click', function () {
      bigLaterOpen = !bigLaterOpen;
      try { localStorage.setItem('fx_later_open', bigLaterOpen ? '1' : '0'); } catch (e) {}
      $('bigLater').hidden = !bigLaterOpen;
      lh.querySelector('.chev').classList.toggle('open', bigLaterOpen);
    });
  }
  // keep the countdown and the released figures current while the app is open
  setInterval(function () { if (!document.hidden && DATA) renderBigEvent(DATA); }, 60000);

  /* ===== US30 intraday bias (2026-11-18; NAS100 removed 2026-11-23, v40). D.us30 is
   * written by the cloud analyst at 08:00 and updated 40 min before the London open,
   * at 14:00 and 40 min before the NY cash open. Prices are BlackBull Markets' US30
   * CFD, the chart Darius trades (v40). Each session is a LEVEL MAP (a long and a
   * short side, each with an entry zone, targets and a stop); the Worker follows
   * both on BlackBull's live 5-minute candles (GET /us30 -> plan) so the card says
   * "T1 hit 16:42 · don't chase" instead of a plan the market already played out.
   * The track record also comes from the Worker, which scores each session from
   * the market itself: the analyst never grades its own calls. */
  var IDX = {
    us30: { key: 'us30', label: 'US30', name: 'BlackBull US30', fut: 'US30', calc: 'US30',
      tv: 'https://www.tradingview.com/chart/?symbol=BLACKBULL%3AUS30' }
  };
  function idxOfSym(sym) {                       // calculator instrument -> index key
    for (var k in IDX) if (String(sym || '').indexOf(IDX[k].calc + ' ') === 0) return k;
    return null;
  }
  var U3_CHIP = { BULLISH: 'LONG', BEARISH: 'SHORT', RANGE: 'RANGE' };
  var U3_WORD = { BULLISH: 'Bullish', BEARISH: 'Bearish', RANGE: 'Range' };
  var U3_DAY = { trend: ['📈', 'Trend day'], range: ['↔️', 'Range day'], news: ['📰', 'News-driven day'] };
  var U3_CONV = { high: 3, medium: 2, med: 2, low: 1 };
  var idxTrack = {}, idxTrackAt = {};
  // NYSE full-day closures (mirror of proxy/us30.js): no cash session, no bias.
  var US_HOLIDAYS = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15',
    '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'];
  function usTradingDay(date) {
    var wd = new Date(date + 'T12:00:00Z').getUTCDay();
    return wd >= 1 && wd <= 5 && US_HOLIDAYS.indexOf(date) < 0;
  }
  function nextUsTradingDay(date) {
    var t = Date.parse(date + 'T12:00:00Z');
    for (var i = 0; i < 10; i++) { t += 86400000; var d = new Date(t).toISOString().slice(0, 10); if (usTradingDay(d)) return d; }
    return null;
  }
  var tzFmt = {};
  function tzMin(ms, tz) {                       // {date, min} of a UTC instant in a zone
    var f = tzFmt[tz] || (tzFmt[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, min: (+p.hour) * 60 + (+p.minute) };
  }
  function zonedMs(date, min, tz) {              // wall-clock time in a zone -> UTC ms
    var a = date.split('-').map(Number), want = Date.UTC(a[0], a[1] - 1, a[2], Math.floor(min / 60), min % 60), t = want;
    for (var i = 0; i < 2; i++) {
      var p = tzMin(t, tz), b = p.date.split('-').map(Number);
      t += want - Date.UTC(b[0], b[1] - 1, b[2], Math.floor(p.min / 60), p.min % 60);
    }
    return t;
  }
  // London 08:00 London -> NY cash open 09:30 New York -> cash close 16:00 New York
  function u3Times(date) {
    return { lon: zonedMs(date, 480, 'Europe/London'), ny: zonedMs(date, 570, 'America/New_York'),
      close: zonedMs(date, 960, 'America/New_York') };
  }
  // The analyst's intraday updates (mirror of proxy/indices.js updateFires):
  // 40 min before the London open, 14:00 Bucharest (>= 90 min before the NY
  // fire), and 40 min before the NY cash open.
  function u3Fires(date) {
    var t = u3Times(date), ny = t.ny - 40 * 60000, mid = zonedMs(date, 14 * 60, BUC_TZ);
    if (ny - mid < 90 * 60000) mid = ny - 90 * 60000;
    return [{ k: 'london-update', at: t.lon - 40 * 60000 }, { k: 'midday', at: mid }, { k: 'ny', at: ny }];
  }
  var U3_STAGE = { london: 'London plan', 'london-update': 'London update', midday: 'Midday update', ny: 'NY update' };
  var U3_CHECK = { 'on-track': 'On track', 'target-hit': 'Target hit', invalidated: 'Invalidated', 'not-triggered': 'Not triggered' };
  // Live: price, today's ranges, the level map's status and the track record, at
  // most every 45 s while the tab is open (refreshed by the minute timer below).
  function loadIdxTrack(k) {
    if (!IDX[k] || !CFG.workerUrl || Date.now() - (idxTrackAt[k] || 0) < 45000) return;
    idxTrackAt[k] = Date.now();
    fetch(CFG.workerUrl.replace(/\/$/, '') + '/' + k, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { idxTrack[k] = j; if (DATA) renderIdx(k, DATA); } })
      .catch(function () { /* Worker unreachable: the bias still shows */ });
  }
  function u3Dots(conv) {
    var n = U3_CONV[String(conv || '').toLowerCase()] || 0;
    return '<span class="u3dots" title="' + esc(conv || '') + ' conviction">' +
      [1, 2, 3].map(function (i) { return '<i' + (i <= n ? ' class="on"' : '') + '></i>'; }).join('') + '</span>';
  }
  function u3Num(v) { return v == null || v === '' ? '—' : Number(v).toLocaleString('en-US'); }
  function u3Result(sc) {
    if (!sc) return '';
    var lab = sc.r === 'hit' ? '✓ Right' : sc.r === 'miss' ? '✗ Wrong' : '– Flat';
    return '<span class="u3res ' + sc.r + '">' + lab + ' · ' + (sc.move > 0 ? '+' : '') + u3Num(sc.move) + ' pts</span>';
  }
  function u3SessionCard(key, s, from, to, now, U, track) {
    var flag = key === 'london' ? '🇬🇧 London' : '🇺🇸 New York';
    var state, cls = '';
    if (now < from) state = 'starts ' + countdownTxt(from, now);
    else if (now < to) { state = 'live now'; cls = ' live'; }
    else { state = 'done'; cls = ' done'; }
    var rec = track && track.today && track.today.date === U.date ? track.today[key === 'london' ? 'lon' : 'ny'] : null;
    var lean = (s && s.lean) || 'RANGE';
    var html = '<div class="u3s ' + (U3_CHIP[lean] || 'RANGE') + cls + '">' +
      '<div class="u3sh"><span class="u3sn">' + flag + '</span><span class="u3st">' + bucClock.format(from) + '–' + bucClock.format(to) + '</span>' +
      '<span class="u3state' + cls + '">' + esc(state) + '</span></div>';
    if (!s) return html + '<div class="u3plan dim">No call for this session yet.</div></div>';
    html += '<div class="u3lean"><span class="chip ' + (U3_CHIP[lean] || 'RANGE') + '">' + esc(lean) + '</span>' + u3Dots(s.conviction) +
      (now < from && ((key === 'ny' && U.stage !== 'ny') || (key === 'london' && U.stage === 'london'))
        ? '<span class="u3first">First look · final call ~' + bucClock.format(from - 40 * 60000) + '</span>' : '') +
      (rec && rec.score ? u3Result(rec.score) : '') + '</div>';
    if (s.long || s.short) {
      var ps = track && track.plan && track.plan[key], stOk = !!(ps && s.at && ps.at === s.at);
      var fav = s.lean === 'BULLISH' ? 'long' : s.lean === 'BEARISH' ? 'short' : null;
      var a = u3Side(s.long, 'long', stOk ? ps.long : null, fav === 'long'), b = u3Side(s.short, 'short', stOk ? ps.short : null, fav === 'short');
      html += '<div class="u3map">' + (fav === 'short' ? b + a : a + b) + '</div>';
      if (s.wait) html += '<div class="u3wait">' + esc(s.wait) + '</div>';
      html += '<div class="u3mapnote">' + (stOk ? 'Status from BlackBull\'s live 5-min candles since this map was written at ' + bucClock.format(Date.parse(s.at)) + '.'
        : s.at ? 'Map written at ' + bucClock.format(Date.parse(s.at)) + (now < to ? ' · live status loading…' : '.') : '') + '</div>';
    } else {
      if (s.plan) html += '<div class="u3plan">' + esc(s.plan) + '</div>';
      if (s.invalid) html += '<div class="u3inv"><span>Wrong if</span>' + esc(s.invalid) + '</div>';
    }
    if (s.check && U3_CHECK[s.check.status]) {
      var ct = Date.parse(s.check.at);
      html += '<div class="u3chk ' + s.check.status + '"><span>' + (isNaN(ct) ? 'Update' : bucClock.format(ct) + ' check') +
        ' · <b>' + U3_CHECK[s.check.status] + '</b></span>' + esc(s.check.note || '') + '</div>';
    }
    return html + '</div>';
  }
  // One side of a session's level map, with its live status from the Worker.
  var U3_SIDE = { waiting: ['wait', 'Not reached'], live: ['live', 'In the zone'], t1: ['hit', 'T1 hit'], t2: ['hit', 'T2 hit'],
    stopped: ['stop', 'Stopped'], missed: ['miss', 'Ran without entry'] };
  function u3SideState(st) {
    if (!st) return '';
    var m = U3_SIDE[st.state] || U3_SIDE.waiting;
    var at = st.t2At || st.t1At || st.stopAt || st.missedAt || st.liveAt;
    var txt = m[1] + (at && st.state !== 'waiting' ? ' ' + bucClock.format(at) : '');
    if (st.state === 't1' || st.state === 'missed') txt += ' · don\'t chase';
    if (st.state === 'live') txt += ' · setup on';
    return '<span class="u3ss ' + m[0] + '">' + esc(txt) + '</span>';
  }
  function u3Side(x, dir, st, fav) {
    if (!x || !x.zone) return '';
    var L = dir === 'long';
    return '<div class="u3side ' + (L ? 'LONG' : 'SHORT') + (fav ? ' fav' : '') + (st ? ' s-' + st.state : '') + '">' +
      '<div class="u3sideh"><span class="u3dir">' + (L ? '▲ Long' : '▼ Short') + (fav ? ' <em>favoured</em>' : '') + '</span>' + u3SideState(st) + '</div>' +
      '<div class="u3zone"><span class="u3zk">Zone</span><b>' + u3Num(x.zone[0]) + '–' + u3Num(x.zone[1]) + '</b></div>' +
      '<div class="u3tg"><span>T1 <b>' + u3Num(x.t1) + '</b></span>' + (x.t2 != null ? '<span>T2 <b>' + u3Num(x.t2) + '</b></span>' : '') +
      '<span class="u3stop">Stop <b>' + u3Num(x.stop) + '</b></span></div>' +
      (x.entry ? '<div class="u3entry">' + esc(x.entry) + '</div>' : '') + '</div>';
  }
  function u3Levels(U, ix) {
    var lv = (U.levels || []).filter(function (l) { return l && l.name && isFinite(Number(l.v)); }).slice(0, 8);
    if (!lv.length) return '';
    lv.sort(function (a, b) { return Number(b.v) - Number(a.v); });
    var L = idxTrack[ix.key] && idxTrack[ix.key].live;
    var ref = L && isFinite(Number(L.last)) ? Number(L.last) : U.ref && isFinite(Number(U.ref.price)) ? Number(U.ref.price) : null, placed = ref == null;
    var nowTxt = L && isFinite(Number(L.last)) ? '<span>Now ' + u3Num(ref) + '</span> live ' + bucClock.format(Date.parse(L.fetchedAt))
      : '<span>' + ix.fut + ' ≈ ' + u3Num(ref) + '</span>' + (U.ref && U.ref.at ? ' at ' + bucClock.format(Date.parse(U.ref.at)) : '');
    var rows = '';
    lv.forEach(function (l) {
      if (!placed && Number(l.v) < ref) {
        rows += '<div class="u3now">' + nowTxt + '</div>';
        placed = true;
      }
      var side = ref == null ? '' : Number(l.v) >= ref ? ' above' : ' below';
      rows += '<div class="u3lv' + side + '"><span class="u3ln">' + esc(l.name) + '</span><span class="u3lp">' + u3Num(l.v) + '</span>' +
        '<span class="u3lnote">' + esc(l.note || '') + '</span></div>';
    });
    if (!placed) rows += '<div class="u3now">' + nowTxt + '</div>';
    return '<div class="panel"><h2>Levels to watch <span class="sidenote">' + esc(ix.name) + '</span></h2>' + rows + '</div>';
  }
  function u3Events(D, U, now) {
    var ev = (U.events || []).map(function (e) { return { t: Date.parse(e.when), what: e.what, kind: e.kind || 'data' }; })
      .filter(function (e) { return e.what; });
    if (!ev.length) {                           // fall back to today's USD catalysts
      (D.catalysts || []).forEach(function (c) {
        var t = c.when ? Date.parse(c.when) : NaN;
        if (!isNaN(t) && ccyOf(c.event) === 'USD' && bucIsoDay.format(t) === bucIsoDay.format(now) && (c.impact === 'high' || c.impact === 'med'))
          ev.push({ t: t, what: c.event, kind: c.impact === 'high' ? 'data' : 'minor' });
      });
    }
    if (!ev.length) return '';
    ev.sort(function (a, b) { return (isNaN(a.t) ? 9e15 : a.t) - (isNaN(b.t) ? 9e15 : b.t); });
    var KIND = { data: ['high', 'Stand aside ±5 min'], fed: ['med', 'Fed'], earnings: ['low', 'Earnings'], minor: ['med', ''] };
    return '<div class="panel"><h2>US events today <span class="sidenote">Bucharest time</span></h2>' + ev.slice(0, 8).map(function (e) {
      var k = KIND[e.kind] || KIND.minor, past = !isNaN(e.t) && e.t < now - 5 * 60000;
      return '<div class="u3ev' + (past ? ' past' : '') + '"><span class="u3et">' + (isNaN(e.t) ? 'Today' : bucClock.format(e.t)) + '</span>' +
        '<span class="dot ' + k[0] + '"></span><span class="u3ew">' + esc(e.what) + '</span>' +
        (k[1] && !past ? '<span class="u3etag ' + e.kind + '">' + k[1] + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function u3TrackHtml(ix) {
    var t = idxTrack[ix.key] && idxTrack[ix.key].scores;
    var head = '<div class="panel"><h2>Track record <span class="sidenote">last 20 sessions each</span></h2>';
    var foot = '<div class="legend u3leg">Scored automatically from the market (BlackBull US30 from 24 Nov 2026, YM futures before), not by the analyst: a Bullish or Bearish call is <b>right</b> when the session moved at least 10% of the daily ATR its way, <b>wrong</b> when it moved that much the other way, otherwise <b>flat</b> (not counted). London = 10:00 to the NY open, NY = cash open to close.</div></div>';
    if (!t || !t.recent || !t.recent.length) return head + '<div class="u3empty">Scoring starts with the first sessions after launch.</div>' + foot;
    var cell = function (k, lab) {
      var s = t.summary[k] || {}, n = (s.hit || 0) + (s.miss || 0);
      return '<div class="u3rc"><span class="u3rk">' + lab + '</span><b>' + (n ? Math.round(100 * s.hit / n) + '%' : '—') + '</b>' +
        '<span class="u3rn">' + (s.hit || 0) + ' right · ' + (s.miss || 0) + ' wrong' + (s.flat ? ' · ' + s.flat + ' flat' : '') + '</span></div>';
    };
    var dots = t.recent.slice(0, 10).reverse().map(function (x) {
      return '<i class="' + x.r + '" title="' + esc(x.date + ' ' + (x.s === 'lon' ? 'London' : 'NY') + ' ' + x.call + ': ' + x.r + ' (' + x.move + ' pts)') + '">' + (x.s === 'lon' ? 'L' : 'N') + '</i>';
    }).join('');
    return head + '<div class="u3rec">' + cell('london', '🇬🇧 London') + cell('ny', '🇺🇸 New York') + '</div>' +
      '<div class="u3hist">' + dots + '<span>← older · newer →</span></div>' + foot;
  }
  function renderIdx(k, D) {
    var ix = IDX[k], box = $(k);
    if (!ix || !box || !D) return;
    var U = D[k], now = Date.now();
    if (!U || !U.date) {
      box.innerHTML = '<div class="notice">The first ' + ix.label + ' bias arrives with the 08:00 report: a level map for London and New York, levels and the day\'s US events. It is refreshed 40 minutes before the London open, at 14:00 and 40 minutes before the New York open.</div>';
      return;
    }
    var times = u3Times(U.date), today = bucIsoDay.format(now);
    var dayName = function (d) { return bucDay.format(Date.parse(d + 'T12:00:00Z')); };
    var bias = U.bias || 'RANGE', dt = U3_DAY[U.dayType] || null;
    var stageTxt = U3_STAGE[U.stage] || 'London plan';
    var nextUp = U.date === today ? u3Fires(U.date).filter(function (f) { return f.at > now; })[0] : null;
    var html = '';
    if (U.date < today) {
      var nx = nextUsTradingDay(U.date), msg;
      if (!usTradingDay(today)) msg = 'US markets are closed today. Showing ' + dayName(U.date) + '\'s bias; the next one comes with the 08:00 report' + (nx ? ' on ' + dayName(nx) : '') + '.';
      else if (tzMin(now, BUC_TZ).min < 8 * 60 + 30) msg = 'Showing ' + dayName(U.date) + '\'s bias. Today\'s arrives with the 08:00 report.';
      else msg = 'Showing ' + dayName(U.date) + '\'s bias. Today\'s has not arrived yet.';
      html += '<div class="u3stale">' + esc(msg) + '</div>';
    }
    html += '<div class="u3hero ' + (U3_CHIP[bias] || 'RANGE') + '">' +
      '<div class="u3top"><span class="u3k">' + ix.label + ' · ' + ix.name + '</span><span class="nechip">' + esc(stageTxt) +
      (U.updatedAt ? ' · ' + bucClock.format(Date.parse(U.updatedAt)) : '') + '</span></div>' +
      '<div class="u3bias"><span class="u3big ' + (U3_CHIP[bias] || 'RANGE') + '">' + esc(U3_WORD[bias] || bias) + '</span>' +
      (U.conviction ? '<span class="u3cv">' + u3Dots(U.conviction) + '<span>' + esc(String(U.conviction).charAt(0).toUpperCase() + String(U.conviction).slice(1).toLowerCase() + ' conviction') + '</span></span>' : '') + '</div>' +
      (dt ? '<div class="u3type">' + dt[0] + ' ' + dt[1] + '</div>' : '') +
      (U.headline ? '<div class="u3head">' + esc(U.headline) + '</div>' : '') +
      (idxTrack[k] && idxTrack[k].live && idxTrack[k].live.last != null && U.date === today
        ? '<div class="u3live"><span class="u3livedot"></span>' + esc(ix.name) + ' <b>' + u3Num(idxTrack[k].live.last) + '</b> · live ' + bucClock.format(Date.parse(idxTrack[k].live.fetchedAt)) + '</div>' : '') +
      '<div class="u3date">' + esc(bucDay.format(Date.parse(U.date + 'T12:00:00Z'))) +
        (nextUp ? ' · next update ' + bucClock.format(nextUp.at) + ' (' + U3_STAGE[nextUp.k].replace(' update', '') + ')' : '') + '</div></div>';
    var S = U.sessions || {};
    html += '<div class="u3sess">' + u3SessionCard('london', S.london, times.lon, times.ny, now, U, idxTrack[k]) +
      u3SessionCard('ny', S.ny, times.ny, times.close, now, U, idxTrack[k]) + '</div>';
    var dr = (U.drivers || []).filter(function (d) { return d && d.k; }).slice(0, 6);
    if (dr.length) {
      var up = dr.filter(function (d) { return d.s > 0; }).length, dn = dr.filter(function (d) { return d.s < 0; }).length;
      html += '<div class="panel"><h2>What\'s driving it <span class="sidenote"><span class="u3up">▲ ' + up + '</span> · <span class="u3dn">▼ ' + dn + '</span></span></h2>' +
        dr.map(function (d) {
          var c = d.s > 0 ? 'up' : d.s < 0 ? 'dn' : 'fl';
          return '<div class="u3dr"><span class="u3ds ' + c + '">' + (d.s > 0 ? '▲' : d.s < 0 ? '▼' : '●') + '</span>' +
            '<span class="u3dk">' + esc(d.k) + '</span><span class="u3dv">' + esc(d.v || '') + '</span></div>';
        }).join('') + '</div>';
    }
    html += u3Levels(U, ix);
    var sc = (U.scenarios || []).filter(function (s) { return s && s.if && s.then; }).slice(0, 3);
    if (sc.length) html += '<div class="panel"><h2>If → then</h2><div class="nesc" style="margin-top:0">' + sc.map(function (s) {
      return '<div class="nesr"><span class="neif">' + esc(s.if) + '</span><span class="nethen">' + esc(s.then) + '</span></div>';
    }).join('') + '</div></div>';
    html += u3Events(D, U, now);
    html += u3TrackHtml(ix);
    html += '<div class="u3btns"><button class="btn u3size">Size a ' + ix.label + ' trade</button>' +
      '<a class="btn ghost" href="' + ix.tv + '" target="_blank" rel="noopener">BlackBull US30 chart ›</a></div>';
    box.innerHTML = html;
    box.querySelector('.u3size').addEventListener('click', function () { openIdxCalc(k); });
  }
  setInterval(function () { if (!document.hidden && DATA && IDX[current]) { loadIdxTrack(current); renderIdx(current, DATA); } }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && IDX[current]) loadIdxTrack(current); });
  // Jump to the size calculator with the last contract used for this index (CFD by default).
  function openIdxCalc(k) {
    showView('trades');
    var sel = $('cPair');
    if (sel && idxOfSym(sel.value) !== k) {
      var last = null;
      try { last = localStorage.getItem('fx_' + k + '_last'); } catch (e) {}
      sel.value = CALC_COMMODITIES[last] && idxOfSym(last) === k ? last : IDX[k].calc + ' CFD';
      computeSize();
    }
    var e = $('cEntry');
    if (e) { e.scrollIntoView({ block: 'center' }); setTimeout(function () { e.focus(); }, 250); }
  }

  /* ============ Rates: policy-rate differentials (source: TradingEconomics) ============ */
  var TE_SLUG = { USD: 'united-states', EUR: 'euro-area', GBP: 'united-kingdom', JPY: 'japan',
    AUD: 'australia', NZD: 'new-zealand', CAD: 'canada', CHF: 'switzerland' };
  var CB_NAME = { USD: 'Fed', EUR: 'ECB', GBP: 'BoE', JPY: 'BoJ', AUD: 'RBA', NZD: 'RBNZ', CAD: 'BoC', CHF: 'SNB' };
  function parseRate(v) { var n = parseFloat(String(v || '').replace('%', '')); return isFinite(n) ? n : null; }
  var PATH_DELTA = { hike: 1, hold: 0, cut: -1 };
  var CB_STEP = 0.25;   // standard 25bp move

  /* Project the policy-rate gap and classify it.
   * WIDENING/TIGHTENING is about the MAGNITUDE of the gap, not its sign:
   * EUR/GBP at -1.50% with EUR hiking and GBP holding moves to -1.25%, i.e. the
   * two rates CONVERGE -> tightening. (Comparing the signed change instead was
   * the old bug: it called every base-currency hike a widening.)
   * `favours` is the orthogonal, actionable fact: which leg the move benefits. */
  function ratePath(diff, bp, qp) {
    var delta = (PATH_DELTA[(bp || {}).next] || 0) - (PATH_DELTA[(qp || {}).next] || 0);
    var proj = diff + CB_STEP * delta;
    var exp = 'stable';
    if (delta !== 0) {
      if (Math.abs(proj) > Math.abs(diff) + 1e-9) exp = 'widen';
      else if (Math.abs(proj) < Math.abs(diff) - 1e-9) exp = 'tighten';
    }
    return { delta: delta, proj: proj, exp: exp, favours: delta > 0 ? 'base' : delta < 0 ? 'quote' : null };
  }

  function diffSpark(bh, qh) {
    if (!bh || !qh || bh.length < 2 || qh.length < 2) return '';
    var n = Math.min(bh.length, qh.length);
    var d = [];
    for (var i = 0; i < n; i++) d.push(bh[bh.length - n + i] - qh[qh.length - n + i]);
    var min = Math.min.apply(null, d), max = Math.max.apply(null, d), rng = (max - min) || 1;
    var pts = d.map(function (v, i) {
      return ((i / (n - 1)) * 58 + 3).toFixed(1) + ' ' + (19 - ((v - min) / rng) * 16).toFixed(1);
    });
    var up = d[n - 1] > d[0], flat = Math.abs(d[n - 1] - d[0]) < 0.01;
    var col = flat ? 'var(--range)' : up ? 'var(--long)' : 'var(--short)';
    return '<svg class="rsp" viewBox="0 0 64 22"><path d="M' + pts.join(' L') +
      '" fill="none" stroke="' + col + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  var openRate = null;
  function renderRates(D) {
    var macro = D.macro || {}, paths = D.ratePaths || {};
    var pairs = (D.symbols || []).map(function (s) { return s.sym; })
      .filter(function (s) { return s.indexOf('/') > 0 && !LEG_MAP[s]; });
    var rows = pairs.map(function (sym) {
      var b = sym.split('/')[0], q = sym.split('/')[1];
      var br = macro[b] && parseRate(macro[b].rates && macro[b].rates.value);
      var qr = macro[q] && parseRate(macro[q].rates && macro[q].rates.value);
      if (br == null || qr == null) return null;
      var diff = br - qr;
      var bp = paths[b] || {}, qp = paths[q] || {};
      var rp = ratePath(diff, bp, qp);
      return { sym: sym, b: b, q: q, br: br, qr: qr, diff: diff, exp: rp.exp,
        proj: rp.proj, favours: rp.favours === 'base' ? b : rp.favours === 'quote' ? q : null,
        bp: bp, qp: qp, bh: macro[b].rates.hist, qh: macro[q].rates.hist };
    }).filter(Boolean);

    // alphabetical by pair (Darius's preference — predictable place for each pair)
    rows.sort(function (x, y) { return x.sym.localeCompare(y.sym); });

    var expLabel = { widen: 'WIDENING', tighten: 'TIGHTENING', stable: 'STABLE' };
    $('rates').innerHTML = rows.map(function (r) {
      var open = openRate === r.sym;
      var sign = r.diff > 0 ? '+' : '';
      return '<div class="rrow' + (open ? ' open' : '') + '" data-rsym="' + esc(r.sym) + '">' +
        '<div class="rtop"><span class="rsym">' + esc(r.sym) + '</span>' +
        '<span class="rdiff" style="color:' + (r.diff > 0 ? 'var(--long)' : r.diff < 0 ? 'var(--short)' : 'var(--range)') + '">' + sign + r.diff.toFixed(2) + '%</span>' +
        diffSpark(r.bh, r.qh) +
        '<span class="rexp ' + r.exp + '">' + expLabel[r.exp] + '</span></div>' +
        (r.favours ? '<div class="rsub">→ ' + (r.proj > 0 ? '+' : '') + r.proj.toFixed(2) +
          '% expected · favours <b>' + esc(r.favours) + '</b></div>' : '') +
        '<div class="rdetail">' +
          '<div class="rleg"><b>' + esc(r.b) + ' ' + r.br.toFixed(2) + '%</b> (' + esc(CB_NAME[r.b]) + ') — next: ' +
            esc((r.bp.next || 'n/a') + (r.bp.when ? ' · ' + r.bp.when : '')) +
            (r.bp.note ? '. ' + esc(r.bp.note) : '') + '</div>' +
          '<div class="rleg"><b>' + esc(r.q) + ' ' + r.qr.toFixed(2) + '%</b> (' + esc(CB_NAME[r.q]) + ') — next: ' +
            esc((r.qp.next || 'n/a') + (r.qp.when ? ' · ' + r.qp.when : '')) +
            (r.qp.note ? '. ' + esc(r.qp.note) : '') + '</div>' +
          '<a href="https://tradingeconomics.com/' + TE_SLUG[r.b] + '/interest-rate" target="_blank" rel="noopener">' + esc(r.b) + ' on TradingEconomics ↗</a> · ' +
          '<a href="https://tradingeconomics.com/' + TE_SLUG[r.q] + '/interest-rate" target="_blank" rel="noopener">' + esc(r.q) + ' ↗</a>' +
        '</div></div>';
    }).join('');
    $('rates').querySelectorAll('.rrow').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        var s = row.getAttribute('data-rsym');
        openRate = openRate === s ? null : s;
        renderRates(DATA);
      });
    });
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
  /* Darius's and his brother's iPhones stopped showing alerts (2026-10-06 and
   * 2026-11-17) while the Mac kept getting them and Apple answered 201 for every
   * device. iOS can drop a Home Screen app's push subscription without telling
   * anyone, and the app used to subscribe once and never look again. Now, on
   * every open:
   *   granted + subscription present -> re-post it (lastSeen; registers a rotated endpoint)
   *   granted + subscription gone    -> resubscribe; if iOS wants a tap, "Alerts stopped" panel
   *   default / denied               -> the enable panel / how to unblock
   * and the Alerts panel at the bottom of Today can send a test to THIS device
   * or re-register it, so a phone can be checked end to end in one tap. */
  var pushReg = null, pushSub = null;
  var PUSH_SYNC_MS = 3600 * 1000;
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'PC';
    return 'device';
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function pushBase() { return String((CFG.push || {}).subscribeUrl || '').replace(/\/subscribe\/?$/, ''); }
  function postJSON(path, obj) {
    return fetch(pushBase() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { j.httpStatus = r.status; return j; });
      });
  }
  function postSub(sub) {
    var o = JSON.parse(JSON.stringify(sub));
    o.label = deviceLabel(); o.app = APP_VERSION;
    return postJSON('/subscribe', o).then(function (j) {
      if (!j.ok) throw new Error('the server said HTTP ' + j.httpStatus);
      var prevEp = lsGet('fx_push_ep');
      if (prevEp && prevEp !== sub.endpoint) postJSON('/unsubscribe', { endpoint: prevEp });   // iOS rotated it
      lsSet('fx_push_on', '1'); lsSet('fx_push_ep', sub.endpoint); lsSet('fx_push_sync', String(Date.now()));
      return j;
    });
  }
  function freshSub() {
    return pushReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(CFG.push.vapidPublicKey) });
  }
  function setPushMsg(t) { var m = $('pushMsg'); if (m) m.textContent = t; }

  // 'on' -> compact panel at the bottom of Today; anything else -> a panel up top.
  function showPushState(state, msg) {
    $('alertRow').innerHTML = '';
    var bottom = $('pushPanel'); if (bottom) bottom.innerHTML = '';
    var dev = deviceLabel();
    if (state === 'on') {
      if (!bottom) return;
      bottom.innerHTML = '<div class="panel pushpanel"><h2>Alerts</h2>' +
        '<div class="pushline">🔔 On for this ' + esc(dev) + '</div>' +
        '<div class="pushbtns"><button class="btn" id="pushTest">Send test</button>' +
        '<button class="btn ghost" id="pushRereg">Re-register</button></div>' +
        '<div class="legend pushmsg" id="pushMsg">' + esc(msg || 'Not getting alerts? Tap Send test, then lock the phone — the test arrives about 5 seconds later.') + '</div></div>';
      $('pushTest').addEventListener('click', function () { sendTest(''); });
      $('pushRereg').addEventListener('click', reRegister);
      return;
    }
    var bar = document.createElement('div');
    bar.className = 'panel';
    if (state === 'denied') {
      bar.innerHTML = '<h2>Alerts are blocked</h2><div class="legend" style="margin:0">Notifications for FX Macro are switched off on this ' + esc(dev) +
        '. On iPhone: Settings → Notifications → FX Macro → Allow Notifications, then reopen the app.</div>';
    } else {
      var lost = state === 'lost';
      bar.innerHTML = '<h2>' + (lost ? '⚠ Alerts stopped on this ' + esc(dev) : 'Alerts') + '</h2>' +
        '<button class="btn" id="pushBtn">' + (lost ? 'Turn alerts back on' : 'Enable push alerts') + '</button>' +
        '<div class="legend" id="pushMsg" style="margin-top:8px">' +
        (lost ? 'This ' + esc(dev) + ' dropped its alert registration, so warnings and release figures can\'t reach it. One tap fixes it.'
              : 'Get a notification when a new report publishes or a high-impact event fires.') + '</div>';
    }
    $('alertRow').appendChild(bar);
    if ($('pushBtn')) $('pushBtn').addEventListener('click', function () { enablePush($('pushBtn')); });
  }

  function enablePush(btn) {
    btn.disabled = true; btn.textContent = 'Turning on…';
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { showPushState(perm === 'denied' ? 'denied' : 'off'); return; }
      return (pushReg ? Promise.resolve(pushReg) : navigator.serviceWorker.ready).then(function (reg) {
        pushReg = reg;
        return reg.pushManager.getSubscription().then(function (s) { return s || freshSub(); });
      }).then(function (s) { pushSub = s; return postSub(s); })
        .then(function () { showPushState('on', 'Alerts are on ✓ Tap Send test to check this device.'); });
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Try again';
      setPushMsg('Could not turn alerts on: ' + (e && e.message || e));
    });
  }

  function sendTest(prefix, retried) {
    if (!pushSub) { setPushMsg('This device has no registration — tap Re-register.'); return Promise.resolve(); }
    var btn = $('pushTest'); if (btn) btn.disabled = true;
    setPushMsg((prefix || '') + 'Sending in 5 seconds — lock the phone or go to the Home Screen now…');
    return postJSON('/push/self', { endpoint: pushSub.endpoint, delay: 5 }).then(function (j) {
      if (j.registered === false && !retried) {
        if (j.status) { setPushMsg('Apple says this device\'s registration has expired (' + j.status + '). Tap Re-register.'); return; }
        return postSub(pushSub).then(function () { return sendTest('Registered this device. ', true); });
      }
      if (j.registered === false) { setPushMsg('This device could not be registered — tap Re-register.'); return; }
      if (j.httpStatus === 429) { setPushMsg('One test a minute — try again shortly.'); return; }
      if (j.status === 201 || j.status === 200) {
        setPushMsg((prefix || '') + 'Apple accepted the test at ' + bucClock.format(Date.now()) + '. Didn\'t see it? Tap Re-register and test again; ' +
          'if it still doesn\'t show, check Settings → Notifications → FX Macro and any Focus mode.');
      } else {
        setPushMsg('Test failed (' + (j.status || j.error || ('HTTP ' + j.httpStatus)) + '). Tap Re-register.');
      }
    }).catch(function () {
      setPushMsg('Test sent — the reply was lost while the app was in the background. Did the notification arrive?');
    }).then(function () { if (btn) btn.disabled = false; });
  }

  function reRegister() {
    var old = pushSub, btn = $('pushRereg');
    if (btn) btn.disabled = true;
    setPushMsg('Re-registering…');
    (old ? old.unsubscribe().catch(function () {}) : Promise.resolve())
      .then(freshSub)
      .then(function (s) {
        pushSub = s;
        return postSub(s).then(function () {
          if (old && old.endpoint !== s.endpoint) postJSON('/unsubscribe', { endpoint: old.endpoint });
        });
      })
      .then(function () { if (btn) btn.disabled = false; return sendTest('Re-registered ✓ '); })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        pushReg.pushManager.getSubscription().then(function (s) { pushSub = s; if (!s) showPushState('lost'); });
        setPushMsg('Re-register failed (' + (e && e.message || e) + '). Remove FX Macro from the Home Screen, add it again from Safari, and enable alerts.');
      });
  }

  function setupPush() {
    var p = CFG.push || {};
    if (!p.enabled || !p.subscribeUrl || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      pushReg = reg;
      var perm = Notification.permission;
      if (perm === 'denied') { showPushState('denied'); return; }
      if (perm !== 'granted') { showPushState(lsGet('fx_push_on') === '1' ? 'lost' : 'off'); return; }
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) {
          pushSub = sub;
          showPushState('on');
          if (Date.now() - Number(lsGet('fx_push_sync') || 0) > PUSH_SYNC_MS || lsGet('fx_push_ep') !== sub.endpoint) {
            return postSub(sub).catch(function (e) { console.warn('[push] sync failed', e); });
          }
          return;
        }
        // Permission is still granted but the subscription is gone: iOS dropped it.
        return freshSub().then(function (s) { pushSub = s; return postSub(s); })
          .then(function () { showPushState('on', 'Alerts were reconnected on this device ✓ Tap Send test to check.'); })
          .catch(function (e) { console.warn('[push] resubscribe needs a tap', e); showPushState('lost'); });
      });
    }).catch(function (e) { console.warn('[push] setup failed', e); });
  }

  /* ============================ Size calculator ============================ */
  var CALC_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CAD', 'AUD/USD', 'NZD/USD',
    'EUR/JPY', 'EUR/AUD', 'EUR/NZD', 'GBP/JPY', 'GBP/AUD', 'GBP/NZD', 'AUD/JPY',
    'NZD/JPY', 'CAD/JPY', 'AUD/NZD', 'AUD/CAD', 'NZD/CAD',
    'USD/CHF', 'EUR/CHF', 'GBP/CHF', 'CAD/CHF', 'NZD/CHF', 'AUD/CHF', 'CHF/JPY',
    'EUR/GBP', 'EUR/CAD', 'GBP/CAD'];
  // Non-FX CFDs: stop loss is entered as a price move (not pips).
  //  kind 'cash'   -> stop is a $/€ price move; contract = units per lot
  //  kind 'points' -> stop is in index points; contract = money per point per lot
  // `quote` is the instrument's quote currency (converted to the deposit ccy).
  var CALC_COMMODITIES = {
    'XAU/USD': { contract: 100,  label: '100 oz/lot',    quote: 'USD', kind: 'cash' },
    'XAG/USD': { contract: 5000, label: '5,000 oz/lot',  quote: 'USD', kind: 'cash' },
    'USOIL':   { contract: 1000, label: '1,000 bbl/lot', quote: 'USD', kind: 'cash' },
    // Copper: quoted USD per pound; COMEX HG contract = 25,000 lbs per lot.
    // VERIFY against FOREX.COM's copper spec and change `contract` if theirs differs.
    'XCU/USD': { contract: 25000, label: '25,000 lbs/lot', quote: 'USD', kind: 'cash' },
    // GER40 (DAX): quoted in EUR, stop in index points. FOREX.COM Germany 40 =
    // €1.00 per point per 1.0 lot (confirmed from their contract spec).
    'GER40':   { contract: 1,    label: '€1 / point / lot', quote: 'EUR', kind: 'points' },
    // EU50 (Euro Stoxx 50): same shape as GER40 — EUR-quoted, stop in index
    // points. €1.00 per point per lot is the usual retail spec but is NOT yet
    // confirmed against FOREX.COM's Europe 50 sheet; verify before sizing on it.
    'EU50':    { contract: 1,    label: '€1 / point / lot', quote: 'EUR', kind: 'points' },
    // US30 (Dow, 2026-11-19; NAS100 removed 2026-11-23). A CFD's $ per point per
    // lot differs by broker (Darius trades BlackBull's US30), so it is
    // editable (default $1; `editable` = its localStorage key). The micro and mini
    // futures are CME contracts with fixed point values; they size in whole
    // contracts (`micro` = the smaller contract to suggest when 1 is too big).
    'US30 CFD':   { contract: 1,   label: '$1 / point / lot', quote: 'USD', kind: 'points', editable: 'fx_us30_cfd_pp' },
    'US30 MYM':   { contract: 0.5, label: '$0.50 / point / contract', quote: 'USD', kind: 'points', futures: true },
    'US30 YM':    { contract: 5,   label: '$5 / point / contract', quote: 'USD', kind: 'points', futures: true, micro: 'MYM' }
  };
  function cfdValue(c) {
    var v = NaN;
    try { v = parseFloat(String(localStorage.getItem(c.editable) || '').replace(',', '.')); } catch (e) {}
    return v > 0 ? v : c.contract;
  }
  function contractOf(c) { return c && c.editable ? cfdValue(c) : (c ? c.contract : 100000); }
  // Index prices as typed on a phone: "50.600" and "50,600" are both fifty thousand
  // six hundred (a thousands separator, as Darius writes them); "50600.5",
  // "50,600.5" and "50.600,5" keep their decimals.
  function priceNum(str) {
    var t = String(str == null ? '' : str).replace(/[\s']/g, '');
    if (!t) return NaN;
    var m = /^(\d{1,3}(?:([.,])\d{3})+)(?:([.,])(\d+))?$/.exec(t);
    if (m && (!m[3] || m[3] !== m[2])) return parseFloat(m[1].replace(/[.,]/g, '') + (m[4] ? '.' + m[4] : ''));
    return parseFloat(t.replace(',', '.'));
  }
  // one alphabetical list (same convention as the Rates and Signals tabs)
  var CALC_INSTRUMENTS = CALC_PAIRS.concat(Object.keys(CALC_COMMODITIES))
    .sort(function (x, y) { return x.localeCompare(y); });
  var CALC_CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'];
  var CCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', NZD: 'NZ$', CAD: 'C$', CHF: 'Fr ' };
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
        risk: $('cRisk').value, mode: $('cRiskMode').value, sl: $('cSl').value,
        entry: $('cEntry').value, stop: $('cStop').value
      }));
    } catch (e) {}
  }

  function setCalcRes(lots, units, risk) { $('rLots').textContent = lots; $('rUnits').textContent = units; $('rRisk').textContent = risk; }

  // accept both "100.5" and "100,5" (the phone keypad only offers a comma)
  function numVal(id) { return parseFloat(($(id).value || '').replace(',', '.').replace(/\s/g, '')); }

  var calcShownPair = null;
  function computeSize() {
    var pair = $('cPair').value, dep = $('cDep').value, mode = $('cRiskMode').value;
    if (idxOfSym(pair)) { try { localStorage.setItem('fx_' + idxOfSym(pair) + '_last', pair); } catch (e) {} }
    var bal = numVal('cBal'), risk = numVal('cRisk'), sl = numVal('cSl');
    var commodity = CALC_COMMODITIES[pair];
    var isPoints = commodity && commodity.kind === 'points';
    var isFut = !!(commodity && commodity.futures);
    // non-FX: SL is a price move so pipSize is 1 unit; FX keeps broker pips
    var pipSize = commodity ? 1 : (pair.indexOf('JPY') >= 0 ? 0.01 : 0.0001);
    $('cSlLabel').textContent = commodity ? (isPoints ? 'Stop loss (points)' : 'Stop loss ($ move)') : 'Stop loss (pips)';
    $('cPipLabel').textContent = commodity ? (commodity.editable ? '$ per point per lot' : 'Contract size') : '1 pip size';
    if (calcShownPair !== pair) {                 // re-render only on a change, or the input loses focus
      calcShownPair = pair;
      if (commodity && commodity.editable) {
        $('cPip').innerHTML = '<input id="cContract" type="text" inputmode="decimal" autocomplete="off" aria-label="Dollars per point per lot" value="' + cfdValue(commodity) + '">';
        $('cContract').addEventListener('input', function () {
          var v = parseFloat(($('cContract').value || '').replace(',', '.'));
          try { if (v > 0) localStorage.setItem(commodity.editable, String(v)); } catch (e) {}
          computeSize();
        });
      } else $('cPip').textContent = commodity ? commodity.label : pipSize.toString();
      $('cPip').classList.toggle('edit', !!(commodity && commodity.editable));
    }
    $('cEntryF').hidden = $('cStopF').hidden = !isPoints;
    $('rLotsLabel').textContent = isFut ? 'Contracts' : 'Lots (trade size)';
    $('rUnitsLabel').textContent = isPoints ? (commodity.quote + '/point') : 'Units';
    $('cRate').textContent = '';
    // Index: entry and stop prices give the stop distance (and the direction).
    var tradeDir = null, entryP = NaN, stopP = NaN;
    if (isPoints) {
      entryP = priceNum($('cEntry').value); stopP = priceNum($('cStop').value);
      if (entryP > 0 && stopP > 0 && entryP !== stopP) {
        sl = Math.round(Math.abs(entryP - stopP) * 10) / 10;
        tradeDir = stopP > entryP ? 'SHORT' : 'LONG';
        if (document.activeElement !== $('cSl')) $('cSl').value = String(sl);
      }
    }
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
    var contract = contractOf(commodity);
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
      // futures: whole contracts, rounded DOWN so the risk is never exceeded
      var lots = isFut ? Math.floor(exactLots + 1e-9) : Math.round(exactLots * 100) / 100;   // CFD step 0.01
      var belowMin = isFut ? lots < 1 : exactLots < 0.01;
      var useLots = (belowMin && !isFut) ? exactLots : lots;   // show precise if sub-minimum
      var unitsRaw = useLots * contract;   // FX/cash: units; points: quote$/point
      var units = isPoints ? (Math.round(unitsRaw * 100) / 100) : Math.round(unitsRaw);
      var actualRisk = useLots * riskPerLot;
      setCalcRes(isFut ? String(lots) : (belowMin ? exactLots.toFixed(3) : lots.toFixed(2)),
        units.toLocaleString('en-US'), fmtMoney(dep, actualRisk));
      var riskShown = mode === 'pct' ? (risk + '% = ' + fmtMoney(dep, riskAmount)) : fmtMoney(dep, riskAmount);
      var per = isFut ? '/contract' : '/lot';
      var fmtPx = function (v) { return v.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
      var stopTxt = sl.toLocaleString('en-US') + '-pt stop' + (tradeDir
        ? ' (' + (tradeDir === 'LONG' ? 'long' : 'short') + ' ' + fmtPx(entryP) + ' → stop ' + fmtPx(stopP) + ')' : '');
      $('cNote').className = 'calcnote' + (belowMin ? ' warn' : '');
      $('cNote').innerHTML = belowMin
        ? (isFut
          ? 'Risking <b>' + riskShown + '</b> is less than 1 contract: 1 ' + pair.split(' ')[1] + ' over this ' + sl.toLocaleString('en-US') + '-pt stop risks ' + fmtMoney(dep, riskPerLot) + '. <b>Raise risk, tighten the stop' + (commodity.micro ? ' or use ' + commodity.micro : '') + '</b>.'
          : 'Risking <b>' + riskShown + '</b> needs ≈' + exactLots.toFixed(3) + ' lots — <b>below the 0.01 minimum</b>; raise risk or balance.')
        : 'Risking <b>' + riskShown + '</b> · ' + (commodity
            ? (isPoints ? '1 point = <b>' + fmtMoney(dep, pvDep) + per + '</b> · ' + stopTxt
                        : '$1 move = <b>' + fmtMoney(dep, pvDep) + '/lot</b> · $' + sl + ' stop')
            : 'pip value <b>' + fmtMoney(dep, pvDep) + '/lot</b> · ' + sl + '-pip stop');
      lastCalc = belowMin ? null : {
        sym: pair, dep: dep, lots: isFut ? String(lots) : lots.toFixed(2), dir: tradeDir,
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
    if (saved.entry) $('cEntry').value = saved.entry;
    if (saved.stop) $('cStop').value = saved.stop;
    ['cPair', 'cDep', 'cBal', 'cRisk', 'cRiskMode', 'cSl', 'cEntry', 'cStop'].forEach(function (id) {
      $(id).addEventListener('input', computeSize);
      $(id).addEventListener('change', computeSize);
    });
    // Typing the points by hand replaces the entry/stop prices.
    $('cSl').addEventListener('input', function () {
      if ($('cEntry').value || $('cStop').value) { $('cEntry').value = ''; $('cStop').value = ''; computeSize(); }
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
  var LEG_MAP = { 'US30 CFD': ['USD'], 'US30 MYM': ['USD'], 'US30 YM': ['USD'], 'DXY': ['USD'], 'JPYBASKET': ['JPY'], 'GER40': ['EUR'], 'EU50': ['EUR'], 'XAU/USD': ['USD'], 'XAG/USD': ['USD'], 'USOIL': ['USD'] };
  var TV_MAP = { 'DXY': 'TVC:DXY', 'JPYBASKET': 'FXCM:JPYBASKET', 'GER40': 'GER40', 'EU50': 'TVC:SX5E', 'XAU/USD': 'OANDA:XAUUSD', 'XAG/USD': 'OANDA:XAGUSD', 'USOIL': 'TVC:USOIL' };
  var CAT_KEYS = {
    USD: /US |USD|Fed|FOMC|ISM|NFP/i, EUR: /ECB|EZ |euro|Germany|HICP/i, GBP: /BoE|UK |GBP/i,
    JPY: /BoJ|Japan|JPY|MoF|ambush/i, AUD: /RBA|Aussie|Australia|AUD/i, NZD: /RBNZ|NZ |NZD/i,
    CAD: /BoC|Canada|CAD|oil|WTI|Brent/i, CHF: /SNB|Swiss|CHF|franc/i
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

    // rate differential line for FX pairs (rates + expectations from TradingEconomics)
    var rateLine = '';
    if (sym.indexOf('/') > 0 && !LEG_MAP[sym] && DATA.macro) {
      var b = sym.split('/')[0], qc = sym.split('/')[1];
      var br = DATA.macro[b] && parseRate(DATA.macro[b].rates && DATA.macro[b].rates.value);
      var qr = DATA.macro[qc] && parseRate(DATA.macro[qc].rates && DATA.macro[qc].rates.value);
      if (br != null && qr != null) {
        var diff = br - qr;
        var bp = (DATA.ratePaths || {})[b] || {}, qp = (DATA.ratePaths || {})[qc] || {};
        var rp = ratePath(diff, bp, qp);
        var expTxt = rp.exp === 'widen' ? 'gap expected to WIDEN' : rp.exp === 'tighten' ? 'gap expected to TIGHTEN' : 'no move expected either side';
        if (rp.favours) expTxt += ' to ' + (rp.proj > 0 ? '+' : '') + rp.proj.toFixed(2) + '%, favouring ' + (rp.favours === 'base' ? b : qc);
        rateLine = '<div class="dsec"><h3>Rate differential</h3><div class="ctx" style="font-size:13px;color:var(--mut)">' +
          '<b style="color:' + (diff > 0 ? 'var(--long)' : diff < 0 ? 'var(--short)' : 'var(--range)') + '">' +
          (diff > 0 ? '+' : '') + diff.toFixed(2) + '%</b> (' + esc(b) + ' ' + br.toFixed(2) + '% − ' + esc(qc) + ' ' + qr.toFixed(2) + '%) · ' +
          expTxt + '</div></div>';
      }
    }

    var html = '<div class="dhead"><span class="sym">' + esc(sym) + '</span>' +
      '<span class="chip ' + s.bias + '">' + s.bias + '</span>' +
      '<span class="conv">' + esc(s.conv) + '</span></div>' +
      '<div class="dsec"><h3>Today\'s read</h3><div class="why">' + esc(s.why) + '</div>' +
      '<div class="rk"><b>Risk:</b> ' + esc(s.risk) + '</div></div>' + rateLine +
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
        return '<div class="dcat"><span class="dot ' + esc(c.impact) + '"></span><b>' + whenLabel(c, true) + '</b> — ' +
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
        ' · <span style="color:var(--long)">■</span> long <span style="color:var(--short)">■</span> short <span style="color:var(--cell-range)">■</span> range</div>';
    });
  }
  $('detailClose').addEventListener('click', closeDetail);
  $('detail').addEventListener('click', function (e) { if (e.target === $('detail')) closeDetail(); });
  function closeDetail() { $('detail').classList.remove('show'); document.body.style.overflow = ''; }

  /* ============================ Trade journal ============================ */
  var JSTATE = { trades: [] };
  try { JSTATE = JSON.parse(localStorage.getItem('fx_jcache') || '{"trades":[]}'); } catch (e) {}
  var lastCalc = null;
  var logDir = null, logSess = null;

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

  function sessTxt(t) { return t.session ? ' · ' + (t.session === 'london' ? 'London' : 'NY') + ' session' : ''; }
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
  /* Index trades (US30) are checked against the call for the SESSION
   * they were taken in, not the day bias (Darius, 2026-11-20): a NY short on a
   * Range day with a Bearish NY call is a trade WITH the analysis. The session
   * is preselected from the clock (before the NY cash open of the call's day =
   * London) and can be switched when a trade is logged late. */
  var LEAN_DIR = { BULLISH: 'LONG', BEARISH: 'SHORT', RANGE: 'RANGE' };
  function defaultSession(k) {
    var U = DATA && DATA[k];
    if (!U || !U.date) return 'ny';
    return Date.now() < u3Times(U.date).ny ? 'london' : 'ny';
  }
  function sessionCall(k, sess) {
    var U = DATA && DATA[k];
    if (!U) return null;
    var x = U.sessions && U.sessions[sess];
    if (x && x.lean) return { bias: LEAN_DIR[x.lean] || null, conv: String(x.conviction || U.conviction || '').toUpperCase() || null, lean: x.lean };
    return U.bias ? { bias: LEAN_DIR[U.bias] || null, conv: String(U.conviction || '').toUpperCase() || null, lean: U.bias, day: true } : null;
  }
  function updateSessUi() {
    var k = lastCalc && idxOfSym(lastCalc.sym);
    $('logSessRow').hidden = $('logSessHint').hidden = !k;
    if (!k) return;
    $('sessLon').classList.toggle('sel', logSess === 'london'); $('sessNy').classList.toggle('sel', logSess === 'ny');
    var c = sessionCall(k, logSess), U = DATA[k];
    var when = U && U.date && U.date !== bucIsoDay.format(Date.now()) ? ' (' + bucDay.format(Date.parse(U.date + 'T12:00:00Z')) + ')' : '';
    $('logSessHint').textContent = c
      ? 'Checked against the ' + (c.day ? 'day bias' : (logSess === 'london' ? 'London' : 'New York') + ' call') + when + ': ' +
        U3_WORD[c.lean] + (c.conv ? ' (' + c.conv.toLowerCase() + ')' : '')
      : 'No ' + IDX[k].label + ' call published yet: the trade is logged without one.';
  }
  function updateLogUi() {
    var btn = $('logBtn'); if (!btn) return;
    btn.style.display = lastCalc ? '' : 'none';
    if (!lastCalc) $('logForm').style.display = 'none';
    else if ($('logForm').style.display !== 'none') {          // instrument changed with the form open
      btn.style.display = 'none';
      var k = idxOfSym(lastCalc.sym);
      if (k && !logSess) logSess = defaultSession(k);
      updateSessUi();
    }
  }
  function wireLogForm() {
    $('logBtn').addEventListener('click', function () {
      $('logForm').style.display = ''; $('logBtn').style.display = 'none';
      logDir = (lastCalc && lastCalc.dir) || null;          // known from the entry/stop prices
      $('dirLong').classList.toggle('sel', logDir === 'LONG'); $('dirShort').classList.toggle('sel', logDir === 'SHORT');
      var k = lastCalc && idxOfSym(lastCalc.sym);
      logSess = k ? defaultSession(k) : null;
      updateSessUi();
    });
    $('sessLon').addEventListener('click', function () { logSess = 'london'; updateSessUi(); });
    $('sessNy').addEventListener('click', function () { logSess = 'ny'; updateSessUi(); });
    $('dirLong').addEventListener('click', function () { logDir = 'LONG'; $('dirLong').classList.add('sel'); $('dirShort').classList.remove('sel'); });
    $('dirShort').addEventListener('click', function () { logDir = 'SHORT'; $('dirShort').classList.add('sel'); $('dirLong').classList.remove('sel'); });
    $('logCancel').addEventListener('click', function () { $('logForm').style.display = 'none'; updateLogUi(); });
    $('logSave').addEventListener('click', function () {
      if (!lastCalc || !logDir) { $('logSave').textContent = logDir ? 'Save trade' : 'Pick a direction'; return; }
      var s = (DATA.symbols || []).find(function (x) { return x.sym === lastCalc.sym; });
      var ixk = idxOfSym(lastCalc.sym);
      if (!s && ixk) s = sessionCall(ixk, logSess || defaultSession(ixk));   // the session's call
      var trade = {
        ts: new Date().toISOString(), sym: lastCalc.sym, dir: logDir,
        lots: lastCalc.lots, riskAmt: lastCalc.riskAmt, riskCcy: lastCalc.dep, sl: lastCalc.sl,
        biasAtEntry: s ? s.bias : null, convAtEntry: s ? s.conv : null,
        align: alignOf(s ? s.bias : null, logDir), status: 'open',
        note: ($('logNote').value || '').slice(0, 140)
      };
      if (ixk) trade.session = logSess || defaultSession(ixk);
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
      // single-leg instruments (indices: US30 CFD/MYM/YM count as one 'US30')
      var ik = idxOfSym(t.sym);
      var single = COMMODITY_LEG[t.sym] || (ik ? IDX[ik].label : t.sym.indexOf('/') < 0 ? t.sym : null);
      if (single) {
        var cc = single;
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
        '<div class="jmeta">' + new Date(t.ts).toLocaleDateString('en-GB', { timeZone: BUC_TZ }) + sessTxt(t) + ' · SL ' + esc(t.sl || '—') +
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
        '<div class="jmeta">' + new Date(t.ts).toLocaleDateString('en-GB', { timeZone: BUC_TZ }) + ' → ' + (t.closedTs ? new Date(t.closedTs).toLocaleDateString('en-GB', { timeZone: BUC_TZ }) : '') + sessTxt(t) +
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

  var jhistOpen = false;
  $('jhistHdr').addEventListener('click', function () {
    jhistOpen = !jhistOpen;
    $('jhist').style.display = jhistOpen ? '' : 'none';
    $('jhistChev').classList.toggle('open', jhistOpen);
  });

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
  var APP_VERSION = 'v40';
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
      setupPush();
      loadJournal();            // shared journal -> book, stats, Today banner
      fetchHistory();           // warm the bias-history cache
    });
    // poll for a fresh report
    setInterval(function () { fetchData(true); }, (CFG.dataPollMs) || 300000);
    // also re-check when returning to the app
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchData(true);
    });
  }

  /* ---- start ---- */
  if (isUnlocked()) { unlock(); } else { setTimeout(function () { $('pin').focus(); }, 300); }
})();
