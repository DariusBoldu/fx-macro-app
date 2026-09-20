/* ============================================================================
 * release-match.js — shared RED-FOLDER release logic (plain ES module, no deps)
 *
 * Imported by BOTH:
 *   - proxy/worker.js           -> pre-release alerts + actual-figure pushes
 *   - scripts/release-due.mjs   -> the local post-release re-analysis task
 * so notifications and re-analysis always agree on what was released.
 *
 * WHICH RELEASES: ForexFactory RED FOLDERS only (impact "High") for the app's 8
 * currencies — Darius's own definition of important news (2026-09-14). Source:
 * ForexFactory's public weekly JSON feed: title, time, forecast, previous — but
 * NO actual value.
 *
 * ACTUAL FIGURES: TradingView's public economic-calendar JSON (unofficial).
 * Tested 2026-09-14 against the alternatives: TradingEconomics' free API is
 * discontinued (HTTP 410), FMP needs a key. Each red-folder line is matched to a
 * TradingView line by currency, time and a normalised title
 * ("Trimmed CPI y/y" <-> "CPI Trimmed-Mean YoY"). On a full week every numeric
 * red folder matched; only speeches/statements — which never carry a figure —
 * did not.
 *
 * Forecast and previous are passed through exactly as ForexFactory shows them,
 * and the actual is formatted in the same style, so a push reads like the FF row.
 * ==========================================================================*/

export const APP_CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'];
export const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const TV_URL = 'https://economic-calendar.tradingview.com/events';
export const TV_HEADERS = {
  Origin: 'https://www.tradingview.com',
  'User-Agent': 'Mozilla/5.0 (fx-macro release watcher)',
};

export const FLAG = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺',
  NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳',
};

// TradingView filters by COUNTRY; the euro spans several.
export const CCY_COUNTRIES = {
  USD: ['US'], EUR: ['EU', 'DE', 'FR', 'IT', 'ES'], GBP: ['GB'], JPY: ['JP'],
  AUD: ['AU'], NZD: ['NZ'], CAD: ['CA'], CHF: ['CH'],
};

export const isoNoMillis = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ---- Currency of a daily-report catalyst (reports carry no currency field) ----
 * Used to attach red-folder figures to the report's own catalyst rows.
 * Acronyms match case-sensitively so ordinary words like "us" can't trigger. */
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

/* Which app instruments a release in `ccy` affects — bounds the re-analysis:
 * the currency plus every symbol that trades it (USD also drives DXY and the
 * USD-quoted commodities; EUR drives GER40; JPY drives JPYBASKET). */
export function affectedCurrencies(ccy) {
  return ccy === 'CNY' ? ['AUD', 'NZD'] : ccy ? [ccy] : [];
}
export function isAffectedSymbol(sym, ccy) {
  const s = String(sym);
  if (affectedCurrencies(ccy).some((c) => s.includes(c))) return true;
  if (ccy === 'USD' && ['DXY', 'XAU/USD', 'XAG/USD', 'XCU/USD', 'USOIL'].includes(s)) return true;
  if (ccy === 'EUR' && s === 'GER40') return true;
  if (ccy === 'JPY' && s === 'JPYBASKET') return true;
  if (ccy === 'CNY' && s === 'XCU/USD') return true;
  return false;
}

/* ============================ ForexFactory red folders ============================ */

// A line that can carry a figure. Speeches, statements, press conferences and
// "Economic Projections" have neither forecast nor previous and never get one.
export const isNumeric = (l) =>
  String((l && l.forecast) || '').trim() !== '' || String((l && l.previous) || '').trim() !== '';

// Central-bank rate decisions: their times are often tentative (FF listed the BoJ
// at 02:30Z, TradingView at 03:00Z), so they get a wider matching window.
const DECISION_RE = /\b(overnight|cash|bank|funds|refinancing|policy|deposit facility)\s+rate\b/i;
export const isDecision = (title) => DECISION_RE.test(String(title)) && !/\bvotes?\b/i.test(String(title));

/* Group red folders by (release time, currency): "12:30Z CAD" = CPI m/m +
 * Median CPI y/y + Trimmed CPI y/y — one notification, one re-analysis. */
export function redFolderGroups(ffEvents) {
  const byId = new Map();
  for (const e of ffEvents || []) {
    if (e.impact !== 'High' || !APP_CCYS.includes(e.country)) continue;
    const t = Date.parse(e.date);
    if (isNaN(t)) continue;
    const id = isoNoMillis(t) + '|' + e.country;
    if (!byId.has(id)) byId.set(id, { id, when: isoNoMillis(t), ccy: e.country, lines: [] });
    byId.get(id).lines.push({ title: e.title, forecast: e.forecast || '', previous: e.previous || '' });
  }
  const groups = [...byId.values()].sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
  for (const g of groups) {
    g.numeric = g.lines.some(isNumeric);
    g.decision = g.lines.some((l) => isDecision(l.title));
  }
  return groups;
}

export async function fetchRedFolder(fetchImpl = fetch) {
  const r = await fetchImpl(FF_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (fx-macro release watcher)' } });
  if (!r.ok) throw new Error('ForexFactory feed HTTP ' + r.status);
  return redFolderGroups(await r.json());
}

/* ==================== Central-bank commentary (2026-09-20) ====================
 * The figure is only half of a central-bank event. The statement, the vote
 * split, the projections/dot plot and the press conference carry the rest — and
 * none of it is readable at release time: after the 2026-09-16 FOMC the rate was
 * verifiable within a minute, while the dot plot was still unindexed 11 minutes
 * later, so that report went out without it. Every red folder that is about what
 * a central bank SAYS therefore gets a second, later pass.
 *
 * Delays run from the scheduled start. A Fed or ECB press conference lasts about
 * an hour (45-75 min), so 60 minutes lands just after it ends, with the wires
 * written up. Speeches are shorter. A decision with no press conference of its
 * own still needs ~45 minutes for the votes and projections to be reported. */
export const COMMENTARY_MIN = { presser: 60, speech: 45, decision: 45 };
export const COMMENTARY_STALE_H = 6;      // older than this: the daily report covers it
const PRESSER_LINK_MS = 3 * 3600000;      // a presser this close belongs to that decision
const PRESSER_RE = /press conference/i;
const SPEECH_RE = /\b(speaks|speech|testimony|testifies|remarks|panel|statement)\b/i;

/* What kind of "said" event this group is, or null if it is figures only. */
export function commentaryKind(g) {
  if (!g || !g.lines || !g.lines.length) return null;
  if (g.lines.some((l) => PRESSER_RE.test(l.title))) return 'presser';
  if (g.decision) return 'decision';
  if (!g.numeric && g.lines.some((l) => SPEECH_RE.test(l.title))) return 'speech';
  return null;
}

/* The rate decision a press conference belongs to (SNB decides 07:30Z, speaks
 * 08:00Z), so the commentary pass can quote the figure that was already pushed. */
export function relatedDecision(g, groups) {
  return (groups || []).find((o) => o.id !== g.id && o.ccy === g.ccy && o.decision &&
    Math.abs(Date.parse(o.when) - Date.parse(g.when)) <= PRESSER_LINK_MS) || null;
}

/* Every group owed a commentary pass, each with the kind and the UTC time it is
 * due. A decision whose own press conference is within 3 hours is skipped: that
 * later pass reads the statement and the press conference together. */
export function commentaryGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    const kind = commentaryKind(g);
    if (!kind) continue;
    if (kind === 'decision' && (groups || []).some((o) => o.id !== g.id && o.ccy === g.ccy &&
      commentaryKind(o) === 'presser' && Math.abs(Date.parse(o.when) - Date.parse(g.when)) <= PRESSER_LINK_MS)) continue;
    out.push(Object.assign({}, g, {
      kind,
      dueAt: isoNoMillis(Date.parse(g.when) + COMMENTARY_MIN[kind] * 60000),
    }));
  }
  return out;
}

/* Fed, ECB and BoJ move the whole board, so their commentary re-scores all 8
 * currencies; the rest stay scoped to their own currency (Darius, 2026-09-16). */
export const FULL_BOARD_CCYS = ['USD', 'EUR', 'JPY'];
export const commentaryScope = (ccy) => (FULL_BOARD_CCYS.includes(ccy) ? 'full' : 'focused');

/* The payload the Worker sends to the cloud routine. Facts only — the routine's
 * own prompt decides what to do with them. */
export function buildCommentaryPayload(c, { decisionGroup, result } = {}) {
  const KIND = { presser: 'press conference', speech: 'speech', decision: 'rate decision (no press conference)' };
  const lines = [
    `CENTRAL-BANK COMMENTARY ${c.id}`,
    `Currency: ${c.ccy}`,
    `Event: ${KIND[c.kind] || c.kind}`,
    `Scheduled: ${c.when}`,
    `Red-folder lines: ${c.lines.map((l) => l.title).join(', ')}`,
    `Scope: ${commentaryScope(c.ccy)}`,
  ];
  if (decisionGroup) lines.push(`Decision at ${decisionGroup.when}: ${decisionGroup.lines.map((l) => l.title).join(', ')}`);
  const figures = ((result && result.lines) || []).filter((l) => l.actual != null);
  if (figures.length) {
    lines.push('Figures already published to the app:');
    for (const l of figures) {
      lines.push(`- ${l.title}: actual ${l.actual}` +
        (l.forecast ? ` (forecast ${l.forecast}${l.cmp ? ', ' + l.cmp : ''})` : '') +
        (l.previous ? `, previous ${l.previous}` : ''));
    }
  }
  return lines.join('\n');
}

/* ============================ TradingView actuals ============================ */

export function calendarUrl(ccy, whenMs, spanMin = 10) {
  const from = new Date(whenMs - spanMin * 60000).toISOString();
  const to = new Date(whenMs + spanMin * 60000).toISOString();
  const countries = (CCY_COUNTRIES[ccy] || Object.values(CCY_COUNTRIES).flat()).join(',');
  return `${TV_URL}?from=${from}&to=${to}&countries=${countries}`;
}

export async function fetchCalendar(ccy, whenMs, { spanMin = 10, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(calendarUrl(ccy, whenMs, spanMin), { headers: TV_HEADERS });
  if (!r.ok) throw new Error('TradingView calendar HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.result || []);
}

/* Title normalisation for FF <-> TV matching. */
const STOP = new Set(['rate', 'the', 'index', 'prel', 'prelim', 'preliminary', 'flash', 'final', 'adv',
  'advance', 'sa', 'nsa', 'change', 'growth', 's', 'n', 'initial', '1st', '2nd', '3rd', 'est', 'estimate']);
const PERIODS = ['mom', 'yoy', 'qoq', '3my'];
function tokens(title) {
  return String(title).toLowerCase()
    .replace(/3m\/y|\(3mo\/yr\)|3mo\/yr/g, ' 3my ')
    .replace(/m\/m/g, ' mom ').replace(/y\/y/g, ' yoy ').replace(/q\/q/g, ' qoq ')
    .replace(/inflation rate|consumer price index/g, ' cpi ')
    .replace(/trimmed[- ]mean/g, ' trimmed ')
    .replace(/ex[- ]autos?/g, ' core ')
    .replace(/jobless/g, ' unemployment ')
    .replace(/non[- ]farm/g, ' nonfarm ').replace(/payrolls/g, ' employment ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w && !STOP.has(w));
}
/* Jaccard overlap; 0 when the periods differ (m/m must never match y/y). */
export function titleScore(a, b) {
  const A = tokens(a), B = tokens(b);
  const pa = A.filter((w) => PERIODS.includes(w)).sort().join();
  const pb = B.filter((w) => PERIODS.includes(w)).sort().join();
  if (pa !== pb) return 0;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  sa.forEach((w) => { if (sb.has(w)) inter++; });
  const uni = new Set([...sa, ...sb]).size;
  return uni ? inter / uni : 0;
}

const nearLines = (group, tv, tolMin) => {
  const t = Date.parse(group.when);
  return (tv || []).filter((e) => e.currency === group.ccy && Math.abs(Date.parse(e.date) - t) <= tolMin * 60000);
};

/* Actual figure for ONE red-folder line.
 *   null            -> TradingView carries no such line (won't block the group)
 *   {pending:true}  -> matched, figure not published yet
 *   {text, num}     -> the figure, formatted ForexFactory-style */
export function findActual(line, group, tv) {
  const title = String(line.title);

  // "MPC Official Bank Rate Votes" (FF "3-0-6" = hike-cut-hold) is built from
  // TradingView's three vote lines. It must NOT fall through to the rate
  // decision, which would show the Bank Rate instead of the vote split.
  if (/\bvotes?\b/i.test(title)) {
    const c = nearLines(group, tv, 5);
    const pick = (re) => c.find((e) => re.test(e.title));
    const hike = pick(/vote hike/i), cut = pick(/vote cut/i), hold = pick(/vote (unchanged|hold)/i);
    if (!hike || !cut || !hold) return null;
    if ([hike, cut, hold].some((e) => e.actual == null)) return { pending: true };
    return { text: `${hike.actual}-${cut.actual}-${hold.actual}`, num: null };
  }

  let best = null, bestScore = 0;
  for (const e of nearLines(group, tv, 5)) {
    const s = titleScore(title, e.title);
    // tie-break on TradingView importance ("incl. Bonus" over "excl. Bonus")
    if (s > bestScore || (s > 0 && s === bestScore && best && e.importance > best.importance)) {
      best = e; bestScore = s;
    }
  }
  if (bestScore < 0.5 && isDecision(title)) {
    const t = Date.parse(group.when);
    const d = nearLines(group, tv, 150)
      .filter((e) => /interest rate decision/i.test(e.title))
      .sort((a, b) => Math.abs(Date.parse(a.date) - t) - Math.abs(Date.parse(b.date) - t))[0];
    if (d) { best = d; bestScore = 1; }
  }
  if (!best || bestScore < 0.5) return null;
  if (best.actual == null) return { pending: true };
  return { text: fmtLikeFF(best.actual, [line.forecast, line.previous]), num: Number(best.actual) };
}

/* All figures for a red-folder group. `complete` = every line TradingView
 * carries has its figure; lines it doesn't carry never hold a push back. */
export function matchGroup(group, tv) {
  const rows = group.lines.filter(isNumeric).map((l) => {
    const f = findActual(l, group, tv);
    const actual = f && f.text != null ? f.text : null;
    return {
      matched: !!f,
      line: { title: l.title, actual, forecast: l.forecast, previous: l.previous, cmp: actual != null ? vsForecast(f, l.forecast) : '' },
    };
  });
  const matched = rows.filter((r) => r.matched);
  return {
    lines: rows.map((r) => r.line),
    anyActual: rows.some((r) => r.line.actual != null),
    complete: matched.length > 0 && matched.every((r) => r.line.actual != null),
    unmatched: rows.filter((r) => !r.matched).map((r) => r.line.title),
  };
}

/* ============================== Formatting ============================== */

export function ffNumber(s) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[%KMBT]?\s*$/i.exec(String(s == null ? '' : s));
  return m ? Number(m[1]) : null;
}

const STYLE_RE = /^\s*[<>]?\s*-?\d+(?:\.(\d+))?\s*([%KMBT]?)\s*$/i;
function decimalsOf(n) {
  const s = String(n), i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
/* Format a TradingView number the way ForexFactory prints that series: same
 * decimals and suffix as its forecast (or previous) — 2 -> "2.0%", 8.3 -> "8.3K". */
export function fmtLikeFF(value, refs) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  for (const r of refs || []) {
    const m = STYLE_RE.exec(String(r || ''));
    if (m) return n.toFixed(m[1] ? m[1].length : Math.min(2, decimalsOf(n))) + (m[2] || '');
  }
  return String(Math.round(n * 1000) / 1000);
}

/* Neutral on purpose: "above/below forecast", never "good/bad" — a higher
 * unemployment print is literally ABOVE forecast; what it means for the
 * currency is the analyst's call. Compared at ForexFactory's own precision. */
export function vsForecast(found, forecast) {
  const f = String(forecast || '').trim();
  if (!f || !found || found.text == null) return '';
  if (found.num == null) return found.text === f ? 'in line' : '';   // vote splits like "3-0-6"
  if (/^[<>]/.test(f)) return '';                                     // bounded forecasts ("<1.25%")
  const fn = ffNumber(f), an = ffNumber(found.text);
  if (fn == null || an == null) return '';
  if (Math.abs(an - fn) < 1e-9) return 'in line';
  return an > fn ? '▲ above' : '▼ below';
}

function joinCapped(parts, sep, max) {
  let s = '';
  for (const p of parts) {
    const next = s ? s + sep + p : p;
    if (next.length > max) break;          // cut at a whole line, never mid-figure
    s = next;
  }
  return s;
}

export function buildResultNotification(group, match) {
  const parts = match.lines.filter((l) => l.actual != null).map((l) =>
    `${l.title} ${l.actual}` + (l.forecast ? ` (exp ${l.forecast}${l.cmp ? ', ' + l.cmp : ''})` : ''));
  return {
    title: `${FLAG[group.ccy] || '📊'} ${group.ccy} red folder — released`,
    body: joinCapped(parts, ' · ', 200) || 'Figures released.',
    tag: 'fx-result-' + group.id,
    url: './index.html',
  };
}

export function buildPreAlert(group, label) {
  const parts = group.lines.map((l) => (l.forecast ? `${l.title} exp ${l.forecast}` : l.title));
  return {
    title: `⏰ ${FLAG[group.ccy] || ''} ${group.ccy} red folder — ${label}`,
    body: joinCapped(parts, ' · ', 200) || 'High-impact release ahead.',
    tag: 'fx-event-' + group.id,
    url: './index.html',
  };
}
