/* ============================================================================
 * FX Macro — Cloudflare Worker (free tier).
 *
 * Jobs, so the static PWA needs no secrets of its own:
 *   1) PRICE PROXY for OANDA practice (dormant — the app shows no prices):
 *        GET /quotes?symbols=EUR/USD,GBP/USD
 *        GET /sparkline?symbol=EUR/USD&points=24
 *   2) PUSH SUBSCRIPTION COLLECTOR (stores devices in KV for the push sender):
 *        POST /subscribe            body = PushSubscription JSON + {label, app}  (public)
 *        POST /unsubscribe          body = {endpoint}  -> forget that device       (public)
 *        POST /push/self            body = {endpoint}  -> test push to THAT device (public, 1/min)
 *        GET  /subscriptions?key=…  -> all subs with device id, label, last seen   (admin)
 *   3) SHARED TRADE JOURNAL:  GET/POST /journal  (x-fx-auth)
 *   4) RED-FOLDER NEWS (cron — laptop not involved), ForexFactory red folders
 *      for the app's 8 currencies only:
 *        - push 60 and 15 minutes before each release
 *        - push the ACTUAL figures moments after it is released
 *        GET /results               -> recent released figures     (public)
 *        GET /results/probe?key=…   -> FF + TradingView reachable, last cron tick (admin)
 *      and after each release, fire the cloud analyst routine's API trigger:
 *        POST /routine/test?key=…   -> fire it with a TRIGGER TEST / EGRESS CHECK /
 *                                      US30 DRY RUN payload (admin; nothing is published)
 *        POST /routine/index-update?key=…&kind=NY&note=…  -> re-run an index update now (admin; publishes)
 *   5) US30 TRACKER for the analyst and the app (see ./indices.js): BlackBull
 *      Markets' US30 CFD, the chart Darius trades, live from TradingView:
 *        GET /us30                  -> live levels, session ranges, the published
 *                                      level map's status, scorecard
 *        GET /us30?live=0           -> record and scorecard only
 *      and, when US30_FIRE = "on", fire the routine three times per US trading
 *      day: US30 LONDON UPDATE (40 min before the London open), MIDDAY UPDATE
 *      (14:00 Bucharest) and NY UPDATE (40 min before the NY cash open); when
 *      US30_OPEN_ALERT = "on", push at the London and NY opens which side of
 *      the level map is live.

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
  TV_URL, TV_HEADERS, bucharestTime,
} from './release-match.js';
import {
  US30, fetchMarket, publicMarket, tradeDate, isTradingDay, prevTradingDay, sessionTimes, phaseAt,
  advanceRecord, recordDue, summarizeScores, levelsText, planStatus, openAlert, bucClock, updateFires,
} from './indices.js';

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    try {
      if (url.pathname === '/quotes') return await quotes(url, env);
      if (url.pathname === '/sparkline') return await sparkline(url, env);
      if (url.pathname === '/subscribe' && request.method === 'POST') return await subscribe(request, env);
      if (url.pathname === '/unsubscribe' && request.method === 'POST') return await unsubscribe(request, env);
      if (url.pathname === '/push/self' && request.method === 'POST') return await selfTest(request, env, ctx);
      if (url.pathname === '/subscriptions') return await listSubs(url, env);
      if (url.pathname === '/journal') return await journal(request, env);
      if (url.pathname === '/results') return await getResults(env);
      if (url.pathname === '/results/probe') return await probeResults(url, env);
      if (url.pathname === '/routine/test' && request.method === 'POST') return await testRoutine(url, env);
      if (url.pathname === '/routine/index-update' && request.method === 'POST') return await indexRerun(url, env);
      if (url.pathname === '/us30') return await getUs30(url, env);
      if (url.pathname === '/nas100') return json({ error: 'NAS100 was removed on 2026-11-23; only US30 is tracked' }, 410);
      if (url.pathname === '/push/test' && request.method === 'POST') {
        if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
        const results = await broadcast(env, {
          title: '🔔 FX Macro — Worker test',
          body: 'Sent by the Cloudflare Worker, the same path as the 1-hour / 15-minute warnings and release figures.',
          url: './', tag: 'worker-test',
        });
        return json({ sent: results.length, results });
      }
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
  // Index-futures sampling shares the even-minute cadence (same KV-propagation reason).
  if (doResults) {
    try { await indexJob(env, scheduledTime || Date.now()); } catch (e) {
      try { await env.FX_SUBS.put('us30:err', JSON.stringify({ at: new Date().toISOString(), error: String((e && e.message) || e).slice(0, 200) }), { expirationTtl: 7 * 86400 }); } catch (e2) {}
    }
  }
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
    await broadcast(env, buildResultNotification(g, m), 3 * 3600);
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
  if (!/^(TRIGGER TEST|EGRESS CHECK|US INDICES DRY RUN|US30 DRY RUN)\b/.test(text)) return json({ error: 'text must start with TRIGGER TEST, EGRESS CHECK or US30 DRY RUN' }, 400);
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
  let lastPush = null;
  try { lastPush = JSON.parse((await env.FX_SUBS.get('push:last')) || 'null'); } catch (e) {}
  let lastSelfTest = null;
  try { lastSelfTest = JSON.parse((await env.FX_SUBS.get('selftest:last')) || 'null'); } catch (e) {}
  let lastCommentary = null;
  try { lastCommentary = JSON.parse((await env.FX_SUBS.get('comm:last')) || 'null'); } catch (e) {}
  let us30 = null;
  try {
    us30 = {
      lastError: JSON.parse((await env.FX_SUBS.get('us30:err')) || 'null'),
      lastFire: JSON.parse((await env.FX_SUBS.get('us30fire:last')) || 'null'),
      fireEnabled: env.US30_FIRE === 'on',
      lastOpenAlert: JSON.parse((await env.FX_SUBS.get('us30:alert:last')) || 'null'),
      openAlertEnabled: env.US30_OPEN_ALERT === 'on',
    };
  } catch (e) {}
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
    lastPush,                                   // Apple's reply per device on the last Worker push
    lastSelfTest,                               // the last "Send test" tapped in the app
    commentaryDue,                              // upcoming commentary passes this week
    us30,                                       // US30 tracker: last error, last update fire, last open alert
  });
}

/* Send a payload to every subscriber; prune expired subscriptions. */
function pushCfg(env, ttl) {
  return {
    vapidPublicKey: env.VAPID_PUBLIC, vapidPrivateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', ttl,
  };
}
/* ttl = how long Apple keeps trying a phone that is asleep or offline: 30 min
 * for warnings (stale after the release), 3 h for released figures. */
async function broadcast(env, payload, ttl = 1800) {
  const list = await env.FX_SUBS.list({ prefix: 'sub:' });
  const cfg = pushCfg(env, ttl);
  const body = JSON.stringify(payload);
  // Record Apple's answer for every device. Until 2026-11-10 these were thrown
  // away, so a Worker push that Apple rejected (pre-alerts, release figures) was
  // indistinguishable from one that arrived. GET /results/probe shows the last send.
  const results = [];
  for (const k of list.keys) {
    const v = await env.FX_SUBS.get(k.name);
    if (!v) continue;
    let status;
    try {
      status = await sendWebPush(JSON.parse(v), body, cfg);
      if (status === 404 || status === 410) await env.FX_SUBS.delete(k.name);
    } catch (e) { status = 'error: ' + String((e && e.message) || e).slice(0, 120); }
    results.push({ device: k.name.slice(-6), status });
  }
  try {
    await env.FX_SUBS.put('push:last', JSON.stringify({
      at: new Date().toISOString(), title: String(payload.title || '').slice(0, 80), results,
    }), { expirationTtl: 14 * 86400 });
  } catch (e) { /* monitoring must never block a send */ }
  return results;
}

/* ================================ US30 tracker ================================
 * BlackBull's US30 CFD, live (see ./indices.js). The even-minute job only
 * touches the feed when the day record needs it: a window opening (open price,
 * the analyst's call, the open alert) or closing (close + score). KV writes are
 * a handful a day. Keys: us30:d:<date>, us30:scores, us30:err, us30fire:*. */
const REC_KEY = (d) => 'us30:d:' + d;
const SCORES_KEY = 'us30:scores';
const APP_DATA_URL = 'https://raw.githubusercontent.com/DariusBoldu/fx-macro-app/main/data.json';

async function readRec(env, d) {
  try { return d ? JSON.parse((await env.FX_SUBS.get(REC_KEY(d))) || 'null') : null; } catch (e) { return null; }
}

async function indexJob(env, now) {
  const td = tradeDate(now);
  if (!isTradingDay(td)) return;
  const t = sessionTimes(td);
  await indexFire(env, td, t, now);
  if (now < t.lonOpen || now > t.nyClose + 15 * 60000) return;
  const rec = (await readRec(env, td)) || { date: td };
  if (!recordDue(rec, now)) return;
  const mk = await fetchMarket(now);
  const U = await readUs30(td);                      // the published map, for calls and the open alert
  const callFor = (k) => {
    const x = U && U.sessions && U.sessions[k];
    return x && /^(BULLISH|BEARISH|RANGE)$/.test(x.lean) ? { bias: x.lean, conviction: x.conviction || U.conviction || null } : null;
  };
  const { changed, scores, opened } = advanceRecord(rec, mk, now, callFor);
  if (opened.length) for (const k of opened) rec[k === 'london' ? 'lon' : 'ny'].alerted = env.US30_OPEN_ALERT === 'on';
  if (changed) await env.FX_SUBS.put(REC_KEY(td), JSON.stringify(rec), { expirationTtl: 30 * 86400 });   // before any push: dedupe
  if (scores.length) {
    let list = [];
    try { list = JSON.parse((await env.FX_SUBS.get(SCORES_KEY)) || '[]'); } catch (e) {}
    list = scores.concat(list.filter((x) => !scores.some((s) => s.date === x.date && s.s === x.s))).slice(0, 80);
    await env.FX_SUBS.put(SCORES_KEY, JSON.stringify(list));
  }
  if (env.US30_OPEN_ALERT !== 'on' || !opened.length || !U) return;
  const ps = planStatus(U, mk.bars, td);
  for (const k of opened) {
    const w = rec[k === 'london' ? 'lon' : 'ny'];
    const msg = openAlert(k, U, ps, mk.last != null ? mk.last : w.o);
    if (!msg) continue;
    // A unique tag: a repeated one makes iOS replace the old notification silently (no banner).
    const res = await broadcast(env, { title: msg.title, body: msg.body, url: './#us30', tag: 'us30-open-' + k + '-' + td }, 1800);
    try {
      await env.FX_SUBS.put('us30:alert:last', JSON.stringify({ at: new Date().toISOString(), session: k, title: msg.title, body: msg.body, sent: res.length, source: mk.source }), { expirationTtl: 14 * 86400 });
    } catch (e) {}
  }
}

/* The app's published us30 block, if it is for `td`. raw.githubusercontent
 * caches for minutes; the query string asks for a fresh copy. */
async function readUs30(td) {
  try {
    const r = await fetch(APP_DATA_URL + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const D = await r.json();
    return D.us30 && D.us30.date === td ? D.us30 : null;
  } catch (e) { return null; }
}

/* Intraday updates: start the analyst routine at each of the day's update
 * fires (see updateFires: LONDON, MIDDAY, NY) with the live BlackBull levels.
 * Gated by US30_FIRE = "on" (wrangler.toml [vars]). */
async function indexFire(env, td, t, now) {
  if (env.US30_FIRE !== 'on' || !env.ROUTINE_ID || !env.ROUTINE_FIRE_TOKEN) return;
  const f = updateFires(td).find((x) => now >= x.at && now <= x.at + 10 * 60000);
  if (!f) return;
  const key = f.key + td;
  if (await env.FX_SUBS.get(key)) return;
  await env.FX_SUBS.put(key, '1', { expirationTtl: 3 * 86400 });   // mark BEFORE firing
  const text = await indexPayload(env, f.kind, td, t);
  let outcome;
  try {
    const res = await postRoutineFire(env, text);
    outcome = { date: td, kind: f.kind, status: res.status, at: new Date().toISOString() };
    if (res.status >= 300) outcome.detail = res.body.slice(0, 200);
  } catch (e) {
    outcome = { date: td, kind: f.kind, error: String((e && e.message) || e), at: new Date().toISOString() };
  }
  await env.FX_SUBS.put('us30fire:last', JSON.stringify(outcome), { expirationTtl: 14 * 86400 });
}

/* The payload for one update: header, session times, then the live BlackBull
 * levels, today's ranges and how the published map has played out so far.
 * Shared by the scheduled fire and the admin re-run. */
async function indexPayload(env, kind, td, t, note) {
  const now = Date.now();
  let body;
  try {
    const mk = await fetchMarket(now);
    const rec = await readRec(env, td), U = await readUs30(td);
    body = levelsText(mk, rec, planStatus(U, mk.bars, td), U);
  } catch (e) {
    body = `US30: BlackBull snapshot unavailable from the Worker (${String((e && e.message) || e).slice(0, 120)}); work from news and GET /us30.`;
  }
  const at = (ms) => `${new Date(ms).toISOString()} (${bucClock(ms)} Bucharest)`;
  const head = [`US30 ${kind} UPDATE ${td}`, `London open: ${at(t.lonOpen)}; NY cash open: ${at(t.nyOpen)}`];
  if (note) head.push(`Re-run requested by Darius after this news (verify it before using it): ${note}`);
  return head.concat([body]).join('\n');
}

/* Admin: re-run an update now (e.g. after breaking news). Same payload as the
 * scheduled fire; kind = LONDON | MIDDAY | NY, note = the news that prompted it. */
async function indexRerun(url, env) {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  if (!env.ROUTINE_ID || !env.ROUTINE_FIRE_TOKEN) return json({ error: 'ROUTINE_ID or ROUTINE_FIRE_TOKEN is not set' }, 400);
  const kind = (url.searchParams.get('kind') || '').toUpperCase();
  if (!['LONDON', 'MIDDAY', 'NY'].includes(kind)) return json({ error: 'kind must be LONDON, MIDDAY or NY' }, 400);
  const note = (url.searchParams.get('note') || '').slice(0, 300);
  const now = Date.now(), td = tradeDate(now), t = sessionTimes(td);
  const text = await indexPayload(env, kind, td, t, note);
  const res = await postRoutineFire(env, text);
  await env.FX_SUBS.put('us30fire:last', JSON.stringify({ date: td, kind, rerun: true, status: res.status, at: new Date().toISOString() }), { expirationTtl: 14 * 86400 });
  return json({ status: res.status, body: res.body, text }, res.status < 300 ? 200 : 502);
}

/* GET /us30: live BlackBull snapshot, today's ranges, the published map's
 * status (by session, keyed by the map's `at`), the record and the scorecard.
 * ?live=0 skips the feed (track record only). */
async function getUs30(url, env) {
  const now = Date.now(), td = tradeDate(now), t = sessionTimes(td);
  const wantLive = url.searchParams.get('live') !== '0';
  let mk = null, liveError = null, plan = null, U = null;
  const today = await readRec(env, td), prev = await readRec(env, prevTradingDay(td));
  if (wantLive) {
    try {
      mk = await fetchMarket(now);
      if (mk.error) liveError = mk.error;
      U = await readUs30(td);
      plan = planStatus(U, mk.bars, td);
    } catch (e) { liveError = String((e && e.message) || e); }
  }
  // While a window runs, show its live range on top of the stored open.
  const merged = today ? JSON.parse(JSON.stringify(today)) : null;
  if (merged && mk) for (const k of ['lon', 'ny']) if (merged[k] && merged[k].c == null && mk[k]) Object.assign(merged[k], { h: mk[k].h, l: mk[k].l, last: mk.last });
  let scores = [];
  try { scores = JSON.parse((await env.FX_SUBS.get(SCORES_KEY)) || '[]'); } catch (e) {}
  const iso = (ms) => new Date(ms).toISOString();
  return new Response(JSON.stringify({
    index: US30.label, symbol: US30.symbol, feed: US30.feed,
    tradeDate: td, tradingDay: isTradingDay(td), phase: phaseAt(td, now),
    sessions: {
      londonOpen: iso(t.lonOpen), nyOpen: iso(t.nyOpen), nyClose: iso(t.nyClose),
      bucharest: { london: bucClock(t.lonOpen), ny: bucClock(t.nyOpen), close: bucClock(t.nyClose) },
    },
    live: publicMarket(mk), liveError, plan, today: merged, prev,
    scores: { summary: summarizeScores(scores), recent: scores.slice(0, 20) },
    text: mk ? levelsText(mk, today, plan, U) : null,
  }), { headers: cors({ 'Content-Type': 'application/json', 'Cache-Control': 'max-age=20' }) });
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

/* Device registry. Since v33 (2026-11-17) the app re-posts its subscription
 * every time it opens, so `lastSeen` tells a live device from a dead one: Apple
 * keeps answering 201 for a subscription iOS has silently dropped on the phone,
 * which made a phone that had stopped receiving look healthy from here.
 * Only real push services are accepted, so the Worker can't be pointed at an
 * arbitrary URL. */
const PUSH_HOSTS = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const subKey = async (endpoint) => 'sub:' + await hash(endpoint);
async function readEndpoint(request) {
  const b = await request.json().catch(() => null);
  return b && typeof b.endpoint === 'string' && PUSH_HOSTS.test(b.endpoint) ? b : null;
}

async function subscribe(request, env) {
  const b = await readEndpoint(request);
  if (!b || !b.keys || !b.keys.p256dh || !b.keys.auth) return json({ error: 'invalid subscription' }, 400);
  // key by endpoint hash so re-subscribes overwrite
  const key = await subKey(b.endpoint);
  const prev = JSON.parse((await env.FX_SUBS.get(key)) || 'null');
  const now = new Date().toISOString();
  const rec = {
    endpoint: b.endpoint,
    keys: { p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) },
    label: String(b.label || (prev && prev.label) || '').slice(0, 20),
    app: String(b.app || (prev && prev.app) || '').slice(0, 10),
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
  };
  await env.FX_SUBS.put(key, JSON.stringify(rec));
  return json({ ok: true, device: key.slice(-6), known: !!prev });
}

async function unsubscribe(request, env) {
  const b = await readEndpoint(request);
  if (!b) return json({ error: 'invalid endpoint' }, 400);
  await env.FX_SUBS.delete(await subKey(b.endpoint));
  return json({ ok: true });
}

/* "Send a test to this device" from the app. Only reaches an endpoint that is
 * already registered, at most once a minute per device. `delay` (0-10 s) gives
 * the user time to leave the app so the banner shows as it would for a real
 * alert; waitUntil keeps the send alive if iOS suspends the page meanwhile.
 * The outcome is kept in KV (selftest:last) so a failed check can be read later. */
async function selfTest(request, env, ctx) {
  const b = await readEndpoint(request);
  if (!b) return json({ error: 'invalid endpoint' }, 400);
  const key = await subKey(b.endpoint);
  const v = await env.FX_SUBS.get(key);
  if (!v) return json({ registered: false });
  if (await env.FX_SUBS.get('selftest:' + key)) return json({ registered: true, error: 'wait a minute between tests' }, 429);
  await env.FX_SUBS.put('selftest:' + key, '1', { expirationTtl: 60 });
  const sub = JSON.parse(v);
  const delayMs = Math.min(Math.max(Number(b.delay) || 0, 0), 10) * 1000;
  const send = new Promise((r) => setTimeout(r, delayMs)).then(async () => {
    let status;
    try {
      status = await sendWebPush(sub, JSON.stringify({
        title: '🔔 FX Macro — test for this device',
        body: 'Alerts reach this ' + (sub.label || 'device') + '. Sent at ' + bucharestTime(Date.now()) + '.',
        url: './', tag: 'self-test-' + Date.now(),
      }), pushCfg(env, 600));
    } catch (e) { status = 'error: ' + String((e && e.message) || e).slice(0, 120); }
    if (status === 404 || status === 410) await env.FX_SUBS.delete(key);
    await env.FX_SUBS.put('selftest:last', JSON.stringify({
      at: new Date().toISOString(), device: key.slice(-6), label: sub.label || '', status,
    }), { expirationTtl: 30 * 86400 }).catch(() => {});
    return status;
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(send.catch(() => {}));
  const status = await send;
  if (status === 404 || status === 410) return json({ registered: false, status });
  return json({ registered: true, status, device: key.slice(-6) });
}

async function listSubs(url, env) {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  const list = await env.FX_SUBS.list({ prefix: 'sub:' });
  const subs = [];
  for (const k of list.keys) {
    const v = await env.FX_SUBS.get(k.name);
    if (v) subs.push(Object.assign({ device: k.name.slice(-6) }, JSON.parse(v)));
  }
  return json({ subscriptions: subs });
}

async function hash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
