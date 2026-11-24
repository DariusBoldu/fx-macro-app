/* ============================================================================
 * US30 tracker — feeds the cloud analyst, the app's US30 tab and its track
 * record, and the open alerts.
 *
 * Source (2026-11-23): the chart Darius trades, BlackBull Markets' US30 CFD
 * (BLACKBULL:US30), live from TradingView's chart websocket (./bb.js):
 * 5-minute candles for the session ranges, VWAP and the plan tracker, daily
 * candles for the previous day, ATR, week and month. It replaced the CME YM
 * futures from the public screener, which were 10 minutes late and about 100
 * points away from his chart. If the websocket fails, OANDA's US30 CFD (also
 * live, in the public screener, about 20 points above BlackBull) stands in
 * for the price and the daily levels.
 *
 * The CFD's day opens 18:00 New York like the futures, so:
 *   Asia    18:00 NY (day open)  -> London open    (08:00 London)
 *   London  08:00 London         -> 09:30 New York (cash open)
 *   NY      09:30 New York       -> 16:00 New York (cash close)
 *
 * The analyst writes each session as a LEVEL MAP: a long side and a short side,
 * each with an entry zone, targets and a stop (sessions.<s>.long / .short).
 * sideStatus() follows each side on the 5-minute candles from the moment the
 * map was written, so the app can say "T1 hit 16:42, don't chase" instead of
 * showing a plan the market has already played out. The analyst's session
 * leans are scored deterministically at each window's close (scoreCall), so
 * the track record is not the model grading itself.
 * ==========================================================================*/
import { tvCandles } from './bb.js';

export const US30 = { key: 'us30', label: 'US30', symbol: 'BLACKBULL:US30', feed: 'BlackBull Markets US30 CFD' };
export const FALLBACK = { symbol: 'OANDA:US30USD', feed: 'OANDA US30 CFD', scan: 'https://scanner.tradingview.com/cfd/scan' };

export const LON_TZ = 'Europe/London';
export const NY_TZ = 'America/New_York';
export const BUC_TZ = 'Europe/Bucharest';
const LON_OPEN = 8 * 60;          // 08:00 London
const NY_OPEN = 9 * 60 + 30;      // 09:30 New York
const NY_CLOSE = 16 * 60;         // 16:00 New York
const DAY_OPEN = 18 * 60;         // 18:00 New York, the evening before
export const NY_FIRE_LEAD_MIN = 40;       // NY update fires 40 min before the cash open
export const LONDON_FIRE_LEAD_MIN = 40;   // London update fires 40 min before the London open
const MIDDAY_BUC_MIN = 14 * 60;           // midday update at 14:00 Bucharest...
const MIDDAY_MIN_GAP_MIN = 90;            // ...but at least 90 min before the NY fire (US/EU DST gap weeks)
const BAR_MS = 5 * 60000;

/* NYSE full-day closures: no cash session to call. */
export const US_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

/* ------------------------------ time helpers ------------------------------ */
const FMT = {};
function fmt(tz) {
  return FMT[tz] || (FMT[tz] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }));
}
export function tzParts(ms, tz) {
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute), wd: p.weekday };
}
/* UTC ms of a wall-clock time in a zone (DST-safe, two passes). */
export function zonedMs(date, minOfDay, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, Math.floor(minOfDay / 60), minOfDay % 60);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(t, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, Math.floor(p.min / 60), p.min % 60);
  }
  return t;
}
const BUC_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: BUC_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const bucClock = (ms) => BUC_CLOCK.format(new Date(ms));
const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/* The trading day at `ms`: it opens 18:00 New York the evening before, so
 * shifting by 6 h lands on the right New York date. */
export const tradeDate = (ms) => tzParts(ms + 6 * 3600000, NY_TZ).date;
export function isTradingDay(date) {
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  return wd >= 1 && wd <= 5 && !US_HOLIDAYS.has(date);
}
export function prevTradingDay(date) {
  let d = date;
  for (let i = 0; i < 10; i++) { d = addDays(d, -1); if (isTradingDay(d)) return d; }
  return null;
}
/* The day's boundaries in UTC ms. */
export function sessionTimes(date) {
  return {
    dayOpen: zonedMs(addDays(date, -1), DAY_OPEN, NY_TZ),
    lonOpen: zonedMs(date, LON_OPEN, LON_TZ),
    nyOpen: zonedMs(date, NY_OPEN, NY_TZ),
    nyClose: zonedMs(date, NY_CLOSE, NY_TZ),
  };
}
export function phaseAt(date, ms) {
  const t = sessionTimes(date);
  if (ms < t.lonOpen) return 'asia';
  if (ms < t.nyOpen) return 'london';
  if (ms < t.nyClose) return 'ny';
  return 'after';
}

/* The three intraday analyst updates of a US trading day (Darius, 2026-11-23):
 *   LONDON  40 min before the London open  (09:20 Bucharest)  final London map
 *   MIDDAY  14:00 Bucharest, London live                      London check + NY first look
 *   NY      40 min before the NY cash open (15:50 Bucharest)  final NY map
 * In the weeks when US and EU clocks change on different dates the NY fire is
 * 14:50, so MIDDAY moves to 90 min before it (13:20). `key` is the KV dedupe
 * prefix; NY keeps the key it had before the other two were added. */
export function updateFires(date) {
  const t = sessionTimes(date);
  const ny = t.nyOpen - NY_FIRE_LEAD_MIN * 60000;
  let mid = zonedMs(date, MIDDAY_BUC_MIN, BUC_TZ);
  if (ny - mid < MIDDAY_MIN_GAP_MIN * 60000) mid = ny - MIDDAY_MIN_GAP_MIN * 60000;
  return [
    { kind: 'LONDON', at: t.lonOpen - LONDON_FIRE_LEAD_MIN * 60000, key: 'idxfire:lon:' },
    { kind: 'MIDDAY', at: mid, key: 'idxfire:mid:' },
    { kind: 'NY', at: ny, key: 'us30fire:' },
  ];
}

/* --------------------------------- market --------------------------------- */
const r0 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);

/* o/h/l/c of the candles inside [from, to); c stays null while the window runs. */
function windowOf(bars, from, to, now) {
  const w = bars.filter((b) => b[0] * 1000 >= from && b[0] * 1000 < to);
  if (!w.length || now < from) return null;
  return {
    o: r0(w[0][1]), h: r0(Math.max(...w.map((b) => b[2]))), l: r0(Math.min(...w.map((b) => b[3]))),
    c: now >= to ? r0(w[w.length - 1][4]) : null,
  };
}
/* Wilder's ATR over completed daily candles (oldest first). */
function atrOf(days, n = 14) {
  if (days.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < days.length; i++) {
    const [, , h, l] = days[i], pc = days[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]) / n;
  return atr;
}

/* Everything the tracker, the analyst and the app need, from the candles.
 * `bars` (the 5-minute candles) stays on the object for the plan tracker and
 * is stripped before anything is sent out (publicMarket). */
export function buildMarket(s5, sD, now) {
  if (!s5 || !s5.length) throw new Error('no 5-minute candles');
  const td = tradeDate(now), t = sessionTimes(td);
  const today = s5.filter((b) => b[0] * 1000 >= t.dayOpen);
  const lastBar = s5[s5.length - 1];
  const last = lastBar[4];
  let vw = 0, vv = 0;
  for (const b of today) { const v = b[5] || 0; vw += ((b[2] + b[3] + b[4]) / 3) * v; vv += v; }
  const days = (sD || []).map((b) => ({ b, d: tradeDate(b[0] * 1000) }));
  const done = days.filter((x) => x.d < td).map((x) => x.b);
  const prev = done[done.length - 1] || null;
  const monday = addDays(td, -((new Date(td + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const lastWeek = days.filter((x) => x.d < monday).pop();
  const month = days.filter((x) => x.d >= addDays(td, -30));
  const c15 = [];
  for (const b of s5.slice(-24)) {
    const k = Math.floor(b[0] / 900) * 900, c = c15[c15.length - 1];
    if (c && c.t === k) { c.h = Math.max(c.h, b[2]); c.l = Math.min(c.l, b[3]); c.c = b[4]; }
    else c15.push({ t: k, o: b[1], h: b[2], l: b[3], c: b[4] });
  }
  const asiaW = now >= t.lonOpen ? windowOf(s5, t.dayOpen, t.lonOpen, now) : null;
  return {
    symbol: US30.symbol, feed: US30.feed, source: 'blackbull', delayMin: 0,
    fetchedAt: new Date(now).toISOString(), lastBarAt: new Date(lastBar[0] * 1000).toISOString(),
    last: r0(last),
    dayOpen: today.length ? r0(today[0][1]) : null,
    dayHigh: today.length ? r0(Math.max(...today.map((b) => b[2]))) : null,
    dayLow: today.length ? r0(Math.min(...today.map((b) => b[3]))) : null,
    vwap: vv ? r0(vw / vv) : null,
    atr: r0(atrOf(done.slice(-30))),
    pdh: prev ? r0(prev[2]) : null, pdl: prev ? r0(prev[3]) : null, pdc: prev ? r0(prev[4]) : null,
    chgPct: prev ? +((last / prev[4] - 1) * 100).toFixed(2) : null,
    weekPct: lastWeek ? +((last / lastWeek.b[4] - 1) * 100).toFixed(2) : null,
    monthHigh: month.length ? r0(Math.max(...month.map((x) => x.b[2]))) : null,
    monthLow: month.length ? r0(Math.min(...month.map((x) => x.b[3]))) : null,
    asia: asiaW ? { h: asiaW.h, l: asiaW.l } : null,
    lon: windowOf(s5, t.lonOpen, t.nyOpen, now),
    ny: windowOf(s5, t.nyOpen, t.nyClose, now),
    c15: c15.slice(-8).map((c) => ({ t: new Date(c.t * 1000).toISOString(), o: r0(c.o), h: r0(c.h), l: r0(c.l), c: r0(c.c) })),
    bars: s5,
  };
}
export function publicMarket(mk) {
  if (!mk) return null;
  const { bars, ...rest } = mk;
  return rest;
}

/* OANDA's US30 from the public screener: live price and daily levels only. */
const FB_COLS = ['close', 'open', 'high', 'low', 'high[1]', 'low[1]', 'close[1]', 'ATR', 'Perf.W', 'High.1M', 'Low.1M', 'change'];
export async function fetchFallback(now, fetchImpl = fetch) {
  const r = await fetchImpl(FALLBACK.scan, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: [FALLBACK.symbol] }, columns: FB_COLS }),
  });
  if (!r.ok) throw new Error('screener HTTP ' + r.status);
  const row = ((await r.json()).data || [])[0];
  if (!row || !Array.isArray(row.d)) throw new Error('screener: no ' + FALLBACK.symbol);
  const o = {};
  FB_COLS.forEach((c, i) => { o[c] = row.d[i]; });
  return {
    symbol: FALLBACK.symbol, feed: FALLBACK.feed + ' (BlackBull feed unavailable; OANDA runs about 20 points above BlackBull)',
    source: 'oanda', delayMin: 0, fetchedAt: new Date(now).toISOString(),
    last: r0(o.close), dayOpen: r0(o.open), dayHigh: r0(o.high), dayLow: r0(o.low), vwap: null, atr: r0(o.ATR),
    pdh: r0(o['high[1]']), pdl: r0(o['low[1]']), pdc: r0(o['close[1]']),
    chgPct: typeof o.change === 'number' ? +o.change.toFixed(2) : null,
    weekPct: typeof o['Perf.W'] === 'number' ? +o['Perf.W'].toFixed(2) : null,
    monthHigh: r0(o['High.1M']), monthLow: r0(o['Low.1M']),
    asia: null, lon: null, ny: null, c15: [], bars: null,
  };
}

/* BlackBull first, OANDA if the websocket fails (one retry first). */
export async function fetchMarket(now, opts = {}) {
  let err;
  for (let i = 0; i < 2; i++) {
    try {
      const c = await tvCandles(US30.symbol, [{ id: 's5', tf: '5', n: 600 }, { id: 'sD', tf: '1D', n: 45 }], opts);
      return buildMarket(c.s5, c.sD, now);
    } catch (e) { err = e; }
  }
  const mk = await fetchFallback(now, opts.fetch || fetch);
  mk.error = String((err && err.message) || err).slice(0, 160);
  return mk;
}

/* --------------------------------- scoring --------------------------------- */
/* A directional call is right when the session moved at least 10% of the daily
 * ATR its way, wrong when it moved that much the other way, and "flat" in
 * between (not counted). A RANGE call is right when the session closed within
 * 15% of ATR of where it opened. */
export function scoreCall(call, w, atr) {
  if (!call || !w || w.o == null || w.c == null || !atr) return null;
  const move = w.c - w.o, thr = 0.10 * atr;
  let r;
  if (call === 'RANGE') r = Math.abs(move) < 0.15 * atr ? 'hit' : 'miss';
  else if (call === 'BULLISH') r = move >= thr ? 'hit' : move <= -thr ? 'miss' : 'flat';
  else if (call === 'BEARISH') r = move <= -thr ? 'hit' : move >= thr ? 'miss' : 'flat';
  else return null;
  return { r, move: Math.round(move) };
}
export function summarizeScores(list) {
  const out = { london: { hit: 0, miss: 0, flat: 0 }, ny: { hit: 0, miss: 0, flat: 0 } };
  for (const s of list.slice(0, 20 * 2)) {
    const k = s.s === 'lon' ? 'london' : 'ny';
    if (out[k][s.r] != null) out[k][s.r]++;
  }
  return out;
}

/* ------------------------------ day record ---------------------------------
 * One KV record per day (us30:d:<date>). It is written only when a window opens
 * (open price + the analyst's call) or closes (close + score): the ranges in
 * between come from the candles on demand, which keeps KV writes to a handful
 * a day. `callFor(session)` returns {bias, conviction} or null.
 * Returns { rec, changed, scores, opened: ['london'|'ny'] }. */
export function advanceRecord(rec, mk, now, callFor) {
  const t = sessionTimes(rec.date), LATE = 20 * 60000, phase = phaseAt(rec.date, now);
  const scores = [], opened = [];
  let changed = false;
  if (mk.atr && rec.atr == null) { rec.atr = mk.atr; changed = true; }
  if (rec.pdh == null && mk.pdh != null) { rec.pdh = mk.pdh; rec.pdl = mk.pdl; rec.pdc = mk.pdc; changed = true; }
  if (!rec.asia && mk.asia) { rec.asia = mk.asia; changed = true; }
  if (rec.src !== mk.source) { rec.src = mk.source; changed = true; }
  const open = (key, from) => {
    const w = mk[key];
    const o = w && w.o != null ? w.o : mk.last;
    return { o, h: w ? w.h : o, l: w ? w.l : o, c: null, openedAt: new Date(from).toISOString(), call: callFor(key === 'lon' ? 'london' : 'ny') };
  };
  const close = (key, s) => {
    const w = rec[key], m = mk[key];
    if (m && m.c != null) { w.o = m.o; w.h = m.h; w.l = m.l; w.c = m.c; }   // the whole window from one feed
    else { w.c = mk.last; if (mk.last > w.h) w.h = mk.last; if (mk.last < w.l) w.l = mk.last; }
    const sc = scoreCall(w.call && w.call.bias, w, rec.atr);
    if (sc) { w.score = sc; scores.push(Object.assign({ date: rec.date, s, call: w.call.bias, conv: w.call.conviction || null }, sc)); }
    changed = true;
  };
  if (!rec.lon && phase === 'london' && now - t.lonOpen < LATE) { rec.lon = open('lon', t.lonOpen); opened.push('london'); changed = true; }
  if (rec.lon && rec.lon.c == null && (phase === 'ny' || phase === 'after')) close('lon', 'lon');
  if (!rec.ny && phase === 'ny' && now - t.nyOpen < LATE) { rec.ny = open('ny', t.nyOpen); opened.push('ny'); changed = true; }
  if (rec.ny && rec.ny.c == null && phase === 'after') close('ny', 'ny');
  return { rec, changed, scores, opened };
}
/* Does the record need the market right now? (Avoids a feed call per tick.) */
export function recordDue(rec, now) {
  const t = sessionTimes(rec.date), phase = phaseAt(rec.date, now), LATE = 20 * 60000;
  return (!rec.lon && phase === 'london' && now - t.lonOpen < LATE) ||
    (rec.lon && rec.lon.c == null && (phase === 'ny' || phase === 'after')) ||
    (!rec.ny && phase === 'ny' && now - t.nyOpen < LATE) ||
    (rec.ny && rec.ny.c == null && phase === 'after');
}

/* ------------------------------ level map ----------------------------------
 * A side: { zone: [lo, hi], entry, t1, t2?, stop }.
 *   long:  stop < lo <= hi < t1 < t2      short: stop > hi >= lo > t1 > t2
 * States, followed on the 5-minute candles from the moment the map was written:
 *   waiting  price has not traded in the zone
 *   live     price traded in the zone: the setup is on (look for the 5-min entry)
 *   t1 / t2  a target printed after the zone was entered
 *   stopped  the stop printed after the zone was entered
 *   missed   the market ran to T1 without entering the zone: don't chase
 * Inside one 5-minute candle the order of prices is unknown, so the candle that
 * enters the zone counts the stop only when it came into the zone from the
 * target side (a pullback) or closed beyond the stop. */
export function validSide(s, dir) {
  if (!s || !Array.isArray(s.zone) || s.zone.length !== 2) return false;
  const [lo, hi] = s.zone.map(Number), t1 = Number(s.t1), st = Number(s.stop), t2 = s.t2 == null ? null : Number(s.t2);
  if (![lo, hi, t1, st].every(isFinite) || lo > hi || (t2 != null && !isFinite(t2))) return false;
  return dir === 'long' ? st < lo && t1 > hi && (t2 == null || t2 > t1)
    : st > hi && t1 < lo && (t2 == null || t2 < t1);
}
export function sideStatus(s, dir, bars, fromMs, toMs) {
  const res = { state: 'waiting' };
  if (!validSide(s, dir) || !bars) return res;
  const lo = +s.zone[0], hi = +s.zone[1], t1 = +s.t1, t2 = s.t2 == null ? null : +s.t2, st = +s.stop, L = dir === 'long';
  for (const b of bars) {
    const bt = b[0] * 1000;
    if (bt + BAR_MS <= fromMs || bt >= toMs) continue;
    const t = Math.max(bt, fromMs);        // a candle that straddles the map's time reports that time
    const [, o, h, l, c] = b;
    const hitT1 = L ? h >= t1 : l <= t1, hitT2 = t2 != null && (L ? h >= t2 : l <= t2), hitSt = L ? l <= st : h >= st;
    if (res.state === 'waiting') {
      if (l <= hi && h >= lo) {
        res.state = 'live'; res.liveAt = t;
        const fromTargetSide = L ? o >= lo : o <= hi;
        if (fromTargetSide ? hitSt : (L ? c <= st : c >= st)) { res.state = 'stopped'; res.stopAt = t; }
        else if (hitT1) { res.state = 't1'; res.t1At = t; if (hitT2) { res.state = 't2'; res.t2At = t; } }
      } else if (hitT1) { res.state = 'missed'; res.missedAt = t; }
    } else if (res.state === 'live') {
      if (hitSt) { res.state = 'stopped'; res.stopAt = t; }
      else if (hitT1) { res.state = 't1'; res.t1At = t; if (hitT2) { res.state = 't2'; res.t2At = t; } }
    } else if (res.state === 't1' && hitT2) { res.state = 't2'; res.t2At = t; }
  }
  return res;
}
const SESS = { london: ['lonOpen', 'nyOpen'], ny: ['nyOpen', 'nyClose'] };
/* Status of the published map (data.json us30 block) for both sessions. */
export function planStatus(U, bars, td) {
  if (!U || U.date !== td || !bars) return null;
  const t = sessionTimes(td), out = {};
  for (const k of Object.keys(SESS)) {
    const s = U.sessions && U.sessions[k];
    if (!s || !(validSide(s.long, 'long') || validSide(s.short, 'short'))) continue;
    const at = s.at || U.updatedAt || null;
    let from = Date.parse(at);
    if (!isFinite(from)) from = t[SESS[k][0]] - 40 * 60000;
    const to = t[SESS[k][1]];
    out[k] = { at, open: t[SESS[k][0]], long: sideStatus(s.long, 'long', bars, from, to), short: sideStatus(s.short, 'short', bars, from, to) };
  }
  return out;
}

/* ------------------------------- open alert -------------------------------- */
const fN = (v) => Math.round(Number(v)).toLocaleString('en-US');

/* The push at the London / NY open (v42, simple): the direction expected for the
 * session that is starting and why, in plain words - no levels or prices. */
const DIR = { BULLISH: ['▲', 'Up', 'up'], BEARISH: ['▼', 'Down', 'down'], RANGE: ['↔', 'Sideways', 'sideways'] };
export function openAlert(key, U, ps, price) {
  const s = U && U.sessions && U.sessions[key];
  if (!s || !DIR[s.lean]) return null;
  const d = DIR[s.lean], where = key === 'london' ? 'London' : 'New York';
  const title = `📊 US30 ${key === 'london' ? 'London' : 'NY'} open: ${d[0]} ${d[1]}`;
  const conf = s.conviction ? ` (${String(s.conviction).toLowerCase()} confidence)` : '';
  const why = s.note || (U.headline && !/\b\d{2},\d{3}\b|\b\d{5,}\b/.test(U.headline) ? U.headline : '');
  return { title, body: `Expected for ${where}: ${d[2]}${conf}.${why ? ' ' + why : ''}`.slice(0, 230) };
}

/* --------------------------- analyst payload text --------------------------- */
const n = (v) => (v == null ? '—' : fN(v));
const SIDE_TXT = { waiting: 'zone not reached', live: 'zone entered (setup live)', t1: 'T1 hit', t2: 'T2 hit', stopped: 'stopped out', missed: 'ran to T1 without entering the zone' };
export function levelsText(mk, rec, ps, U) {
  const lines = [
    `US30: ${mk.feed} (${mk.symbol}${mk.source === 'blackbull' ? ', the chart Darius trades' : ''}), live as of ${bucClock(Date.parse(mk.fetchedAt))} Bucharest:`,
    `last ${n(mk.last)} (${mk.chgPct != null ? (mk.chgPct >= 0 ? '+' : '') + mk.chgPct + '%' : '—'} vs previous close), day open ${n(mk.dayOpen)} (18:00 New York), day high ${n(mk.dayHigh)}, day low ${n(mk.dayLow)}${mk.vwap != null ? ', VWAP ' + n(mk.vwap) + ' (tick volume, from the 18:00 open)' : ''}`,
    `previous day: high ${n(mk.pdh)}, low ${n(mk.pdl)}, close ${n(mk.pdc)}; ATR(14 days) ${n(mk.atr)}; week ${mk.weekPct != null ? mk.weekPct + '%' : '—'}; 1-month range ${n(mk.monthLow)}–${n(mk.monthHigh)}`,
  ];
  const asia = mk.asia || (rec && rec.asia);
  if (asia) lines.push(`Asia (18:00 New York to the London open): high ${n(asia.h)}, low ${n(asia.l)}`);
  const lon = mk.lon || (rec && rec.lon);
  if (lon) lines.push(`London (from 08:00 London): open ${n(lon.o)}, high ${n(lon.h)}, low ${n(lon.l)}` + (lon.c != null ? `, close ${n(lon.c)}` : ', still running'));
  const ny = mk.ny || (rec && rec.ny);
  if (ny) lines.push(`New York cash session: open ${n(ny.o)}, high ${n(ny.h)}, low ${n(ny.l)}` + (ny.c != null ? `, close ${n(ny.c)}` : ', still running'));
  if (mk.c15 && mk.c15.length) lines.push('Last 15-minute candles (Bucharest time open/high/low/close): ' + mk.c15.map((c) => `${bucClock(Date.parse(c.t))} ${n(c.o)}/${n(c.h)}/${n(c.l)}/${n(c.c)}`).join('; '));
  if (ps && U) {
    for (const k of Object.keys(ps)) {
      const s = U.sessions[k], st = ps[k];
      const one = (side, dir) => (validSide(side, dir)
        ? `${dir} ${n(side.zone[0])}-${n(side.zone[1])} ${SIDE_TXT[st[dir].state]}` + (st[dir].state !== 'waiting' ? ' (' + bucClock(st[dir].t2At || st[dir].t1At || st[dir].stopAt || st[dir].missedAt || st[dir].liveAt) + ')' : '')
        : `${dir}: none`);
      lines.push(`Published ${k === 'london' ? 'London' : 'NY'} map (written ${st.at ? bucClock(Date.parse(st.at)) : '?'}): ${one(s.long, 'long')}; ${one(s.short, 'short')}`);
    }
  }
  if (mk.error) lines.push(`(BlackBull feed error: ${mk.error})`);
  return lines.join('\n');
}
