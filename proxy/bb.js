/* ============================================================================
 * Live candles for one TradingView symbol over TradingView's chart websocket
 * (the feed its own charts use; no login, read-only).
 *
 * Darius trades the US30 CFD of BlackBull Markets (BLACKBULL:US30, 2026-11-23).
 * That broker feed is real-time ("streaming") on TradingView, unlike the CME
 * futures, which are 10 minutes late without a subscription. It is not in the
 * public screener, so the candles come from the chart websocket instead:
 *   one chart session per series (an anonymous session allows one series),
 *   5-minute candles for the session ranges, VWAP and the plan tracker, and
 *   daily candles for the previous day, ATR, week and month.
 * A fetch takes about 0.3 s. Candles are [time (s), open, high, low, close,
 * volume (ticks)]; the last one is still forming, so its close is the live price.
 *
 * `connect(url)` must return a WebSocket-like object (send, close,
 * addEventListener 'message'/'close'/'error') that is open or opening. The
 * default is the Cloudflare Workers way: fetch() with an Upgrade header.
 * ==========================================================================*/

export const TV_WS_URL = 'https://data.tradingview.com/socket.io/websocket?from=chart';

export async function workerConnect(url) {
  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Origin: 'https://www.tradingview.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error('TradingView websocket refused (HTTP ' + resp.status + ')');
  ws.accept();
  return ws;
}

const frame = (o) => { const s = JSON.stringify(o); return '~m~' + s.length + '~m~' + s; };
const rid = () => Math.random().toString(36).slice(2, 12);

/* specs: [{ id: 's5', tf: '5', n: 600 }, { id: 'sD', tf: '1D', n: 40 }]
 * -> { s5: [[t,o,h,l,c,v], ...], sD: [...] } (oldest first). */
export async function tvCandles(symbol, specs, opts = {}) {
  const connect = opts.connect || workerConnect;
  const timeoutMs = opts.timeoutMs || 9000;
  const ws = await connect(TV_WS_URL);
  const out = {}, done = new Set();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, 'done'); } catch (e) {}
      if (err) reject(err); else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error('TradingView websocket timeout (' + [...done].join(',') + ' of ' + specs.map((s) => s.id).join(',') + ')')), timeoutMs);
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      ws.send(frame({ m: 'set_auth_token', p: ['unauthorized_user_token'] }));
      for (const s of specs) {
        const cs = 'cs_' + rid();
        ws.send(frame({ m: 'chart_create_session', p: [cs, ''] }));
        ws.send(frame({ m: 'resolve_symbol', p: [cs, 'sym1', '=' + JSON.stringify({ symbol, adjustment: 'splits' })] }));
        ws.send(frame({ m: 'create_series', p: [cs, s.id, s.id, 'sym1', s.tf, s.n, ''] }));
      }
    };
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const parts = raw.split(/~m~\d+~m~/).filter(Boolean);
      for (const part of parts) {
        if (/^~h~\d+$/.test(part)) { try { ws.send('~m~' + part.length + '~m~' + part); } catch (e) {} continue; }   // heartbeat: echo it
        let j;
        try { j = JSON.parse(part); } catch (e) { continue; }
        if (j && j.session_id) { start(); continue; }
        if (!j || !j.m) continue;
        if (j.m === 'timescale_update' || j.m === 'du') {
          for (const [id, v] of Object.entries((j.p && j.p[1]) || {})) {
            if (!v || !Array.isArray(v.s)) continue;
            const map = new Map((out[id] || []).map((b) => [b[0], b]));
            for (const b of v.s) if (Array.isArray(b.v)) map.set(b.v[0], b.v);
            out[id] = [...map.values()].sort((a, b) => a[0] - b[0]);
          }
        } else if (j.m === 'series_completed') {
          done.add(j.p && j.p[1]);
          if (specs.every((s) => done.has(s.id))) finish();
        } else if (/error/.test(j.m)) {
          finish(new Error('TradingView ' + j.m + ': ' + JSON.stringify(j.p).slice(0, 160)));
        }
      }
    });
    ws.addEventListener('close', () => finish(specs.every((s) => done.has(s.id)) ? null : new Error('TradingView websocket closed early')));
    ws.addEventListener('error', () => finish(new Error('TradingView websocket error')));
  });
}
