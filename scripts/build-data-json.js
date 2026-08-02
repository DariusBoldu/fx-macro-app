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

const ROOT = path.resolve(__dirname, '..', '..');           // .../Trading forex
const DATA_JS = path.join(ROOT, 'Forex_Dashboard', 'data.js');
const OUT = path.resolve(__dirname, '..', 'data.json');

function main() {
  const src = fs.readFileSync(DATA_JS, 'utf8');

  // Evaluate data.js in a tiny sandbox that provides `window`.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js', timeout: 5000 });

  const FX = sandbox.window.FX_DATA;
  if (!FX || !FX.meta || !Array.isArray(FX.symbols)) {
    throw new Error('data.js did not set a valid window.FX_DATA');
  }

  // Sanity checks that keep the analyst standard intact (8 ccys incl CHF since 2026-07-28).
  let prevData = null;
  try { prevData = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}

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

  // ratePaths: carry forward if a run omits them (stale expectations beat none — warned)
  if (!FX.ratePaths || !Object.keys(FX.ratePaths).length) {
    FX.ratePaths = (prevData && prevData.ratePaths) || {};
    if (Object.keys(FX.ratePaths).length) console.warn('WARNING: data.js has no ratePaths — carried forward from the previous publish.');
  }
  // Universe is 34: 28 pairs (the complete G10 matrix excluding SEK/NOK) + DXY +
  // JPYBASKET + GER40 + XAU/USD + XAG/USD + USOIL. Transition safety: carry forward any
  // missing commodity or CHF-pair entries from the last publish, loudly.
  const CARRYABLE = ['XAU/USD', 'XAG/USD', 'USOIL',
    'USD/CHF', 'EUR/CHF', 'GBP/CHF', 'CAD/CHF', 'NZD/CHF', 'AUD/CHF', 'CHF/JPY',
    'EUR/GBP', 'EUR/CAD', 'GBP/CAD'];
  const have = new Set(FX.symbols.map((s) => s.sym));
  const missing = CARRYABLE.filter((c) => !have.has(c));
  if (missing.length) {
    let prev = {};
    ((prevData && prevData.symbols) || []).forEach((s) => { prev[s.sym] = s; });
    missing.forEach((c) => { if (prev[c]) FX.symbols.push(prev[c]); });
    console.warn('WARNING: data.js is missing ' + missing.join(', ') +
      ' — carried forward from the previous data.json. Update the daily task to analyse all 34 symbols.');
  }
  if (FX.symbols.length !== 34) {
    throw new Error('symbols[] must be 34 (28 pairs = full G10 ex SEK/NOK + DXY + JPYBASKET + GER40 + XAU/USD + XAG/USD + USOIL), got: ' + FX.symbols.length);
  }

  // macro pillars (Inflation/Growth/Labour per ccy) for the app's Macro tab.
  // Carry forward the last-published block if a task run hasn't produced one yet,
  // so the Macro page never goes blank between the seed and the task update.
  let macro = FX.macro;
  if (!macro || !Object.keys(macro).length) {
    try { macro = (JSON.parse(fs.readFileSync(OUT, 'utf8')).macro) || {}; } catch (e) { macro = {}; }
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
    // The app reads this for "last updated" and the push trigger.
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Wrote ' + OUT);
  console.log('  reportDate : ' + out.meta.reportDate);
  console.log('  symbols    : ' + out.symbols.length);
  console.log('  updatedAt  : ' + out.updatedAt);

  writeHistory(out);
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
  rebuildSummary(HIST);
  console.log('  history    : ' + out.meta.reportDate + '.json + summary.json');
}

function rebuildSummary(HIST) {
  const dates = fs.readdirSync(HIST)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10)).sort();
  const symbols = {}, strength = {};
  for (const d of dates) {
    let snap;
    try { snap = JSON.parse(fs.readFileSync(path.join(HIST, d + '.json'), 'utf8')); } catch (e) { continue; }
    (snap.symbols || []).forEach((s) => {
      (symbols[s.sym] = symbols[s.sym] || []).push({ d: d, bias: s.bias, conv: s.conv });
    });
    (snap.strength || []).forEach((c) => {
      (strength[c.ccy] = strength[c.ccy] || []).push({ d: d, score: c.score });
    });
  }
  fs.writeFileSync(path.join(HIST, 'summary.json'),
    JSON.stringify({ dates: dates, symbols: symbols, strength: strength }) + '\n', 'utf8');
}

main();
