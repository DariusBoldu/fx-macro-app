#!/usr/bin/env node
/* ============================================================================
 * send-push.js — fire a Web Push notification to all subscribed devices.
 *
 * Run automatically by the GitHub Action (.github/workflows/notify.yml) on each
 * data.json push, or manually:
 *   node fx-macro-app/push/send-push.js "New FX report" "USD strong into PCE"
 *
 * Secrets resolve from ENV FIRST, then the gitignored push/vapid-private.txt:
 *   VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, SUBS_URL, ADMIN_KEY
 * In CI there is no file — pass them as repo secrets (env). Locally/in the
 * daily sandbox the file is used.
 *
 * Proxy-aware: if HTTPS_PROXY/https_proxy is set (the Cowork sandbox routes all
 * egress through an allowlisting proxy), both the /subscriptions GET and every
 * web-push send go through it. With no proxy (GitHub Actions) it calls direct.
 *
 * Requires:  npm install   (in this folder — installs web-push)
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- secrets: ENV first, then the gitignored file (if present) -------------
function readSecrets() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(__dirname, 'vapid-private.txt'), 'utf8'); }
  catch (_) { /* no file in CI — env only */ }
  const fromFile = (k) => ((txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '').trim();
  const get = (k, dflt) => (process.env[k] && process.env[k].trim()) || fromFile(k) || dflt || '';
  return {
    pub: get('VAPID_PUBLIC'),
    priv: get('VAPID_PRIVATE'),
    subject: get('VAPID_SUBJECT', 'mailto:admin@example.com'),
    subsUrl: get('SUBS_URL'),
    adminKey: get('ADMIN_KEY'),
  };
}

// --- optional proxy agent (sandbox); undefined in CI -> direct calls --------
function makeProxyAgent() {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy ||
              process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!url) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent'); // transitive dep of web-push
    console.log('Routing push egress through proxy:', url);
    return new HttpsProxyAgent(url);
  } catch (e) {
    console.warn('https-proxy-agent unavailable; calling direct.', e.code || e.message);
    return undefined;
  }
}

// --- tiny JSON GET that honours the proxy agent ----------------------------
function getJson(url, agent) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('subscriptions HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        }
        try { resolve(JSON.parse(data || '{}')); }
        catch (e) { reject(new Error('bad JSON from subscriptions endpoint')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('subscriptions request timed out')));
  });
}

async function main() {
  const title = process.argv[2] || 'FX Macro';
  const body = process.argv[3] || 'A new macro report has been published.';
  const url = process.argv[4] || './index.html';

  const S = readSecrets();
  if (!S.subsUrl || !S.adminKey || !S.pub || !S.priv) {
    console.error('Missing VAPID_PUBLIC/PRIVATE, SUBS_URL or ADMIN_KEY (env or vapid-private.txt). Skipping push.');
    process.exit(0); // never break the publish flow
  }

  let webpush;
  try { webpush = require('web-push'); }
  catch (e) { console.error('web-push not installed — run `npm install` in push/. Skipping.'); process.exit(0); }

  webpush.setVapidDetails(S.subject, S.pub, S.priv);
  const agent = makeProxyAgent();

  const subsEndpoint = S.subsUrl + (S.subsUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(S.adminKey);
  const { subscriptions = [] } = await getJson(subsEndpoint, agent);
  if (!subscriptions.length) { console.log('No subscribers.'); return; }

  // Report texts are written by the analyst; convert any UTC clock time left in
  // them ("13:30Z", "13:30 GMT") to Bucharest time before it reaches a phone.
  const buc = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const toBuc = (txt) => String(txt).replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s?(?:Z|UTC|GMT)\b/g, (m, h, mi) => {
    const n = new Date(); return buc.format(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), +h, +mi));
  });
  // Unique tag per report: a repeated tag ('fx-macro-report' every morning) made
  // iOS replace yesterday's notification silently instead of alerting.
  const payload = JSON.stringify({ title: toBuc(title), body: toBuc(body), url, tag: 'fx-macro-report-' + Date.now() });
  // urgency high: iOS defers normal-priority pushes on an idle phone. TTL 6 h: a
  // report that cannot be delivered by then is stale (the library default is 4 weeks).
  const opts = Object.assign({ TTL: 6 * 3600, urgency: 'high' }, agent ? { agent } : {});
  let ok = 0, gone = 0;
  await Promise.all(subscriptions.map(async (sub) => {
    try { await webpush.sendNotification(sub, payload, opts); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone++; else console.warn('push error', e.statusCode || e.message); }
  }));
  console.log(`Push sent: ${ok} ok, ${gone} expired (of ${subscriptions.length}).`);
}

main().catch((e) => { console.error(e); process.exit(0); });
