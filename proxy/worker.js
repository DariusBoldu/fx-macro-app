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
const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';

// Lock this down to your Pages origin in production, e.g.
//   'https://<user>.github.io'
const ALLOW_ORIGIN = '*';

function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
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
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

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
