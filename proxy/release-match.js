/* ============================================================================
 * release-match.js — shared POST-RELEASE RESULTS logic (plain ES module, no deps)
 *
 * Imported by BOTH:
 *   - proxy/worker.js           -> pushes the actual figures at release time
 *   - scripts/release-due.mjs   -> the local follow-up re-analysis task
 * so the notification and the re-analysis can never disagree about which
 * figures belong to which catalyst.
 *
 * SOURCE OF ACTUALS: TradingView's public economic-calendar endpoint (the JSON
 * behind their calendar widget). It is UNOFFICIAL and undocumented. It was
 * chosen after testing the alternatives on 2026-09-14:
 *   - ForexFactory free feed ....... no `actual` field at all
 *   - TradingEconomics guest API ... discontinued (HTTP 410)
 *   - FMP .......................... requires an API key
 * If TradingView ever changes it, only fetchCalendar() needs replacing.
 * ==========================================================================*/

export const TV_URL = 'https://economic-calendar.tradingview.com/events';
export const TV_HEADERS = {
  Origin: 'https://www.tradingview.com',
  'User-Agent': 'Mozilla/5.0 (fx-macro release watcher)',
};

/* Catalysts carry no currency field, so infer it from the event NAME.
 * Acronyms are matched case-sensitively ("US", "UK") so ordinary words like
 * "us" can't trigger them; names are case-insensitive. */
const CCY_RULES = [
  ['USD', /\b(United States|Federal Reserve|nonfarm|non-farm|payrolls|jobless claims|Powell|Warsh)\b/i, /\b(US|U\.S\.|FOMC|Fed|NFP|ISM|PCE)\b/],
  ['EUR', /\b(euro ?area|eurozone|Lagarde|German[y]?|France|French|Spain|Spanish|Ital(y|ian))\b/i, /\b(ECB|EZ|HICP|Ifo|ZEW)\b/],
  ['GBP', /\b(United Kingdom|Britain|British|Bank of England)\b/i, /\b(UK|U\.K\.|BoE|MPC)\b/],
  ['JPY', /\b(Japan|Japanese|Bank of Japan|Tokyo)\b/i, /\b(BoJ|JGB)\b/],
  ['AUD', /\b(Australia|Australian)\b/i, /\b(RBA)\b/],
  ['NZD', /\b(New Zealand)\b/i, /\b(RBNZ|NZ)\b/],
  ['CAD', /\b(Canada|Canadian|Bank of Canada)\b/i, /\b(BoC)\b/],
  ['CHF', /\b(Swiss|Switzerland)\b/i, /\b(SNB)\b/],
  ['CNY', /\b(China|Chinese)\b/i, /\b(PBoC)\b/],
];

export function inferCurrency(text) {
  const s = String(text || '');
  for (const [ccy, words, acronyms] of CCY_RULES) {
    if (words.test(s) || acronyms.test(s)) return ccy;
  }
  return null;
}

// TradingView filters by COUNTRY; the euro spans several.
export const CCY_COUNTRIES = {
  USD: ['US'], EUR: ['EU', 'DE', 'FR', 'IT', 'ES'], GBP: ['GB'], JPY: ['JP'],
  AUD: ['AU'], NZD: ['NZ'], CAD: ['CA'], CHF: ['CH'], CNY: ['CN'],
};
const ALL_COUNTRIES = [...new Set(Object.values(CCY_COUNTRIES).flat())];

export const FLAG = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺',
  NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳',
};

/* Which app instruments a release in `ccy` affects. Used by the follow-up
 * re-analysis to bound its scope: the currency itself plus every symbol that
 * trades it (USD also drives the USD-quoted commodities and DXY; China data
 * transmits through AUD, NZD and copper). */
export function affectedCurrencies(ccy) {
  return ccy === 'CNY' ? ['AUD', 'NZD'] : ccy ? [ccy] : [];
}
export function isAffectedSymbol(sym, ccy) {
  const s = String(sym);
  const ccys = affectedCurrencies(ccy);
  if (ccys.some((c) => s.includes(c))) return true;
  if (ccy === 'USD' && ['DXY', 'XAU/USD', 'XAG/USD', 'XCU/USD', 'USOIL'].includes(s)) return true;
  if (ccy === 'EUR' && s === 'GER40') return true;
  if (ccy === 'JPY' && s === 'JPYBASKET') return true;
  if (ccy === 'CNY' && s === 'XCU/USD') return true;
  return false;
}

export const MATCH_WINDOW_MS = 5 * 60 * 1000;   // TradingView times match catalysts exactly;
                                                // ±90 min would pull in the NEXT event's lines

export function calendarUrl(ccy, whenMs) {
  const from = new Date(whenMs - 10 * 60000).toISOString();
  const to = new Date(whenMs + 10 * 60000).toISOString();
  const countries = (CCY_COUNTRIES[ccy] || ALL_COUNTRIES).join(',');
  return `${TV_URL}?from=${from}&to=${to}&countries=${countries}`;
}

export async function fetchCalendar(ccy, whenMs, fetchImpl = fetch) {
  const r = await fetchImpl(calendarUrl(ccy, whenMs), { headers: TV_HEADERS });
  if (!r.ok) throw new Error('TradingView calendar HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.result || []);
}

/* A "data line" is one that can ever carry a number. Speeches, press
 * conferences and "Economic Projections" never get an actual — they must not
 * hold a notification back waiting for a figure that will never arrive. */
const isDataLine = (e) => e.forecast != null || e.previous != null || e.actual != null;

/* Match TradingView lines to one catalyst. Returns
 *   { ccy, lines:[{title,actual,forecast,previous,unit,importance,period}],
 *     complete }   complete = every headline (importance 1) data line has an actual. */
export function matchRelease(catalyst, events) {
  const t = Date.parse(catalyst.when);
  const ccy = inferCurrency(catalyst.event) || inferCurrency(catalyst.note);
  const lines = (events || [])
    .filter((e) => Math.abs(Date.parse(e.date) - t) <= MATCH_WINDOW_MS)
    .filter((e) => (ccy ? e.currency === (ccy === 'CNY' ? 'CNY' : ccy) : e.importance === 1))
    .filter((e) => e.importance >= 0 && isDataLine(e))
    .sort((a, b) => b.importance - a.importance || String(a.title).localeCompare(String(b.title)))
    .map((e) => ({
      title: e.title, actual: e.actual, forecast: e.forecast, previous: e.previous,
      unit: e.unit || '', importance: e.importance, period: e.period || '',
    }));
  const headline = lines.filter((l) => l.importance === 1);
  const gate = headline.length ? headline : lines;
  return { ccy, lines, complete: gate.length > 0 && gate.every((l) => l.actual != null) };
}

export function fmtValue(v, unit) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  const num = Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
  if (!unit) return num;
  return unit === '%' ? num + '%' : num + unit;
}

/* Neutral comparison on purpose: "above/below forecast", never "good/bad".
 * A higher unemployment print is literally ABOVE forecast; what it means for
 * the currency is the analyst's call (Darius reads direction literally). */
export function vsForecast(actual, forecast) {
  if (actual == null || forecast == null) return '';
  const a = Number(actual), f = Number(forecast);
  if (!Number.isFinite(a) || !Number.isFinite(f)) return '';
  if (Math.abs(a - f) < 1e-9) return 'in line';
  return a > f ? '▲ above' : '▼ below';
}

const shortTitle = (t) => String(t).replace(/\bRate (?=(YoY|MoM|QoQ)\b)/, '');

/* Build the push payload once figures are in. Headline lines first, capped so
 * the body stays readable on a lock screen. */
export function buildNotification(catalyst, match) {
  const shown = match.lines.filter((l) => l.actual != null).slice(0, 4);
  const parts = shown.map((l) => {
    const cmp = vsForecast(l.actual, l.forecast);
    const exp = l.forecast != null ? ` (exp ${fmtValue(l.forecast, l.unit)}${cmp ? ', ' + cmp : ''})` : '';
    return `${shortTitle(l.title)} ${fmtValue(l.actual, l.unit)}${exp}`;
  });
  let body = '';
  for (const p of parts) {
    const next = body ? body + ' · ' + p : p;
    if (next.length > 200) break;          // cut at a whole line, never mid-figure
    body = next;
  }
  return {
    title: `${FLAG[match.ccy] || '📊'} ${catalyst.event} — released`,
    body: body || 'Figures released.',
    tag: 'fx-result-' + catalyst.when,
    url: './index.html#cal',
  };
}

/* Stable per-catalyst id (several catalysts can share one timestamp). */
export function releaseId(catalyst) {
  const slug = String(catalyst.event || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `${catalyst.when}|${slug}`;
}
