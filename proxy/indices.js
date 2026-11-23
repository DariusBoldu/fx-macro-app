/* ============================================================================
 * US index futures tracker (US30 = Dow, YM; NAS100 = Nasdaq-100, NQ) — feeds
 * the cloud analyst and the app's track records.
 *
 * Source: TradingView's public screener endpoint for the front months
 * CBOT_MINI:YM1! and CME_MINI:NQ1! (10-minute delayed for CME without a data
 * subscription). ONE request returns both: the current CME day (opens 18:00
 * New York), the previous day's high/low/close, VWAP and the 14-day ATR.
 * Intraday bars are not available, so the Worker builds the session ranges
 * itself:
 *
 *   Asia    CME open (18:00 NY)  -> London open    = the day's range at London open
 *   London  08:00 London         -> 09:30 New York (cash open)
 *   NY      09:30 New York       -> 16:00 New York (cash close)
 *
 * Each window keeps open/high/low/close. High/low come from the 2-minute
 * samples AND from the cumulative day high/low: a new day high printed inside
 * the window is that window's exact high, wick included.
 *
 * The analyst's session calls are scored deterministically at each window's
 * close (see scoreCall), so the track record is not the model grading itself.
 * ==========================================================================*/

export const SCAN_URL = 'https://scanner.tradingview.com/futures/scan';
/* key = the data.json block and the KV prefix (`<key>:d:<date>`, `<key>:scores`). */
export const INDICES = {
  us30: { key: 'us30', label: 'US30', fut: 'YM', symbol: 'CBOT_MINI:YM1!' },
  nas100: { key: 'nas100', label: 'NAS100', fut: 'NQ', symbol: 'CME_MINI:NQ1!' },
};
export const INDEX_KEYS = Object.keys(INDICES);
const COLS = ['close', 'open', 'high', 'low', 'VWAP', 'ATR', 'close[1]', 'high[1]', 'low[1]',
  'change', 'Perf.W', 'High.1M', 'Low.1M', 'time', 'update_mode'];

export const LON_TZ = 'Europe/London';
export const NY_TZ = 'America/New_York';
export const BUC_TZ = 'Europe/Bucharest';
const LON_OPEN = 8 * 60;          // 08:00 London
const NY_OPEN = 9 * 60 + 30;      // 09:30 New York
const NY_CLOSE = 16 * 60;         // 16:00 New York
export const NY_FIRE_LEAD_MIN = 40;   // NY update fires 40 min before the cash open
export const LONDON_FIRE_LEAD_MIN = 40;   // London update fires 40 min before the London open
const MIDDAY_BUC_MIN = 14 * 60;          // midday update at 14:00 Bucharest...
const MIDDAY_MIN_GAP_MIN = 90;           // ...but at least 90 min before the NY fire (US/EU DST gap weeks)

/* NYSE full-day closures. CME equity futures trade a shortened session on most
 * of these, but there is no cash session to call. */
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

/* The CME day that is trading at `ms`: it opens 18:00 New York the evening
 * before, so shifting by 6 h lands on the right New York date. */
export const tradeDate = (ms) => tzParts(ms + 6 * 3600000, NY_TZ).date;
export function isTradingDay(date) {
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  return wd >= 1 && wd <= 5 && !US_HOLIDAYS.has(date);
}
export function prevTradingDay(date) {
  let t = Date.parse(date + 'T12:00:00Z');
  for (let i = 0; i < 10; i++) {
    t -= 86400000;
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingDay(d)) return d;
  }
  return null;
}
/* The day's three boundaries in UTC ms. */
export function sessionTimes(date) {
  return {
    lonOpen: zonedMs(date, LON_OPEN, LON_TZ),
    nyOpen: zonedMs(date, NY_OPEN, NY_TZ),
    nyClose: zonedMs(date, NY_CLOSE, NY_TZ),
  };
}

/* The three intraday analyst updates of a US trading day (Darius, 2026-11-23):
 *   LONDON  40 min before the London open  (09:20 Bucharest)  final London call
 *   MIDDAY  14:00 Bucharest, London live                      London check + NY first look
 *   NY      40 min before the NY cash open (15:50 Bucharest)  final NY call
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

/* -------------------------------- snapshot -------------------------------- */
function parseRow(sym, d) {
  const o = {};
  COLS.forEach((c, i) => { o[c] = d[i]; });
  if (typeof o.close !== 'number') return null;
  const m = /_(\d+)$/.exec(String(o.update_mode || ''));
  const delaySec = /delayed/.test(String(o.update_mode || '')) ? (m ? +m[1] : 600) : 0;
  const r1 = (v) => (typeof v === 'number' ? Math.round(v) : null);
  return {
    symbol: sym, fetchedAt: new Date().toISOString(), delayMin: Math.round(delaySec / 60),
    last: r1(o.close), dayOpen: r1(o.open), dayHigh: r1(o.high), dayLow: r1(o.low),
    vwap: r1(o.VWAP), atr: r1(o.ATR),
    pdh: r1(o['high[1]']), pdl: r1(o['low[1]']), pdc: r1(o['close[1]']),
    chgPct: typeof o.change === 'number' ? +o.change.toFixed(2) : null,
    weekPct: typeof o['Perf.W'] === 'number' ? +o['Perf.W'].toFixed(2) : null,
    monthHigh: r1(o['High.1M']), monthLow: r1(o['Low.1M']),
    dayStart: typeof o.time === 'number' ? new Date(o.time * 1000).toISOString() : null,
  };
}
/* Both futures in one request -> { us30: snap, nas100: snap }. A symbol the
 * screener did not return is simply absent; throws only when none came back. */
export async function fetchFutures(fetchImpl = fetch) {
  const r = await fetchImpl(SCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: INDEX_KEYS.map((k) => INDICES[k].symbol) }, columns: COLS }),
  });
  if (!r.ok) throw new Error('scanner HTTP ' + r.status);
  const j = await r.json();
  const out = {};
  for (const row of (j && j.data) || []) {
    const k = INDEX_KEYS.find((x) => INDICES[x].symbol === row.s);
    const snap = k && Array.isArray(row.d) ? parseRow(row.s, row.d) : null;
    if (snap) out[k] = snap;
  }
  if (!Object.keys(out).length) throw new Error('scanner: no data');
  return out;
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

/* ---------------------------- window bookkeeping ---------------------------- */
/* Update one window with a sample; returns true when something changed. */
function feedWindow(w, snap) {
  let ch = false;
  if (w.h == null || snap.last > w.h) { w.h = snap.last; ch = true; }
  if (w.l == null || snap.last < w.l) { w.l = snap.last; ch = true; }
  if (snap.dayHigh != null && w.dh0 != null && snap.dayHigh > w.dh0 && snap.dayHigh > w.h) { w.h = snap.dayHigh; ch = true; }
  if (snap.dayLow != null && w.dl0 != null && snap.dayLow < w.dl0 && snap.dayLow < w.l) { w.l = snap.dayLow; ch = true; }
  return ch;
}
function openWindow(snap, dataMs) {
  return { o: snap.last, h: snap.last, l: snap.last, c: null, dh0: snap.dayHigh, dl0: snap.dayLow,
    openedAt: new Date(dataMs).toISOString() };
}

/* Which windows does a sample taken at data-time `dataMs` belong to? */
export function phaseAt(date, dataMs) {
  const t = sessionTimes(date);
  if (dataMs < t.lonOpen) return 'asia';
  if (dataMs < t.nyOpen) return 'london';
  if (dataMs < t.nyClose) return 'ny';
  return 'after';
}

/* Pure state transition for one sample; `callFor(session)` returns the analyst's
 * call {bias, conviction} recorded when a window opens. Returns {rec, changed, scores}. */
export function applySample(rec, snap, dataMs, callFor) {
  const scores = [];
  let changed = false;
  const phase = phaseAt(rec.date, dataMs);
  // A window opened late (Worker outage, first deploy mid-session) would carry a
  // wrong open price and a wrong score, so it is only opened near its start.
  const t = sessionTimes(rec.date), LATE = 20 * 60000;
  if (snap.atr && !rec.atr) { rec.atr = snap.atr; changed = true; }
  if (rec.pdh == null && snap.pdh != null) {
    rec.pdh = snap.pdh; rec.pdl = snap.pdl; rec.pdc = snap.pdc; changed = true;
  }
  if (phase === 'london' || phase === 'ny' || phase === 'after') {
    // The day's range at London open is the Asia range; only valid if sampled then.
    if (!rec.asia && phase === 'london' && dataMs - t.lonOpen < LATE) { rec.asia = { h: snap.dayHigh, l: snap.dayLow }; changed = true; }
    if (!rec.lon && phase === 'london' && dataMs - t.lonOpen < LATE) {
      rec.lon = openWindow(snap, dataMs); rec.lon.call = callFor('london'); changed = true;
    } else if (rec.lon && rec.lon.c == null) {
      if (feedWindow(rec.lon, snap)) changed = true;
      if (phase !== 'london') {
        rec.lon.c = snap.last; changed = true;
        const sc = scoreCall(rec.lon.call && rec.lon.call.bias, rec.lon, rec.atr);
        if (sc) { rec.lon.score = sc; scores.push(Object.assign({ date: rec.date, s: 'lon', call: rec.lon.call.bias, conv: rec.lon.call.conviction || null }, sc)); }
      }
    }
  }
  if (phase === 'ny' || phase === 'after') {
    if (!rec.ny && phase === 'ny' && dataMs - t.nyOpen < LATE) {
      rec.ny = openWindow(snap, dataMs); rec.ny.call = callFor('ny'); changed = true;
    } else if (rec.ny && rec.ny.c == null) {
      if (feedWindow(rec.ny, snap)) changed = true;
      if (phase === 'after') {
        rec.ny.c = snap.last; changed = true;
        const sc = scoreCall(rec.ny.call && rec.ny.call.bias, rec.ny, rec.atr);
        if (sc) { rec.ny.score = sc; scores.push(Object.assign({ date: rec.date, s: 'ny', call: rec.ny.call.bias, conv: rec.ny.call.conviction || null }, sc)); }
      }
    }
  }
  return { rec, changed, scores };
}

/* --------------------------- analyst payload text --------------------------- */
const n = (v) => (v == null ? '—' : String(v));
export function levelsText(ix, snap, rec) {
  const lines = [
    `${ix.label}: ${ix.fut} futures (${ix.symbol}, TradingView, ${snap.delayMin}-min delayed) as of ${bucClock(Date.parse(snap.fetchedAt))} Bucharest:`,
    `last ${n(snap.last)} (${snap.chgPct != null ? (snap.chgPct >= 0 ? '+' : '') + snap.chgPct + '%' : '—'} vs prev settle), day open ${n(snap.dayOpen)}, day high ${n(snap.dayHigh)}, day low ${n(snap.dayLow)}, VWAP ${n(snap.vwap)}`,
    `previous day: high ${n(snap.pdh)}, low ${n(snap.pdl)}, close ${n(snap.pdc)}; ATR(14 days) ${n(snap.atr)}; week ${snap.weekPct != null ? snap.weekPct + '%' : '—'}; 1-month range ${n(snap.monthLow)}–${n(snap.monthHigh)}`,
  ];
  if (rec && rec.asia) lines.push(`Asia (CME open to London open): high ${n(rec.asia.h)}, low ${n(rec.asia.l)}`);
  if (rec && rec.lon) lines.push(`London (from 08:00 London): open ${n(rec.lon.o)}, high ${n(rec.lon.h)}, low ${n(rec.lon.l)}` + (rec.lon.c != null ? `, close ${rec.lon.c}` : ', still running'));
  if (rec && rec.ny) lines.push(`New York cash session: open ${n(rec.ny.o)}, high ${n(rec.ny.h)}, low ${n(rec.ny.l)}` + (rec.ny.c != null ? `, close ${rec.ny.c}` : ', still running'));
  return lines.join('\n');
}
