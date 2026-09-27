#!/usr/bin/env node
/*
 * bias-check.mjs — did the published biases actually pay?
 * ---------------------------------------------------------------------------
 *   node scripts/bias-check.mjs [--symbols EUR/USD,GBP/USD] [--since 2026-09-17]
 *
 * Every published report is archived in history/<date>.json with the biases AND
 * the exact publish time (updatedAt). This scores each published bias over the
 * window it was actually live — from when it was published until the next report
 * replaced it — against hourly prices from Twelve Data (the key already in
 * config.js, free tier).
 *
 * SCORING
 *   LONG   correct if the move over the window is above +band
 *   SHORT  correct if below -band
 *   RANGE  correct if it stayed inside +/-band
 * `band` is per-pair and data-driven: 0.35 x that pair's mean absolute window
 * move in the sample. A fixed threshold would flatter the yen pairs and punish
 * the euro ones; this asks "did it move meaningfully for THIS pair".
 *
 * WHAT THIS IS NOT: the app calls 4H swing biases, not 24-hour bets. There are no
 * entries, stops, targets or spreads here, and a bias that was right two days
 * later still scores as wrong in its own window. Read it as a directional sanity
 * check on a small sample, not a P&L.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(REPO, 'history');
const MIN_BARS = 4;            // fewer than this in a window = market shut (weekend)
const BAND_FACTOR = 0.35;      // share of the pair's mean move that counts as "flat"

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SYMBOLS = arg('symbols', 'EUR/USD,GBP/USD,USD/JPY,USD/CAD,AUD/USD,NZD/USD,XAU/USD').split(',');
const SINCE = arg('since', '2026-09-17');
// Default: score each bias until the next report replaced it. --hours N instead
// scores a fixed N TRADING hours from publication, which is closer to how a 4H
// swing position is actually held across a couple of sessions.
const HOURS = arg('hours', null) ? Number(arg('hours', null)) : null;
const MIN_TRADING_H = 6;       // a window with less market time than this proves nothing

/* FX trades Sunday 21:00Z to Friday 21:00Z. Scoring a bias across a shut market
 * counts as a miss for every directional call and flatters every RANGE call, so
 * weekend time is excluded everywhere: from window length, from the horizon
 * count, and from the sample. */
function tradingHours(a, b) {
  let h = 0;
  for (let t = Math.ceil(a / 3600000) * 3600000; t <= b; t += 3600000) {
    const d = new Date(t), day = d.getUTCDay(), hr = d.getUTCHours();
    const shut = day === 6 || (day === 5 && hr >= 21) || (day === 0 && hr < 21);
    if (!shut) h++;
  }
  return h;
}

function apiKey() {
  const src = fs.readFileSync(path.join(REPO, 'config.js'), 'utf8');
  const m = src.match(/apiKey\s*:\s*["']([a-z0-9]+)["']/i);
  if (!m) throw new Error('no Twelve Data apiKey in config.js');
  return m[1];
}

/* Each archived report: when it went live, and what it claimed. */
function snapshots() {
  return fs.readdirSync(HIST)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= SINCE)
    .sort()
    .map((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(HIST, f), 'utf8'));
      const biases = {};
      (d.symbols || []).forEach((s) => { biases[s.sym] = { bias: s.bias, conv: String(s.conv || '').toUpperCase() }; });
      return { date: f.slice(0, 10), at: Date.parse(d.updatedAt), biases };
    })
    .filter((s) => !isNaN(s.at))
    .sort((a, b) => a.at - b.at);
}

async function series(symbol, key, startMs) {
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(symbol) +
    '&interval=1h&outputsize=5000&timezone=UTC&apikey=' + key;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status === 'error') throw new Error(symbol + ': ' + j.message);
  return (j.values || [])
    .map((v) => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), close: parseFloat(v.close) }))
    .filter((b) => !isNaN(b.t) && b.t >= startMs - 6 * 3600000)
    .sort((a, b) => a.t - b.t);
}

const priceAt = (bars, ms) => { let p = null; for (const b of bars) { if (b.t <= ms) p = b; else break; } return p; };
const countBars = (bars, a, b) => bars.filter((x) => x.t > a && x.t <= b).length;
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

(async function main() {
  const key = apiKey();
  const snaps = snapshots();
  if (snaps.length < 2) { console.error('need at least two archived reports since ' + SINCE); process.exit(1); }
  console.log('Bias check — ' + snaps.length + ' reports, ' + snaps[0].date + ' to ' + snaps[snaps.length - 1].date +
    '\nEach bias is scored over the window it was live: from its publish time to the next report.\n');

  const overall = { hit: 0, miss: 0, skipped: 0, edge: [], signRight: 0, signWrong: 0 };
  const byConv = {};
  let first = true;
  for (const sym of SYMBOLS) {
    // Twelve Data's free tier allows 8 requests a minute; pace them or later
    // symbols come back as errors and quietly drop out of the sample.
    if (!first) await new Promise((r) => setTimeout(r, 9000));
    first = false;
    let bars;
    try { bars = await series(sym, key, snaps[0].at); }
    catch (e) { console.log(sym.padEnd(9) + '  price data unavailable (' + e.message + ')\n'); continue; }

    // window moves first, so the "meaningful move" band is that pair's own scale
    const windows = [];
    for (let i = 0; i < snaps.length - 1; i++) {
      const s = snaps[i], b = s.biases[sym];
      if (!b) continue;
      // End of the window: the next report, or a fixed number of trading hours.
      let end = snaps[i + 1].at;
      if (HOURS) {
        end = s.at;
        for (let h = 0; h < HOURS * 3; h++) {          // walk forward, counting trading hours only
          end += 3600000;
          if (tradingHours(end - 3600000, end) === 0) continue;
          if (tradingHours(s.at, end) >= HOURS) break;
        }
      }
      const th = tradingHours(s.at, end);
      const entry = priceAt(bars, s.at), exit = priceAt(bars, end);
      const n = countBars(bars, s.at, end);
      if (th < MIN_TRADING_H) { windows.push({ s, b, skip: 'published into the weekend (' + th + 'h of market time)' }); continue; }
      if (!entry || !exit || n < MIN_BARS) { windows.push({ s, b, skip: 'no price data' }); continue; }
      windows.push({ s, b, ret: (exit.close - entry.close) / entry.close * 100, entry: entry.close, exit: exit.close, bars: n, th });
    }
    const live = windows.filter((w) => !w.skip);
    if (!live.length) { console.log(sym.padEnd(9) + '  no scoreable windows\n'); continue; }
    const band = BAND_FACTOR * (live.reduce((a, w) => a + Math.abs(w.ret), 0) / live.length);

    let hit = 0, miss = 0;
    const sign = { right: 0, wrong: 0 };
    const lines = [];
    for (const w of windows) {
      if (w.skip) { overall.skipped++; lines.push('   ' + w.s.date + '  ' + w.b.bias.padEnd(5) + ' ' + w.b.conv.padEnd(7) + '  — ' + w.skip); continue; }
      const ok = w.b.bias === 'LONG' ? w.ret > band : w.b.bias === 'SHORT' ? w.ret < -band : Math.abs(w.ret) <= band;
      ok ? hit++ : miss++;
      ok ? overall.hit++ : overall.miss++;
      const edge = w.b.bias === 'LONG' ? w.ret : w.b.bias === 'SHORT' ? -w.ret : null;
      if (edge !== null) {
        overall.edge.push(edge);
        // Direction only, ignoring the flat band: a +0.05% move on a LONG call is
        // not a "meaningful" hit but it is not a wrong call either.
        edge > 0 ? (sign.right++, overall.signRight++) : (sign.wrong++, overall.signWrong++);
      }
      const c = w.b.conv.replace('MEDIUM', 'MED');
      byConv[c] = byConv[c] || { hit: 0, miss: 0 };
      ok ? byConv[c].hit++ : byConv[c].miss++;
      lines.push('   ' + w.s.date + '  ' + w.b.bias.padEnd(5) + ' ' + c.padEnd(7) + '  moved ' + pct(w.ret).padStart(7) +
        '  ' + (ok ? 'HIT ' : 'miss') + '   ' + w.entry + ' -> ' + w.exit);
    }
    const total = hit + miss;
    const sd = sign.right + sign.wrong;
    console.log(sym.padEnd(9) + '  ' + hit + '/' + total + ' meaningful hits' +
      (total ? ' (' + Math.round(hit / total * 100) + '%)' : '') +
      (sd ? '   |   right direction ' + sign.right + '/' + sd + ' (' + Math.round(sign.right / sd * 100) + '%)' : '') +
      '   |   flat band +/-' + band.toFixed(2) + '%');
    lines.forEach((l) => console.log(l));
    console.log('');
  }

  const t = overall.hit + overall.miss;
  const avgEdge = overall.edge.length ? overall.edge.reduce((a, b) => a + b, 0) / overall.edge.length : 0;
  console.log('TOTAL  ' + overall.hit + '/' + t + ' correct (' + (t ? Math.round(overall.hit / t * 100) : 0) + '%)' +
    ',  ' + overall.skipped + ' windows skipped (market shut)');
  const sd = overall.signRight + overall.signWrong;
  console.log('Right direction, ignoring the flat band: ' + overall.signRight + '/' + sd +
    ' (' + (sd ? Math.round(overall.signRight / sd * 100) : 0) + '%)');
  console.log('Average move in the direction called, per directional call: ' + pct(avgEdge) +
    '  (' + overall.edge.length + ' LONG/SHORT calls; RANGE calls excluded)');
  const convOrder = ['HIGH', 'MED', 'LOW-MED', 'LOW'];
  console.log('By conviction: ' + convOrder.filter((c) => byConv[c])
    .map((c) => c + ' ' + byConv[c].hit + '/' + (byConv[c].hit + byConv[c].miss)).join('   '));
})();
