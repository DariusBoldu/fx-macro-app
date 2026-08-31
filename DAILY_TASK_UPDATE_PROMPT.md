# Prompt for Cowork — update the daily forex task

Paste the relevant section below to Cowork to update the existing daily report task.

---

## Update 9 (2026-09-01): publish step gains an HTTPS fallback

Replace the publish section of the task with this three-step logic. Everything else (analysis, TE verification, data.js) is unchanged.

```bash
cd "<workspace>"
bash fx-macro-app/scripts/preflight.sh
```

**If preflight exits 0 (healthy):** publish normally —
```bash
node fx-macro-app/scripts/build-data-json.js
bash fx-macro-app/scripts/push-data.sh
```

**If preflight exits 4 (degraded mount):** do NOT run those two. Use the HTTPS fallback instead —
```bash
node fx-macro-app/scripts/publish-api.js
```
It commits data.json + the day's history snapshot through the GitHub Contents API, needing only the data.js just written (freshly-written files are always readable) and a token. No git, no SSH key, no reading the history archive. Notifications still fire. It deliberately does not rebuild history/summary.json — the next healthy run does that.

**Only if the fallback also fails** (e.g. no token): report that data.js was written and the publish must be finished manually on the Mac, quoting the two commands preflight prints.

Always include preflight's `PREFLIGHT_SUMMARY ...` line in the run report so degradation is visible run to run.

---

## Update 8 (2026-08-13): add copper — 35 symbols

Add **copper** to the commodity block alongside gold, silver and oil. In `symbols[]` use `sym: "XCU/USD"` with the same `{bias, conv, why, risk}` shape, analysed daily like the others. Copper is quoted in **USD per pound** and its price/analysis should come from TradingEconomics (tradingeconomics.com/commodity/copper).

Analyse it as the industrial/growth metal: China demand (the Yangshan premium is a good tell), global mine supply (Codelco et al.), US tariff risk — and explicitly tie it to **AUD**, since copper is the cleanest leading proxy for the industrial cycle behind the Aussie.

Set `meta.coverage` to end: `"... + DXY + JPYBASKET + GER40 + XAU + XAG + XCU + USOIL"`. `build-data-json.js` now validates **35 symbols** (28 pairs + 7 non-pairs) and carries XCU/USD forward with a WARNING if a run omits it.

---

## Update 7 (2026-08-02): complete G10 pair matrix — 28 pairs / 34 symbols

The pair universe is now the **complete G10 matrix excluding SEK and NOK** — every combination of the 8 covered currencies = **28 pairs**, i.e. 34 symbols with DXY + JPYBASKET + GER40 + XAU/USD + XAG/USD + USOIL.

Three pairs are added to `symbols[]` (same `{bias, conv, why, risk}` shape, standard quote conventions): **EUR/GBP, EUR/CAD, GBP/CAD**. Full list of the 28: EUR/USD, EUR/GBP, EUR/JPY, EUR/AUD, EUR/NZD, EUR/CAD, EUR/CHF, GBP/USD, GBP/JPY, GBP/AUD, GBP/NZD, GBP/CAD, GBP/CHF, AUD/USD, AUD/JPY, AUD/NZD, AUD/CAD, AUD/CHF, NZD/USD, NZD/JPY, NZD/CAD, NZD/CHF, USD/JPY, USD/CAD, USD/CHF, CAD/JPY, CAD/CHF, CHF/JPY.

Set `meta.coverage` to: `"USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF · 28 pairs (full G10 ex SEK/NOK) + DXY + JPYBASKET + GER40 + XAU + XAG + USOIL"`. Note the earlier rule that excluded EUR/GBP, EUR/CAD and GBP/CAD is **cancelled** — analyse all 28 every day. `build-data-json.js` now validates 34 symbols and carries any missing pair forward with a WARNING.

---

## Update 6 (2026-07-28): app-only outputs + daily TE verification — CONSOLIDATED, supersedes Update 5

1. **Outputs simplified**: no PDF, no `fx_bias_indicator.pine`. Daily outputs = `Forex_Dashboard/data.js` + the publish steps only.
2. **CHF**: 8 currencies, 25 pairs (adds USD/CHF, EUR/CHF, GBP/CHF, CAD/CHF, NZD/CHF, AUD/CHF, CHF/JPY), 31 symbols. Coverage string: "USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF · 25 pairs + DXY + JPYBASKET + GER40 + XAU + XAG + USOIL". 2026-07-28 data.js = reference format.
3. **TradingEconomics canonical + VERIFIED DAILY**: take macro five metrics (inflation CPI y/y, growth, unemployment, jobs, interest rate) and ratePaths from tradingeconomics.com country pages every run, appending to hist arrays. Conventions: EUR = ECB deposit facility (2.25, NOT the 2.40 MRO headline); USD = Fed funds upper bound; CHF SNB = 0%. If TE differs from yesterday, TE wins — never fill from memory.
4. **Contract**: keep snapshot (5-7 {icon,t,s} rows), today[] (8 ccys, movers first), ratePaths (8 ccys {next,when,note}), catalysts `when` ISO + impact:"high" = true red-folder only. symbols[] is now the SOLE source of biases (no Pine mirror).
5. **Publish** (unchanged): build-data-json.js -> git add data.json history/ -> commit/push -> send-push.js. A build WARNING about carried-forward entries = a missed block; fix in the same run.

---

## Update 5 (2026-07-28): CHF, TradingEconomics sourcing, snapshot, rate paths

Four changes to the daily task:

1. **CHF joins the universe — 8 currencies, 25 pairs, 31 symbols.** Analyse CHF (SNB) exactly like the other currencies, every day: it gets entries in `strength[]`, `today[]`, `macro.CHF`, and `ratePaths.CHF`. The pairs list gains **USD/CHF, EUR/CHF, GBP/CHF, CAD/CHF, NZD/CHF, AUD/CHF, CHF/JPY** in `symbols[]` (with the same {bias, conv, why, risk} shape) and matching branches in `fx_bias_indicator.pine` (tickers USDCHF, EURCHF, GBPCHF, CADCHF, NZDCHF, AUDCHF, CHFJPY). Set `meta.coverage` to `"USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF · 25 pairs + DXY + JPYBASKET + GER40 + XAU + XAG + USOIL"`. The 2026-07-28 files contain the reference format.

2. **TradingEconomics is the canonical data source for `macro` and rates.** Each day, consult tradingeconomics.com (the country pages, e.g. tradingeconomics.com/switzerland/indicators and .../interest-rate) and take the `macro` block's five metrics — inflation (headline CPI y/y), growth (GDP), unemployment, jobs, interest rate — **from TradingEconomics' published values** for all 8 countries (euro-area for EUR). Same for rate expectations. Do not substitute other sources for these numbers.

3. **New `snapshot` block** — a structured world resume for the top of the app's Today page, replacing the prose regime as the primary display. ~5–7 rows: `snapshot: [{ icon: "<emoji>", t: "<topic ≤12 chars, e.g. Regime/Oil & war/Dollar/Yen/Gold>", s: "<1-2 sentences>" }]`. Cover: the regime, oil/war, the dollar, the yen, gold, and whatever moved most. Keep `meta.regime` too (fallback + desktop).

4. **New `ratePaths` block** — per currency, the expected next central-bank move (sourced from TE + your CB analysis): `ratePaths: { USD: { next: "hike"|"hold"|"cut", when: "<meeting/timing>", note: "<one line why>" }, ... }` for all 8. This powers the app's Rates tab (differential + expected widening/tightening per pair) — keep it consistent with each day's forward analysis.

---

## Update 4 (2026-07-06): per-currency Today block

In `Forex_Dashboard/data.js`, alongside `dailyRead`, include a `today` array — the per-currency daily read that powers the app's restructured Today page. **All 7 currencies, every day**, shaped:

```js
today: [
  { ccy: "NZD", moved: true, headline: "<one line: what changed today>", read: "<1-2 sentences: the lean / so-what>" },
  ...
]
```

Rules:
- **Order = display order, BIGGEST MOVERS FIRST** — the currencies whose picture actually changed lead the array; quiet ones go last.
- `moved: true` if that currency's story changed today; `false` for quiet days (then headline like "No change — <thesis> holds").
- `headline` ≤ ~90 chars, the day's delta; `read` 1–2 sentences, forward-looking (the lean, the catalyst, the risk) — not a recap.
- Keep `dailyRead` (the full narrative) exactly as before — the app shows it under a collapsible "Full daily read".
- The 2026-07-06 data.js contains the reference format — keep it.

---

## Update 3 (2026-07-06): timestamped catalysts + history archive

Two small changes to the daily task:

1. **Catalysts carry a `when` timestamp.** In `Forex_Dashboard/data.js` → `catalysts[]`, every event with a known scheduled release time must include `when: "<ISO 8601 UTC, e.g. 2026-07-14T12:30:00Z>"` — the exact release moment (use standard times: US data 12:30Z/14:00Z, RBNZ 02:00Z, ECB 12:15Z, BoE 11:00Z, FOMC statement 18:00Z, etc.). Give each separately-timed event its **own entry** (don't combine "RBNZ + Fed minutes" in one). Rolling/undated items (intervention watch, geopolitics) get no `when`. This drives the app's automatic push alerts 60 and 15 minutes before every HIGH-impact event — so keep `impact: "high"` accurate: true market movers only. (The 2026-07-06 data.js already follows this format — keep it.)
2. **Publish the history archive too.** The publish step's git add now includes the history folder:
   `git add data.json history/ && git commit -m "data: $(date +%F)" && git push origin main`
   (`build-data-json.js` writes `history/<date>.json` + `history/summary.json` automatically — no extra work, just add them to the commit.)

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
