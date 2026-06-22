# FX Macro proxy (Cloudflare Worker)

A tiny free Worker that does two jobs so the static PWA never holds a secret:

1. **Price proxy for OANDA practice** — keeps your fxTrade token server-side and
   adds the CORS headers OANDA doesn't send, so the browser can fetch quotes.
2. **Push subscription collector** — stores each device's push subscription in
   KV so `push/send-push.js` can notify them.

> You only need this if you pick **OANDA** for prices and/or you want **push
> notifications**. If you pick **Twelve Data** for prices and skip push, you can
> ignore this folder — the app talks to Twelve Data directly.

## Deploy (free tier)

```bash
npm i -g wrangler
wrangler login

# 1) KV namespace for push subscriptions
wrangler kv namespace create FX_SUBS
#   -> copy the printed id into wrangler.toml (id = "...")

# 2) Secrets (never go in the repo)
wrangler secret put OANDA_TOKEN      # fxTrade *practice* API token
wrangler secret put OANDA_ACCOUNT    # practice account id, e.g. 101-004-1234567-001
wrangler secret put ADMIN_KEY        # any long random string

# 3) Ship it
wrangler deploy
```

Wrangler prints a URL like `https://fx-macro-proxy.<you>.workers.dev`.

Then in **`../config.js`**:

```js
price: {
  provider: "oanda",
  oanda: { proxyUrl: "https://fx-macro-proxy.<you>.workers.dev" }
},
push: {
  enabled: true,
  subscribeUrl: "https://fx-macro-proxy.<you>.workers.dev/subscribe"
}
```

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/quotes?symbols=EUR/USD,GBP/USD` | app | normalized `{sym:{mid,bid,ask,changePct,ts}}` |
| GET | `/sparkline?symbol=EUR/USD&points=24` | app | `{closes:[…]}` oldest→newest |
| POST | `/subscribe` | app | store a PushSubscription |
| GET | `/subscriptions?key=ADMIN_KEY` | sender | list all subs |

## Lock down CORS (recommended)

In `worker.js` set `ALLOW_ORIGIN` from `'*'` to your Pages origin, e.g.
`'https://<you>.github.io'`, and redeploy.

## FOREX.COM later

When Darius has GAIN/FOREX.COM API credentials, add a sibling worker (or a route)
that speaks the same `/quotes` + `/sparkline` contract, then point
`config.js → price.provider = "forexcom"` and `price.forexcom.proxyUrl` at it.
Nothing in the app changes.
