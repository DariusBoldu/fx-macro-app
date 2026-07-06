/* ============================================================================
 * FX Macro — Cloudflare Worker (free tier).
 *
 * Does two jobs so the static PWA needs no secrets of its own:
 *   1) PRICE PROXY for OANDA practice (keeps the bearer token server-side and
 *      adds the CORS headers OANDA itself doesn't send):
 *        GET /quotes?symbols=EUR/USD,GBP/USD
 *        GET /sparkline?symbol=EUR/USD&points=24
 *   2) PUSH SUBSCRIPTION COLLECTOR (stores devices in KV for the push sender):
 *        POST /subscribe            body = PushSubscription JSON   (public)
 *        GET  /subscriptions?key=…  -> all subs                    (admin)
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

const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';
const DATA_URL = 'https://dariusboldu.github.io/fx-macro-app/data.json';

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
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  /* Cron (every 5 min): push alerts 60 and 15 minutes before each HIGH-impact
   * catalyst that carries a machine-readable `when` timestamp. Runs entirely
   * in the cloud — the laptop is not involved. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(newsAlerts(env));
  }
};

/* ========================= High-impact news alerts ========================= */
async function newsAlerts(env) {
  let data;
  try {
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
    data = await r.json();
  } catch (e) { return; }
  const now = Date.now();
  const windows = [
    { tag: '60', lo: 55, hi: 65, label: 'in 1 hour' },
    { tag: '15', lo: 10, hi: 20, label: 'in 15 minutes' },
  ];
  for (const c of (data.catalysts || [])) {
    if (c.impact !== 'high' || !c.when) continue;
    const t = Date.parse(c.when);
    if (isNaN(t)) continue;
    const mins = (t - now) / 60000;
    for (const w of windows) {
      if (mins <= w.lo || mins > w.hi) continue;
      const dedupeKey = 'alert:' + c.when + ':' + w.tag;
      if (await env.FX_SUBS.get(dedupeKey)) continue;
      await env.FX_SUBS.put(dedupeKey, '1', { expirationTtl: 172800 });
      await broadcast(env, {
        title: '⏰ ' + c.event + ' — ' + w.label,
        body: (c.note || 'High-impact event ahead.').slice(0, 160),
        tag: 'fx-event-' + c.when,
        url: './index.html'
      });
    }
  }
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
