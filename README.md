# FX Macro — mobile PWA

A mobile-first Progressive Web App for Darius (and his brother) — the same macro
intelligence as the desktop `Forex_Dashboard`, plus live prices, installable to
the iPhone/iPad home screen and updated by the existing daily Cowork task.

It mirrors the desktop data exactly: **7 currencies** (USD, EUR, GBP, JPY, AUD,
NZD, CAD), **21 symbols** (18 pairs + DXY + JPYBASKET + GER40), the same biases as
`fx_bias_indicator.pine`, the strength map with forward bias (🦅/🔻/⚖️), the
calendar, and the geopolitics/oil → FX read. Same dark theme.

## Screens (bottom tab bar)

| Tab | Shows |
|---|---|
| **Today** | regime line · single biggest upcoming catalyst (`meta.nextBigEvent`) · "what changed" · geopolitics→FX |
| **Strength** | 7-currency strength map (−3..+3 bars, verdict, drivers, forward bias), strongest→weakest |
| **Signals** | all 21 symbols as cards (Bias / Conviction / Why / Risk), filterable, with the live quote on each FX card |
| **Prices** | live quotes for the 18 tradable pairs — mid, day %, sparkline, bid/ask |
| **Calendar** | catalysts with impact dots (high/med/low) |

"Not financial advice — for your own decision-making." is on every screen.

---

## 1. Install on iPhone / iPad

1. Open the app URL in **Safari** (once it's on GitHub Pages — see §5).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the home-screen icon — it opens full-screen like a native app,
   works offline (cached shell + last report), and shows a splash on launch.
4. First launch asks for the **shared passcode** (default `swing2026` — change it,
   §3). "Remember me" keeps you unlocked on that device.

## 2. How updates flow

```
 Daily Cowork task  ──►  regenerates Forex_Dashboard/data.js  (unchanged)
        │
        ├─►  node fx-macro-app/scripts/build-data-json.js   ──►  data.json (+updatedAt)
        ├─►  git commit & push data.json to the app repo
        └─►  (optional) node push/send-push.js "title" "body"   ──►  push notification
                                                  │
 GitHub Pages serves data.json  ◄─────────────────┘
        │
 App polls data.json every 5 min + on resume; a changed updatedAt → "New report"
 toast (and a push if enabled).  Offline → last cached report.
```

The macro/bias/calendar content is **not computed in the app** — it's produced by
the task and published as `data.json`, the exact shape of `window.FX_DATA`.

**Honest limitation:** Cowork tasks are cron-based, so updates are *scheduled*, not
truly event-driven. We approximate "on a high-impact event" by timing task runs to
the day's release windows for the 7-currency universe **plus a guaranteed
end-of-day run**. If a day has no major data, the end-of-day run still publishes a
refresh. See §6 for editing the schedule. **Live prices** on the Prices/Signals
screens *are* real-time (polled from the price API every ~60s).

## 3. Change the passcode

```bash
node scripts/hash-passcode.js "your new passcode"
```

Paste the printed hash into **`config.js → passcodeSha256`**, commit, redeploy.
The passcode is only ever stored as a SHA-256 hash (a soft gate for two trusted
users, not real auth). Set `rememberUnlock: false` to require it every launch.

## 4. Live prices — pick a provider

Edit **`config.js → price`**. The price layer is swappable (`price-adapter.js`);
the app works fully without it (Prices shows a setup note, Signals omit quotes).

- **Twelve Data (simplest, no server):** browser-friendly, CORS-OK. Get a free key
  at twelvedata.com, set `provider: "twelvedata"` and `twelvedata.apiKey`. The key
  is a low-risk, rate-limited free-tier key; acceptable to expose on a static site.
- **OANDA practice (default in the brief, real-time, needs the proxy):** OANDA's
  token is a secret and OANDA doesn't send CORS headers, so front it with the tiny
  free Cloudflare Worker in **`./proxy`** (holds the token server-side). Then set
  `provider: "oanda"` and `oanda.proxyUrl`. See `proxy/README.md`.
- **FOREX.COM (later):** Darius's broker. When he has GAIN API credentials, add a
  worker speaking the same `/quotes`+`/sparkline` contract and set
  `provider: "forexcom"` + `forexcom.proxyUrl`. **No app code changes.**

Indices (DXY, GER40) and the synthetic JPYBASKET are chart-only and intentionally
excluded from the Prices screen.

## 5. Deploy to GitHub Pages

```bash
# from inside fx-macro-app/
git init
git add .
git commit -m "FX Macro PWA"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
branch → Branch: `main` / `(root)` → Save.** After a minute the app is live at
`https://<you>.github.io/<repo>/`. Open that in Safari and install (§1).

> The whole app is static files — no build step. `.gitignore` already keeps
> secrets (VAPID private key, subscriptions, `config.local.js`) out of the repo.

## 6. Push notifications (optional, free)

iOS 16.4+ supports Web Push for **home-screen** PWAs (not Safari tabs). Pieces:

- **VAPID keys** — already generated. Public key is in `config.js`; the private
  key is in `push/vapid-private.txt` (gitignored). Rotate with
  `node scripts/gen-vapid.js`.
- **Collector** — the Worker in `./proxy` stores device subscriptions (`/subscribe`).
- **Enable in app** — set `push.enabled: true` and `push.subscribeUrl` in
  `config.js`; an "Enable push alerts" button appears on **Today**. The user taps
  it once per device.
- **Sender** — the daily task runs `node push/send-push.js "title" "body"` after
  publishing, which pushes to all devices. `cd push && npm install` first (pulls
  `web-push`); set `SUBS_URL` and `ADMIN_KEY` env vars.

Everything here is free tier. Nothing paid is provisioned.

## 7. Wire the daily task to publish data.json

Add these lines to the **end** of the existing daily Cowork task (after it writes
`Forex_Dashboard/data.js`). *This changes the live scheduled task — review first.*

```bash
# 1) publish the app payload
node fx-macro-app/scripts/build-data-json.js

# 2) commit & push to the app repo (Pages serves it)
cd fx-macro-app && git add data.json && \
  git commit -m "data: $(date +%F)" && git push

# 3) optional: notify devices
node push/send-push.js "New FX report" "$(node -e "console.log(require('./data.json').meta.reportLabel)")"
```

### Schedule (high-impact windows + end-of-day)

Keep the existing daily run as the **guaranteed end-of-day refresh**. To approximate
event-driven updates, add runs timed to the day's high-impact releases for
USD/EUR/GBP/JPY/AUD/NZD/CAD (e.g. US 08:30 ET data, EU 09:00 CET prints, CB
decisions). Each run pulls that day's calendar and republishes. Edit the times in
the task's schedule; they're plain cron — easy to change. (See the task setup
notes added alongside this app.)

## 8. Regenerate icons / data

```bash
python3 scripts/gen_icons.py            # icons + iOS splash (no deps)
node scripts/build-data-json.js         # data.json from the desktop data.js
```

## File map

```
fx-macro-app/
├─ index.html            app shell (gate + tabs + 5 screens)
├─ app.js                logic, rendering, prices, push subscribe
├─ price-adapter.js      swappable price layer (twelvedata | oanda | forexcom)
├─ config.js             passcode hash, price provider/key, VAPID public, push
├─ styles.css            dark theme (matches Forex_Dashboard)
├─ sw.js                 service worker (offline + push handler)
├─ manifest.webmanifest  install metadata
├─ data.json             macro payload (published by the daily task)
├─ icons/                app icons + iOS splash screens
├─ scripts/
│  ├─ build-data-json.js   data.js  ->  data.json (+updatedAt)
│  ├─ gen_icons.py         icon/splash generator (stdlib only)
│  ├─ hash-passcode.js     passcode -> SHA-256
│  ├─ gen-vapid.js         fresh VAPID keypair
│  └─ devserver.js         local static server for testing
├─ proxy/                Cloudflare Worker (OANDA proxy + push collector)
└─ push/                 send-push.js + VAPID private key (gitignored)
```

— Not financial advice — for your own decision-making.
