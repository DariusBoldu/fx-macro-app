#!/usr/bin/env node
/* ============================================================================
 * send-push.js — fire a Web Push notification to all subscribed devices.
 *
 * Run by the daily task AFTER it publishes a fresh data.json, e.g.:
 *   node fx-macro-app/push/send-push.js "New FX report" "USD strong into PCE"
 *
 * Reads VAPID keys from push/vapid-private.txt (gitignored), pulls the device
 * list from the Cloudflare Worker's /subscriptions endpoint, and sends.
 *
 * Requires:  npm install   (in this folder — installs web-push)
 * Env / config it needs:
 *   SUBS_URL   = https://your-worker.workers.dev/subscriptions
 *   ADMIN_KEY  = the ADMIN_KEY secret you set on the worker
 * (either export them, or edit the CONFIG block below.)
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const CONFIG = {
  subsUrl: process.env.SUBS_URL || '',          // worker /subscriptions URL
  adminKey: process.env.ADMIN_KEY || '',        // worker ADMIN_KEY
};

function readVapid() {
  const file = path.join(__dirname, 'vapid-private.txt');
  const txt = fs.readFileSync(file, 'utf8');
  const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
  return { pub: get('VAPID_PUBLIC'), priv: get('VAPID_PRIVATE'), subject: get('VAPID_SUBJECT') || 'mailto:admin@example.com' };
}

async function main() {
  const title = process.argv[2] || 'FX Macro';
  const body = process.argv[3] || 'A new macro report has been published.';
  const url = process.argv[4] || './index.html';

  if (!CONFIG.subsUrl || !CONFIG.adminKey) {
    console.error('Set SUBS_URL and ADMIN_KEY (env or CONFIG block). Skipping push.');
    process.exit(0);   // exit 0 so it never breaks the daily task
  }

  let webpush;
  try { webpush = require('web-push'); }
  catch (e) { console.error('web-push not installed — run `npm install` in push/. Skipping.'); process.exit(0); }

  const v = readVapid();
  webpush.setVapidDetails(v.subject, v.pub, v.priv);

  const res = await fetch(CONFIG.subsUrl + (CONFIG.subsUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(CONFIG.adminKey));
  const { subscriptions = [] } = await res.json();
  if (!subscriptions.length) { console.log('No subscribers.'); return; }

  const payload = JSON.stringify({ title, body, url, tag: 'fx-macro-report' });
  let ok = 0, gone = 0;
  await Promise.all(subscriptions.map(async (sub) => {
    try { await webpush.sendNotification(sub, payload); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone++; else console.warn('push error', e.statusCode); }
  }));
  console.log(`Push sent: ${ok} ok, ${gone} expired (of ${subscriptions.length}).`);
}

main().catch((e) => { console.error(e); process.exit(0); });
