/* ============================================================================
 * FX Macro — Cloudflare Worker (free tier).
 *
 * Jobs, so the static PWA needs no secrets of its own:
 *   1) PRICE PROXY for OANDA practice (dormant — the app shows no prices):
 *        GET /quotes?symbols=EUR/USD,GBP/USD
 *        GET /sparkline?symbol=EUR/USD&points=24
 *   2) PUSH SUBSCRIPTION COLLECTOR (stores devices in KV for the push sender):
 *        POST /subscribe            body = PushSubscription JSON   (public)
 *        GET  /subscriptions?key=…  -> all subs                    (admin)
 *   3) SHARED TRADE JOURNAL:  GET/POST /journal  (x-fx-auth)
 *   4) RED-FOLDER NEWS (cron — laptop not involved), ForexFactory red folders
 *      for the app's 8 currencies only:
 *        - push 60 and 15 minutes before each release
 *        - push the ACTUAL figures moments after it is released
 *        GET /results               -> recent released figures     (public)
 *        GET /results/probe?key=…   -> FF + TradingView reachable, last cron tick (admin)
 *      and after each release, fire the cloud analyst routine's API trigger:
 *        POST /routine/test?key=…   -> fire it with a TRIGGER TEST payload (admin)
 *
 * Deploy (free):
 *   npm i -g wrangler && wrangler login
 *   wrangler kv namespace create FX_SUBS
 *   # put the id into wrangler.toml, then:
 *   wrangler secret put OANDA_TOKEN
 *   wrangler secret put OANDA_ACCOUNT
 *   wrangler secret put ADMIN_KEY
 *   wrangler deploy
 * Then set config.js -> price.oanda.proxyUrl and push.subscribeUrl to the
 * worker URL.  See ./README.md.
 * ==========================================================================*/
import { sendWebPush } from './webpush.js';
import {
  fetchRedFolder, fetchCalendar, matchGroup, buildResultNotification, buildPreAlert,
  commentaryGroups, relatedDecision, buildCommentaryPayload, COMMENTARY_STALE_H,
  TV_URL, TV_HEADERS,
} from './release-match.js';

const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';

// Lock this down to your Pages origin in production, e.g.
//   'https://<user>.github.io'
const ALLOW_ORIGIN = '*';

function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-fx-auth'
  }, extra || {});
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: cors({ 'Content-Type': 'application/json' }) });

const toOanda = (s) => s.replace('/', '_');
const fromOanda = (s) => s.replace('_', '/');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    try {
      if (url.pathname === '/quotes') return await quotes(url, env);
      if (url.pathname === '/sparkline') return await sparkline(url, env);
      if (url.pathname === '/subscribe' && request.method === 'POST') return await subscribe(request, env);
      if (url.pathname === '/subscriptions') return await listSubs(url, env);
      if (url.pathname === '/journal') return await journal(request, env);
      if (url.pathname === '/results') return await getResults(env);
      if (url.pathname === '/results/probe') return await probeResults(url, env);
      if (url.pathname === '/routine/test' && request.method === 'POST') return await testRoutine(url, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronTick(env, event.scheduledTime));
  }
};

/* ============================== Cron dispatcher ==============================
 * The trigger fires every minute, but each job runs on its own cadence:
 *   - pre-release alerts on minutes divisible by 5
 *   - release results on EVEN minutes
 * Why not every minute for everything: dedupe markers live in KV, which is
 * eventually consistent across locations for up to ~60 s, and cron invocations
 * don't always run in the same place. Two invocations a minute apart could both
 * read "not sent yet" and notify twice. A 2-minute gap outlasts propagation,
 * and results still land within ~2 minutes of TradingView publishing them. */
async function cronTick(env, scheduledTime) {
  const minute = new Date(scheduledTime || Date.now()).getUTCMinutes();

  // Liveness heartbeat every 10 min (144 KV writes/day, well inside the free
  // 1,000). The alerts depend on this cron, so "is it actually running?" must
  // be answerable with one request: GET /results/probe.
  if (minute % 10 === 0) {
    try {
      await env.FX_SUBS.put('cron:last', JSON.stringify({
        ranAt: new Date().toISOString(),
        scheduledAt: new Date(scheduledTime || Date.now()).toISOString(),
      }));
    } catch (e) { /* never let monitoring break the alerts */ }
  }
  const doAlerts = minute % 5 === 0;
  const doResults = minute % 2 === 0;
  if (!doAlerts && !doResults) return;

  const groups = await redFolder(env);
  if (!groups) return;

  if (doAlerts) await newsAlerts(env, groups);
  if (doResults) {
    await releaseResults(env, groups);
    await commentaryFires(env, groups);
  }
}

/* ForexFactory red folders, cached in KV for an hour (the feed itself refreshes
 * hourly and asks not to be hammered). If ForexFactory is unreachable, keep
 * using the last copy rather than going silent. */
const FF_CACHE_KEY = 'ff:redfolder:v1';
const FF_TTL_MS = 60 * 60000;
async function redFolder(env) {
  let cached = null;
  try { cached = JSON.parse((await env.FX_SUBS.get(FF_CACHE_KEY)) || 'null'); } catch (e) {}
  if (cached && Date.now() - cached.fetchedAt < FF_TTL_MS) return cached.groups;
  try {
    const groups = await fetchRedFolder();
    await env.FX_SUBS.put(FF_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), groups }));
    return groups;
  } catch (e) {
    return cached ? cached.groups : null;
  }
}

/* ============================ Pre-release alerts ============================ */
async function newsAlerts(env, groups) {
  const now = Date.now();
  const windows = [
    { tag: '60', lo: 55, hi: 65, label: 'in 1 hour' },
    { tag: '15', lo: 10, hi: 20, label: 'in 15 minutes' },
  ];
  for (const g of groups) {
    const mins = (Date.parse(g.when) - now) / 60000;
    for (const w of windows) {
      if (mins <= w.lo || mins > w.hi) continue;
      const dedupeKey = 'alert:' + g.id + ':' + w.tag;
      if (await env.FX_SUBS.get(dedupeKey)) continue;
      await env.FX_SUBS.put(dedupeKey, '1', { expirationTtl: 172800 });
      await broadcast(env, buildPreAlert(g, w.label));
    }
  }
}

/* ============================ Release results ================================
 * After each red-folder group's release time, look up the actual figures
 * (TradingView; matching shared with the local follow-up in release-match.js)
 * and push them once. Groups that are only speeches/statements carry no figures
 * and are skipped. Central-bank decisions keep looking longer, because their
 * release times are often tentative. */
const RESULT_WINDOW_MS = 45 * 60000;
const DECISION_WINDOW_MS = 180 * 60000;
const SETTLE_MS = 3 * 60000;            // some lines in, others lagging: wait at most this
const RESULTS_KEY = 'results:v1';

async function releaseResults(env, groups) {
  const now = Date.now();
  for (const g of groups) {
    if (!g.numeric) continue;
    const t = Date.parse(g.when);
    const windowMs = g.decision ? DECISION_WINDOW_MS : RESULT_WINDOW_MS;
    if (isNaN(t) || now < t || now - t > windowMs) continue;

    const sentKey = 'result:' + g.id;
    if (await env.FX_SUBS.get(sentKey)) continue;

    let tv;
    try { tv = await fetchCalendar(g.ccy, t, { spanMin: g.decision ? 150 : 10 }); }
    catch (e) { continue; }                    // TradingView unavailable: retry next pass

    const m = matchGroup(g, tv);
    if (!m.anyActual) continue;                // not published yet

    if (!m.complete) {
      const seenKey = 'resultseen:' + g.id;
      const seen = await env.FX_SUBS.get(seenKey);
      if (!seen) { await env.FX_SUBS.put(seenKey, String(now), { expirationTtl: 7200 }); continue; }
      if (now - Number(seen) < SETTLE_MS) continue;
    }

    await env.FX_SUBS.put(sentKey, '1', { expirationTtl: 3 * 86400 });   // mark BEFORE sending
    await broadcast(env, buildResultNotification(g, m));
    await saveResult(env, { id: g.id, when: g.when, ccy: g.ccy, lines: m.lines, at: new Date(now).toISOString() });
    await fireRoutine(env, g, m);
  }
}

/* Start the cloud analyst routine for this release through its API trigger.
 * Configured by ROUTINE_ID (wrangler.toml [vars]) and ROUTINE_FIRE_TOKEN (a
 * secret generated in the routine's edit page at claude.ai/code/routines). Does
 * nothing until both exist. The routine receives `text` wrapped as untrusted
 * payload data; its saved prompt says how to use it. Each fire counts toward the
 * account's daily routine-run cap. */
async function fireRoutine(env, g, m) {
  if (!env.ROUTINE_ID || !env.ROUTINE_FIRE_TOKEN) return;
  const key = 'fire:' + g.id;
  if (await env.FX_SUBS.get(key)) return;
  await env.FX_SUBS.put(key, '1', { expirationTtl: 3 * 86400 });       // mark BEFORE firing
  const figures = m.lines.filter((l) => l.actual != null).map((l) =>
    `- ${l.title}: actual ${l.actual}` +
    (l.forecast ? ` (forecast ${l.forecast}${l.cmp ? ', ' + l.cmp : ''})` : '') +
    (l.previous ? `, previous ${l.previous}` : ''));
  const text = [
    `RED-FOLDER RELEASE ${g.id}`,
    `Currency: ${g.ccy}`,
    `Released at: ${g.when}`,
    `Red-folder lines: ${g.lines.map((l) => l.title).join(', ')}`,
    'Figures (ForexFactory format; actuals from TradingView):',
    ...figures,
  ].join('\n');
  let outcome;
  try {
    const res = await postRoutineFire(env, text);
    outcome = { id: g.id, status: res.status, at: new Date().toISOString() };
    if (res.status >= 300) outcome.detail = res.body.slice(0, 200);
  } catch (e) {
    outcome = { id: g.id, error: String((e && e.message) || e), at: new Date().toISOString() };
  }
  await env.FX_SUBS.put('fire:last', JSON.stringify(outcome), { expirationTtl: 14 * 86400 });
}

async function postRoutineFire(env, text) {
  const r = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${env.ROUTINE_ID}/fire`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.ROUTINE_FIRE_TOKEN,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  let body = '';
  try { body = (await r.text()).slice(0, 500); } catch (e) {}
  return { status: r.status, body };
}

/* Second pass on a central-bank event (added 2026-09-20). An hour after a press
 * conference — or 45 minutes after a speech, or after a decision that has no
 * press conference — start the routine again to analyse what was SAID: the
 * statement, the vote split, the projections/dot plot and the press conference.
 * None of that is readable at release time, so the figure pass cannot cover it. */
async function commentaryFires(env, groups) {
  if (!env.ROUTINE_ID || !env.ROUTINE_FIRE_TOKEN) return;
  const now = Date.now();
  for (const c of commentaryGroups(groups)) {
    const due = Date.parse(c.dueAt);
    if (isNaN(due) || now < due || now - due > COMMENTARY_STALE_H * 3600000) continue;

    const key = 'comm:' + c.id;
    if (await env.FX_SUBS.get(key)) continue;
    await env.FX_SUBS.put(key, '1', { expirationTtl: 3 * 86400 });      // mark BEFORE firing

    // Quote the figures already pushed for this event, when it had any.
    const decisionGroup = c.kind === 'presser' ? relatedDecision(c, groups) : null;
    const figureId = decisionGroup ? decisionGroup.id : (c.decision ? c.id : null);
    let result = null;
    if (figureId) {
      try {
        const list = JSON.parse((await env.FX_SUBS.get(RESULTS_KEY)) || '[]');
        result = list.find((x) => x.id === figureId) || null;
      } catch (e) { /* figures are a bonus here, not a requirement */ }
    }

    let outcome;
    try {
      const res = await postRoutineFire(env, buildCommentaryPayload(c, { decisionGroup, result }));
      outcome = { id: c.id, kind: c.kind, status: res.status, at: new Date().toISOString() };
      if (res.status >= 300) outcome.detail = res.body.slice(0, 200);
    } catch (e) {
      outcome = { id: c.id, kind: c.kind, error: String((e && e.message) || e), at: new Date().toISOString() };
    }
    await env.FX_SUBS.put('comm:last', JSON.stringify(outcome), { expirationTtl: 14 * 86400 });
  }
}

/* Admin: prove the trigger works end to end without waiting for a release. The
 * routine's prompt answers a TRIGGER TEST payload with 'Trigger OK' and stops, so
 * this costs one short run (it still counts toward the daily run cap). */
async function testRoutine(url, env) {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  if (!env.ROUTINE_ID || !env.ROUTINE_FIRE_TOKEN) return json({ error: 'ROUTINE_ID or ROUTINE_FIRE_TOKEN is not set' }, 400);
  // `text` sends another read-only payload the prompt understands (EGRESS CHECK,
  // which reports what the sandbox can reach). Capped, and admin-gated above.
  const text = (url.searchParams.get('text') || '').slice(0, 2000) || ('TRIGGER TEST ' + new Date().toISOString());
  if (!/^(TRIGGER TEST|EGRESS CHECK)\b/.test(text)) return json({ error: 'text must start with TRIGGER TEST or EGRESS CHECK' }, 400);
  const res = await postRoutineFire(env, text);
  return json(res, res.status < 300 ? 200 : 502);
}

async function saveResult(env, rec) {
  let list = [];
  try { list = JSON.parse((await env.FX_SUBS.get(RESULTS_KEY)) || '[]'); } catch (e) {}
  list = [rec].concat(list.filter((x) => x.id !== rec.id)).slice(0, 40);
  await env.FX_SUBS.put(RESULTS_KEY, JSON.stringify(list));
}

async function getResults(env) {
  const body = (await env.FX_SUBS.get(RESULTS_KEY)) || '[]';
  return new Response(body, {
    headers: cors({ 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' })
  });
}

/* Admin health check, from Cloudflare's own network (egress IPs differ from a
 * laptop's): is TradingView reachable, is ForexFactory reachable, and when did
 * the cron last run? */
async function probeResults(url, env) {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  const to = new Date();
  const from = new Date(to.getTime() - 3 * 86400000);
  const r = await fetch(`${TV_URL}?from=${from.toISOString()}&to=${to.toISOString()}` +
    '&countries=US,EU,GB,JP,AU,NZ,CA,CH', { headers: TV_HEADERS });
  let events = [];
  try { const j = await r.json(); events = Array.isArray(j) ? j : (j.result || []); } catch (e) {}

  let ff;
  try {
    const groups = await fetchRedFolder();
    const next = groups.find((g) => Date.parse(g.when) > Date.now());
    ff = { ok: true, redGroups: groups.length, next: next ? next.id + ' — ' + next.lines.map((l) => l.title).join(', ') : null };
  } catch (e) {
    ff = { ok: false, error: String((e && e.message) || e) };
  }

  let lastCron = null;
  try { lastCron = JSON.parse((await env.FX_SUBS.get('cron:last')) || 'null'); } catch (e) {}
  let lastFire = null;
  try { lastFire = JSON.parse((await env.FX_SUBS.get('fire:last')) || 'null'); } catch (e) {}
  let lastCommentary = null;
  try { lastCommentary = JSON.parse((await env.FX_SUBS.get('comm:last')) || 'null'); } catch (e) {}
  let commentaryDue = [];
  try {
    const groups = await redFolder(env);
    commentaryDue = commentaryGroups(groups || []).filter((c) => Date.parse(c.dueAt) > Date.now())
      .map((c) => `${c.dueAt} ${c.ccy} ${c.kind}: ${c.lines.map((l) => l.title).join(', ')}`);
  } catch (e) {}
  return json({
    status: r.status, events: events.length,
    withActual: events.filter((e) => e.actual != null).length,
    ff,
    lastCron,                                   // null = the cron has not run since this was added
    lastFire,                                   // last routine fire for figures: HTTP status or error
    lastCommentary,                             // last "what was said" fire
    commentaryDue,                              // upcoming commentary passes this week
  });
}

/* Send a payload to every subscriber; prune expired subscriptions. */
async function broadcast(env, payload) {
  const list = await env.FX_SUBS.list({ prefix: 'sub:' });
  const cfg = {
    vapidPublicKey: env.VAPID_PUBLIC, vapidPrivateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', ttl: 1800
  };
  const body = JSON.stringify(payload);
  for (const k of list.keys) {
    const v = await env.FX_SUBS.get(k.name);
    if (!v) continue;
    try {
      const status = await sendWebPush(JSON.parse(v), body, cfg);
      if (status === 404 || status === 410) await env.FX_SUBS.delete(k.name);
    } catch (e) { /* keep going */ }
  }
}

/* ============================ Shared trade journal ============================
 * One journal for both users, stored as a single KV blob. Auth: the app sends
 * x-fx-auth = SHA-256("journal:" + passcode), which must equal the JOURNAL_KEY
 * secret. The raw passcode never lives in the public repo. */
async function journal(request, env) {
  if (request.headers.get('x-fx-auth') !== env.JOURNAL_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const KEY = 'journal:v1';
  const state = JSON.parse((await env.FX_SUBS.get(KEY)) || '{"trades":[]}');

  if (request.method === 'GET') return json(state);
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  const req = await request.json();
  if (req.op === 'add' && req.trade) {
    req.trade.id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.trades.unshift(req.trade);
  } else if (req.op === 'close' && req.id) {
    const t = state.trades.find((x) => x.id === req.id);
    if (t) { t.status = 'closed'; t.resultR = req.resultR; t.closedTs = req.closedTs || new Date().toISOString(); }
  } else if (req.op === 'delete' && req.id) {
    state.trades = state.trades.filter((x) => x.id !== req.id);
  } else {
    return json({ error: 'bad op' }, 400);
  }
  state.trades = state.trades.slice(0, 500);   // sanity cap
  await env.FX_SUBS.put(KEY, JSON.stringify(state));
  return json(state);
}

async function oandaGet(path, env) {
  const r = await fetch(OANDA_BASE + path, {
    headers: { Authorization: 'Bearer ' + env.OANDA_TOKEN, 'Accept-Datetime-Format': 'RFC3339' }
  });
  if (!r.ok) throw new Error('OANDA ' + r.status);
  return r.json();
}

async function quotes(url, env) {
  const syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
  if (!syms.length) return json({});
  const instruments = syms.map(toOanda).join(',');

  // current pricing (bid/ask)
  const pricing = await oandaGet(
    `/accounts/${env.OANDA_ACCOUNT}/pricing?instruments=${encodeURIComponent(instruments)}`, env);

  // previous daily close per instrument for day-change %
  const out = {};
  for (const p of (pricing.prices || [])) {
    const sym = fromOanda(p.instrument);
    const bid = parseFloat(p.bids && p.bids[0] && p.bids[0].price);
    const ask = parseFloat(p.asks && p.asks[0] && p.asks[0].price);
    const mid = (isFinite(bid) && isFinite(ask)) ? (bid + ask) / 2 : (isFinite(bid) ? bid : ask);
    out[sym] = { bid, ask, mid, changePct: null, ts: new Date().toISOString() };
  }
  // day change from the last two daily candles (one batched call per symbol; FX
  // universe is small enough — and the worker is free).
  await Promise.all(syms.map(async (sym) => {
    try {
      const c = await oandaGet(`/instruments/${toOanda(sym)}/candles?count=2&granularity=D&price=M`, env);
      const cs = c.candles || [];
      if (cs.length >= 2 && out[sym]) {
        const prev = parseFloat(cs[0].mid.c);
        const now = out[sym].mid;
        if (isFinite(prev) && prev) out[sym].changePct = ((now - prev) / prev) * 100;
      }
    } catch (e) { /* leave changePct null */ }
  }));
  return json(out);
}

async function sparkline(url, env) {
  const sym = url.searchParams.get('symbol');
  const points = Math.min(parseInt(url.searchParams.get('points') || '24', 10), 100);
  if (!sym) return json({ closes: [] });
  const c = await oandaGet(`/instruments/${toOanda(sym)}/candles?count=${points}&granularity=H1&price=M`, env);
  const closes = (c.candles || []).filter((x) => x.complete !== false).map((x) => parseFloat(x.mid.c));
  return json({ closes });
}

async function subscribe(request, env) {
  const sub = await request.json();
  if (!sub || !sub.endpoint) return json({ error: 'invalid subscription' }, 400);
  // key by endpoint hash so re-subscribes overwrite
  const id = await hash(sub.endpoint);
  await env.FX_SUBS.put('sub:' + id, JSON.stringify(sub));
  return json({ ok: true });
}

async function listSubs(url, env) {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  const list = await env.FX_SUBS.list({ prefix: 'sub:' });
  const subs = [];
  for (const k of list.keys) {
    const v = await env.FX_SUBS.get(k.name);
    if (v) subs.push(JSON.parse(v));
  }
  return json({ subscriptions: subs });
}

async function hash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
