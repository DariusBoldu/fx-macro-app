#!/usr/bin/env node
/*
 * build-data-json.js
 * ------------------
 * Single source of truth bridge: reads the desktop dashboard's data.js
 * (window.FX_DATA = {...}) and emits the PWA's data.json with the SAME shape,
 * plus an `updatedAt` ISO timestamp the app uses for "last updated" and as the
 * Web-Push trigger (a changed timestamp => a new report => fire a notification).
 *
 * The existing daily Cowork task already regenerates Forex_Dashboard/data.js.
 * Add a call to this script at the end of that task so the app stays in sync:
 *
 *     node fx-macro-app/scripts/build-data-json.js
 *
 * No third-party deps — runs on plain Node.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ROOT = path.resolve(REPO, '..');                     // .../Trading forex on the Mac
/* Paths are overridable (added 2026-09-14 for the cloud routine):
 *   FX_DATA_JS       source data.js. Default: ../Forex_Dashboard/data.js when it
 *                    exists (Mac / Cowork layout), otherwise <repo>/source/data.js
 *                    (a cloud clone has no parent Forex_Dashboard folder).
 *   FX_OUT           data.json to write. Default: <repo>/data.json.
 *   FX_NO_HISTORY=1  skip history/ — shadow builds must not touch the live archive. */
const LEGACY_DATA_JS = path.join(ROOT, 'Forex_Dashboard', 'data.js');
const DATA_JS = process.env.FX_DATA_JS ? path.resolve(process.env.FX_DATA_JS)
  : (fs.existsSync(LEGACY_DATA_JS) ? LEGACY_DATA_JS : path.join(REPO, 'source', 'data.js'));
const OUT = process.env.FX_OUT ? path.resolve(process.env.FX_OUT) : path.join(REPO, 'data.json');

/* ---- degraded-mount safety (added 2026-08-28) ------------------------------
 * When this runs inside the Cowork Linux sandbox, the connected-folder mount can
 * enter a state where files that already exist on the host are unreadable:
 * every read returns EDEADLK ("Resource deadlock avoided", errno -35) while
 * stat/readdir still succeed and freshly written files read fine.
 *
 * That failure mode is dangerous here, because rebuildSummary() used to swallow
 * per-file read errors and would happily rewrite history/summary.json from zero
 * readable snapshots — silently destroying months of history. Reads now retry,
 * and the summary is never rewritten from an incomplete set. */
const TRANSIENT = new Set(['EDEADLK', 'EDEADLOCK', 'EAGAIN', 'EBUSY']);
function isTransient(e) {
  return e && (TRANSIENT.has(e.code) || e.errno === -35 || /deadlock/i.test(e.message || ''));
}
function readWithRetry(file, tries) {
  tries = tries || 4;
  let last;
  for (let i = 0; i < tries; i++) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
      last = e;
      if (!isTransient(e)) throw e;
      // crude sync backoff — no deps, and this script is not latency sensitive
      const until = Date.now() + 250 * (i + 1);
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw last;
}

/* Build the published payload from data.js.
 * `prevData` is the previously published data.json, used only for carry-forward.
 * It is passed IN (rather than read here) so the degraded-mount fallback can
 * supply the copy fetched from GitHub over HTTPS — see scripts/publish-api.js.
 * Both publish paths therefore share one implementation of the validation. */
function buildPayload(prevData) {
  const src = readWithRetry(DATA_JS);

  // Evaluate data.js in a tiny sandbox that provides `window`.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js', timeout: 5000 });

  const FX = sandbox.window.FX_DATA;
  if (!FX || !FX.meta || !Array.isArray(FX.symbols)) {
    throw new Error('data.js did not set a valid window.FX_DATA');
  }

  // Sanity checks that keep the analyst standard intact (8 ccys incl CHF since 2026-07-28).
  const ccys = FX.strength.map((c) => c.ccy).sort().join(',');
  const expected8 = ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD'].join(',');
  const expected7 = ['AUD', 'CAD', 'EUR', 'GBP', 'JPY', 'NZD', 'USD'].join(',');
  if (ccys === expected7 && prevData) {
    // transition: a task run without CHF yet — carry CHF pieces forward, loudly
    console.warn('WARNING: data.js has no CHF — carrying CHF strength/today/macro/ratePaths forward from the previous publish. Update the daily task to cover all 8 currencies.');
    const prevChfS = (prevData.strength || []).find((c) => c.ccy === 'CHF');
    if (prevChfS) FX.strength.splice(FX.strength.length - 1, 0, prevChfS);
    const prevChfT = (prevData.today || []).find((c) => c.ccy === 'CHF');
    if (prevChfT && Array.isArray(FX.today)) FX.today.push(prevChfT);
    if (prevData.macro && prevData.macro.CHF) { FX.macro = FX.macro || {}; FX.macro.CHF = prevData.macro.CHF; }
    if (prevData.ratePaths && prevData.ratePaths.CHF) { FX.ratePaths = FX.ratePaths || {}; FX.ratePaths.CHF = prevData.ratePaths.CHF; }
  } else if (ccys !== expected8) {
    throw new Error('strength[] must be exactly the 8 currencies (incl CHF), got: ' + ccys);
  }

  // meta.reportLabel is the app's sticky-header line AND the push-notification
  // body. Reports drifted to 2,805 characters by 2026-09-23 and covered the whole
  // phone screen (fixed in the app at v29, but the contract is one short sentence).
  const labelLen = String((FX.meta && FX.meta.reportLabel) || '').length;
  if (labelLen > 400) {
    console.warn('WARNING: meta.reportLabel is ' + labelLen + ' characters. It is the header line and the ' +
      'notification body: keep it to ONE sentence (~200 chars) and put the narrative in dailyRead.');
  }

  // meta.nextEvent drives the structured "Next big event" card (v32). The app
  // falls back to building the card from catalysts[] when it is absent or stale,
  // so a bad block only warns.
  const ne = FX.meta && FX.meta.nextEvent;
  if (!ne) {
    console.warn('WARNING: meta.nextEvent is missing — the app will build the Next big event card from catalysts[] without figures or scenarios.');
  } else {
    const probs = [];
    if (!ne.event || String(ne.event).length > 60) probs.push('event must be a short name (<= 60 chars)');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(String(ne.when || ''))) probs.push('when must be ISO 8601 UTC like 2026-11-12T07:00:00Z');
    if (!['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'].includes(ne.ccy)) probs.push('ccy must be one of the 8 currencies');
    if (ne.figures != null && (!Array.isArray(ne.figures) || ne.figures.length > 4)) probs.push('figures must be an array of at most 4 { label, forecast, previous }');
    if (String(ne.why || '').length > 300) probs.push('why is ' + String(ne.why).length + ' chars (max ~240)');
    if (ne.scenarios != null && (!Array.isArray(ne.scenarios) || ne.scenarios.length > 3 ||
        ne.scenarios.some((s) => !s || !s.if || !s.then))) probs.push('scenarios must be at most 3 { if, then }');
    if (probs.length) console.warn('WARNING: meta.nextEvent: ' + probs.join('; ') + '.');
  }

  // us30 drives the US30 intraday tab (v34; NAS100 was removed in v40): written by
  // the 08:00 report (stage london), then the London update 40 min before the
  // London open (london-update), the midday update at 14:00 Bucharest (midday) and
  // the NY update 40 min before the cash open (ny). Prices are BlackBull Markets'
  // US30 CFD (the chart Darius trades). Each session is a LEVEL MAP (v40): a long
  // and a short side { zone: [lo, hi], entry, t1, t2?, stop } plus `at` (when the
  // map was written), which the Worker follows live on the 5-minute candles. The
  // Worker scores sessions.london/ny.lean, so a malformed block warns loudly.
  // Carried forward when a run omits it (the app marks an old date as not today's).
  const indexBlock = (name) => {
    let ix = FX[name];
    if (!ix) {
      ix = prevData && prevData[name];
      if (ix) console.warn('WARNING: data.js has no ' + name + ' block — carried forward from the previous publish (date ' + ix.date + ').');
      return ix;
    }
    const p = [], LEAN = ['BULLISH', 'BEARISH', 'RANGE'], CONV = ['high', 'medium', 'low'];
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
    const len = (v) => String(v == null ? '' : v).length;
    const num = (v) => typeof v === 'number' && isFinite(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ix.date || ''))) p.push('date must be YYYY-MM-DD');
    if (!['london', 'london-update', 'midday', 'ny'].includes(ix.stage)) p.push("stage must be 'london', 'london-update', 'midday' or 'ny'");
    if (!ISO.test(String(ix.updatedAt || ''))) p.push('updatedAt must be ISO 8601 UTC');
    if (!LEAN.includes(ix.bias)) p.push('bias must be BULLISH|BEARISH|RANGE');
    if (!CONV.includes(ix.conviction)) p.push('conviction must be high|medium|low');
    if (!['trend', 'range', 'news'].includes(ix.dayType)) p.push('dayType must be trend|range|news');
    if (!ix.headline || len(ix.headline) > 170) p.push('headline must be one sentence (<= 140 chars), got ' + len(ix.headline));
    const ref = ix.ref && num(ix.ref.price) ? ix.ref.price : null;
    const side = (k, dir, x) => {
      const pre = 'sessions.' + k + '.' + dir;
      if (!x || !Array.isArray(x.zone) || x.zone.length !== 2 || !x.zone.every(num) || x.zone[0] > x.zone[1]) return p.push(pre + '.zone must be [low, high] numbers');
      if (!num(x.t1) || !num(x.stop) || (x.t2 != null && !num(x.t2))) return p.push(pre + ' needs numeric t1 and stop (t2 optional)');
      const [lo, hi] = x.zone, L = dir === 'long';
      const ok = L ? x.stop < lo && x.t1 > hi && (x.t2 == null || x.t2 > x.t1) : x.stop > hi && x.t1 < lo && (x.t2 == null || x.t2 < x.t1);
      if (!ok) p.push(pre + (L ? ' must be stop < zone < t1 < t2' : ' must be stop > zone > t1 > t2'));
      if (!x.entry || len(x.entry) > 160) p.push(pre + '.entry must say the 5-minute trigger inside the zone (<= 140 chars)');
      if (ref != null && ref >= lo && ref <= hi) p.push(pre + '.zone contains ref.price ' + ref + ': a zone price is already in when the map is written plays out before Darius reads it');
    };
    const S = ix.sessions || {};
    ['london', 'ny'].forEach((k) => {
      const x = S[k];
      if (!x) { p.push('sessions.' + k + ' is missing'); return; }
      if (!LEAN.includes(x.lean)) p.push('sessions.' + k + '.lean must be BULLISH|BEARISH|RANGE (the Worker scores it)');
      if (x.conviction && !CONV.includes(x.conviction)) p.push('sessions.' + k + '.conviction must be high|medium|low');
      if (len(x.plan) > 240) p.push('sessions.' + k + '.plan is ' + len(x.plan) + ' chars (max ~200)');
      if (!x.invalid || len(x.invalid) > 110) p.push('sessions.' + k + '.invalid must be a level (<= 90 chars)');
      if (!ISO.test(String(x.at || ''))) p.push('sessions.' + k + '.at must be the ISO UTC time this map was written');
      if (!x.long || !x.short) p.push('sessions.' + k + ' needs both sides of the level map (long and short)');
      if (x.long) side(k, 'long', x.long);
      if (x.short) side(k, 'short', x.short);
      if (x.wait != null && len(x.wait) > 170) p.push('sessions.' + k + '.wait is ' + len(x.wait) + ' chars (max ~140)');
      // the midday check on a live session (v39): how the published plan is doing
      if (x.check != null && (!['on-track', 'target-hit', 'invalidated', 'not-triggered'].includes(x.check.status) ||
          !ISO.test(String(x.check.at || '')) || !x.check.note || len(x.check.note) > 170)) {
        p.push('sessions.' + k + '.check must be { at: ISO UTC, status: on-track|target-hit|invalidated|not-triggered, note (<= 140 chars) }');
      }
    });
    const arr = (v, max) => Array.isArray(v) && v.length <= max;
    if (!arr(ix.drivers, 6) || ix.drivers.some((d) => !d || !d.k || ![1, 0, -1].includes(d.s))) p.push('drivers must be at most 6 { k, v, s: 1|0|-1 }');
    if (!arr(ix.levels, 8) || ix.levels.some((l) => !l || !l.name || typeof l.v !== 'number')) p.push('levels must be at most 8 { name, v: number, note }');
    if (ix.scenarios != null && (!arr(ix.scenarios, 3) || ix.scenarios.some((x) => !x || !x.if || !x.then))) p.push('scenarios must be at most 3 { if, then }');
    if (ix.events != null && (!arr(ix.events, 8) || ix.events.some((e) => !e || !e.what || (e.when != null && !ISO.test(String(e.when))) ||
        !['data', 'fed', 'earnings'].includes(e.kind)))) p.push('events must be at most 8 { when: ISO UTC or null, what, kind: data|fed|earnings }');
    if (ix.ref != null && (typeof ix.ref.price !== 'number' || !ISO.test(String(ix.ref.at || '')))) p.push('ref must be { price: number, at: ISO UTC }');
    if (p.length) console.warn('WARNING: ' + name + ': ' + p.join('; ') + '.');
    return ix;
  };
  const us30 = indexBlock('us30');

  // ratePaths: carry forward if a run omits them (stale expectations beat none — warned)
  if (!FX.ratePaths || !Object.keys(FX.ratePaths).length) {
    FX.ratePaths = (prevData && prevData.ratePaths) || {};
    if (Object.keys(FX.ratePaths).length) console.warn('WARNING: data.js has no ratePaths — carried forward from the previous publish.');
  }
  // Universe is 35: 28 pairs (the complete G10 matrix excluding SEK/NOK) + DXY +
  // JPYBASKET + GER40 + XAU/USD + XAG/USD + XCU/USD + USOIL. Transition safety: carry forward any
  // missing commodity or CHF-pair entries from the last publish, loudly.
  const CARRYABLE = ['XAU/USD', 'XAG/USD', 'XCU/USD', 'USOIL', 'EU50',
    'USD/CHF', 'EUR/CHF', 'GBP/CHF', 'CAD/CHF', 'NZD/CHF', 'AUD/CHF', 'CHF/JPY',
    'EUR/GBP', 'EUR/CAD', 'GBP/CAD'];
  const have = new Set(FX.symbols.map((s) => s.sym));
  const missing = CARRYABLE.filter((c) => !have.has(c));
  if (missing.length) {
    let prev = {};
    ((prevData && prevData.symbols) || []).forEach((s) => { prev[s.sym] = s; });
    missing.forEach((c) => { if (prev[c]) FX.symbols.push(prev[c]); });
    console.warn('WARNING: data.js is missing ' + missing.join(', ') +
      ' — carried forward from the previous data.json. Update the daily task to analyse all 35 symbols.');
  }
  if (FX.symbols.length !== 36) {
    throw new Error('symbols[] must be 36 (28 pairs = full G10 ex SEK/NOK + DXY + JPYBASKET + GER40 + EU50 + XAU/USD + XAG/USD + XCU/USD + USOIL), got: ' + FX.symbols.length);
  }

  // macro pillars (Inflation/Growth/Labour per ccy) for the app's Macro tab.
  // Carry forward the last-published block if a task run hasn't produced one yet,
  // so the Macro page never goes blank between the seed and the task update.
  let macro = FX.macro;
  if (!macro || !Object.keys(macro).length) {
    macro = (prevData && prevData.macro) || {};
    if (Object.keys(macro).length) console.warn('WARNING: data.js has no macro block — carried forward from the previous publish.');
  }

  const out = {
    meta: FX.meta,
    dailyRead: FX.dailyRead,
    // per-currency daily read (movers first). Optional: if a run omits it the
    // app falls back to the classic prose layout — no carry-forward on purpose
    // (a stale "today" is worse than none).
    today: Array.isArray(FX.today) ? FX.today : undefined,
    // structured world snapshot for the top of Today (no carry-forward — the
    // app falls back to meta.regime prose if absent)
    snapshot: Array.isArray(FX.snapshot) ? FX.snapshot : undefined,
    // central-bank rate paths (SOURCE: TradingEconomics) for the Rates tab
    ratePaths: FX.ratePaths && Object.keys(FX.ratePaths).length ? FX.ratePaths : undefined,
    strength: FX.strength,
    symbols: FX.symbols,
    macro: macro,
    catalysts: FX.catalysts,
    geopolitics: FX.geopolitics,
    // US30 intraday bias and level map (BlackBull US30 CFD) for the US30 tab
    us30: us30 || undefined,
    // The app reads this for "last updated" and the push trigger.
    updatedAt: new Date().toISOString(),
  };
  return out;
}

function main() {
  let prevData = null;
  try { prevData = JSON.parse(readWithRetry(OUT)); } catch (e) {}
  const out = buildPayload(prevData);

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Wrote ' + OUT);
  console.log('  reportDate : ' + out.meta.reportDate);
  console.log('  symbols    : ' + out.symbols.length);
  console.log('  updatedAt  : ' + out.updatedAt);

  if (process.env.FX_NO_HISTORY === '1') console.log('  history    : skipped (FX_NO_HISTORY=1)');
  else writeHistory(out);
}

/* ---- History archive ------------------------------------------------------
 * history/<reportDate>.json  — full snapshot, one per report date (same-day
 *                              refreshes overwrite, keeping the day's latest)
 * history/summary.json       — compact timelines the app actually fetches:
 *                              per-symbol {date,bias,conv} and per-ccy scores */
function writeHistory(out) {
  const HIST = path.resolve(__dirname, '..', 'history');
  fs.mkdirSync(HIST, { recursive: true });
  fs.writeFileSync(path.join(HIST, out.meta.reportDate + '.json'),
    JSON.stringify(out, null, 2) + '\n', 'utf8');
  const summaryOk = rebuildSummary(HIST);
  console.log('  history    : ' + out.meta.reportDate + '.json' +
    (summaryOk ? ' + summary.json' : ' (summary.json SKIPPED — see error above)'));
}

function rebuildSummary(HIST) {
  const dates = fs.readdirSync(HIST)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10)).sort();
  const symbols = {}, strength = {};
  const unreadable = [];
  for (const d of dates) {
    let snap;
    try { snap = JSON.parse(readWithRetry(path.join(HIST, d + '.json'))); }
    catch (e) { unreadable.push(d + ' (' + (e.code || e.message) + ')'); continue; }
    (snap.symbols || []).forEach((s) => {
      (symbols[s.sym] = symbols[s.sym] || []).push({ d: d, bias: s.bias, conv: s.conv });
    });
    (snap.strength || []).forEach((c) => {
      (strength[c.ccy] = strength[c.ccy] || []).push({ d: d, score: c.score });
    });
  }

  // NEVER rewrite the summary from an incomplete read of the archive. A single
  // unreadable snapshot means the rebuild would drop that date's timeline
  // permanently, so leave the existing summary.json untouched and say so.
  if (unreadable.length) {
    console.error('ERROR: ' + unreadable.length + ' of ' + dates.length +
      ' history snapshots could not be read — summary.json was NOT rewritten ' +
      '(refusing to truncate the archive).');
    console.error('  first few: ' + unreadable.slice(0, 5).join(', '));
    console.error('  data.json and history/<date>.json are still correct; re-run ' +
      'this script from a shell with direct filesystem access to refresh summary.json.');
    return false;
  }

  fs.writeFileSync(path.join(HIST, 'summary.json'),
    JSON.stringify({ dates: dates, symbols: symbols, strength: strength }) + '\n', 'utf8');
  return true;
}

module.exports = { buildPayload, DATA_JS, OUT };

if (require.main === module) main();
