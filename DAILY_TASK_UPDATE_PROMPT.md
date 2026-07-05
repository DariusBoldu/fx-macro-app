# Prompt for Cowork — update the daily forex task

Paste the relevant section below to Cowork to update the existing daily report task.

---

## Update 2 (2026-07-05): add XAU/USD, XAG/USD, USOIL — 24 symbols

Please update my daily forex report task: the symbol universe grows from 21 to **24** — the 18 pairs + DXY + JPYBASKET + GER40 are now joined by **XAU/USD (gold), XAG/USD (silver) and USOIL (WTI crude)**. Concretely:

1. In `Forex_Dashboard/data.js` → `symbols[]`, analyse and include all 24 every day. For the three commodities use `sym: "XAU/USD"`, `sym: "XAG/USD"`, `sym: "USOIL"` with the same `{bias, conv, why, risk}` shape. They are USD-quoted commodity CFDs: gold and silver trade the haven/real-rates/Fed axis (plus silver's industrial leg), USOIL is WTI — tie it into the existing oil→FX transmission read (it already drives the CAD/GER40 analysis; now give oil its own bias too).
2. Update `meta.coverage` to: `"USD, EUR, GBP, JPY, AUD, NZD, CAD · 18 pairs + DXY + JPYBASKET + GER40 + XAU + XAG + USOIL"`.
3. In `fx_bias_indicator.pine`, add matching branches for tickers `XAUUSD`, `XAGUSD`, `USOIL` (biases must mirror `symbols[]` exactly, as for all other symbols), and update the Coverage comment. The 2026-07-05 version of the file already contains the three branches plus the forward-bias table handling for them — keep that structure when regenerating.
4. Everything else (macro block, publish steps, push notification) is unchanged. Note: `build-data-json.js` now validates 24 symbols; if a run omits the commodities it carries the previous day's three forward and prints a WARNING — treat that warning as a signal the task prompt needs fixing.

---

Please update my **daily forex report task** so that, in addition to everything it already does (regenerate `Forex_Dashboard/data.js`, the PDF, and `fx_bias_indicator.pine`), it also **publishes to the mobile app** at https://dariusboldu.github.io/fx-macro-app/ . Add the following two steps to the end of the task's instructions:

## Step 1 — Add/refresh the `macro` block inside `Forex_Dashboard/data.js`

Alongside `strength`, include a `macro` object covering **all 7 currencies** (USD, EUR, GBP, JPY, AUD, NZD, CAD). For each currency provide **5 metrics** — `inflation`, `growth`, `unemployment`, `jobs`, `rates` — each shaped **exactly**:

```js
{ value: "<current reading>", trend: "rising" | "falling" | "stable", note: "<short source label>", hist: [<last ~6 readings, oldest -> newest>] }
```

Rules:
- **inflation** = the **headline CPI / HICP year-on-year** rate — NOT core PCE, services CPI or trimmed-mean. (e.g. USD `"4.2%"`, EUR `"3.2%"`.)
- **growth** = the headline GDP figure (say which in `note`: `"GDP q/q ann."` / `"GDP y/y"`).
- **unemployment** = the unemployment rate.
- **jobs** = the latest jobs print (USD `"+150k"` NFP; others: employment change / payrolls / jobs-to-applicants ratio).
- **rates** = the current central-bank **policy rate** (e.g. USD `"3.75%"`, note `"Fed funds"`).
- **trend** = how *that reading itself* moved over recent prints: `rising`, `falling`, or `stable`. This is purely the data's own direction (it drives the tag + chart colour green/red/grey) — do **not** encode an FX/hawkish-dovish interpretation.
- **note** = a short (≤2-word) label for the metric/source.
- **hist** = the last ~6 actual readings as plain numbers, oldest → newest (powers the trail + sparkline). Same unit as `value` (percent without the `%`, jobs in thousands, etc.).
- Keep every value **consistent with that day's `strength` drivers** and the report.

Example for one currency (match this shape for all 7):

```js
USD: {
  inflation:    { value: "4.2%",  trend: "rising", note: "CPI y/y",      hist: [3.8, 3.9, 4.0, 4.1, 4.2, 4.2] },
  growth:       { value: "2.1%",  trend: "stable", note: "GDP q/q ann.", hist: [2.5, 2.3, 2.1, 2.0, 2.1, 2.1] },
  unemployment: { value: "4.1%",  trend: "stable", note: "",             hist: [4.0, 4.1, 4.1, 4.0, 4.1, 4.1] },
  jobs:         { value: "+150k", trend: "rising", note: "NFP",          hist: [110, 135, 120, 145, 150, 150] },
  rates:        { value: "3.75%", trend: "rising", note: "Fed funds",    hist: [3.25, 3.50, 3.50, 3.75, 3.75, 3.75] }
}
```

(Everything else in `data.js` — `meta`, `dailyRead`, `strength`, `symbols`, `catalysts`, `geopolitics` — stays exactly as before. `macro` is just one more field.)

## Step 2 — Publish `data.json` and notify the phones

After `data.js` is written, run these commands:

```bash
cd "/Users/dariusboldu/Documents/Claude/Projects/Trading forex"
node fx-macro-app/scripts/build-data-json.js                 # data.js -> data.json (+ macro, + updatedAt)
cd fx-macro-app
git add data.json && git commit -m "data: $(date +%F)" && git push origin main
node push/send-push.js "New FX report" "$(node -e "console.log(require('./data.json').meta.reportLabel)")"
```

Notes:
- `build-data-json.js` validates the 7 currencies / 21 symbols and copies the `macro` block; if `macro` is ever missing it carries the previous one forward so the app never goes blank.
- The push step safely does nothing if there are no subscribers, and is written to never break the task.
- Never edit `fx-macro-app/data.json` by hand — it is always regenerated from `data.js`.

---

*Reference for the app maintainer: the `macro` block powers the app's **Macro** tab; `build-data-json.js`, `push/send-push.js` and the SSH push credential are already set up on this machine.*
