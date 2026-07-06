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

  // Sanity checks that keep the analyst standard intact.
  const ccys = FX.strength.map((c) => c.ccy).sort().join(',');
  const expected = ['AUD', 'CAD', 'EUR', 'GBP', 'JPY', 'NZD', 'USD'].join(',');
  if (ccys !== expected) {
    throw new Error('strength[] must be exactly the 7 currencies, got: ' + ccys);
  }
  // Universe is 24: 18 pairs + DXY + JPYBASKET + GER40 + XAU/USD + XAG/USD + USOIL.
  // Transition safety: if a task run still emits the old 21 (no commodities),
  // carry the 3 commodity entries forward from the last publish instead of
  // failing the whole pipeline — and warn loudly so the run report shows it.
  const COMMODITIES = ['XAU/USD', 'XAG/USD', 'USOIL'];
  const have = new Set(FX.symbols.map((s) => s.sym));
  const missingComms = COMMODITIES.filter((c) => !have.has(c));
  if (missingComms.length) {
    let prev = {};
    try {
      (JSON.parse(fs.readFileSync(OUT, 'utf8')).symbols || []).forEach((s) => { prev[s.sym] = s; });
    } catch (e) { /* no previous publish */ }
    missingComms.forEach((c) => { if (prev[c]) FX.symbols.push(prev[c]); });
    console.warn('WARNING: data.js is missing ' + missingComms.join(', ') +
      ' — carried forward from the previous data.json. Update the daily task to analyse all 24 symbols.');
  }
  if (FX.symbols.length !== 24) {
    throw new Error('symbols[] must be 24 (18 pairs + DXY + JPYBASKET + GER40 + XAU/USD + XAG/USD + USOIL), got: ' + FX.symbols.length);
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
