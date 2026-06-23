/* ============================================================================
 * FX Macro — runtime config.  Edit this file to change the passcode, the price
 * provider/key, and push settings.  It is loaded at runtime (not bundled), so
 * you can change it without rebuilding anything.
 *
 * SECURITY NOTE for a static site (GitHub Pages):
 *   Anything in this file is visible to anyone who can load the page.
 *   - The passcode is stored only as a SHA-256 hash (fine to expose; it is a
 *     soft gate for two trusted users, not real auth).
 *   - The VAPID *public* key is meant to be public.
 *   - A price API key is NOT safe to expose unless the provider's key is a
 *     low-risk, rate-limited, free-tier key (e.g. Twelve Data) OR you front it
 *     with the tiny proxy in ./proxy (recommended for OANDA). See README.
 * ==========================================================================*/
window.FX_CONFIG = {

  /* ---- Access gate -------------------------------------------------------
   * SHA-256 of the shared passcode.  Default passcode is "swing2026".
   * CHANGE IT:  node scripts/hash-passcode.js "your new passcode"
   * then paste the printed hash below. */
  passcodeSha256: "112016204d4b23181fbbf5afcddb9d8b3b97f1f82c29b91932f3c0900cec6791",
  rememberUnlock: true,           // stay unlocked between launches on this device

  /* ---- Live price feed ---------------------------------------------------
   * provider: "twelvedata" | "oanda" | "forexcom" | "none"
   * The adapter is swappable (see price-adapter.js). If unconfigured, the app
   * still works fully — the Prices screen just shows a setup notice and Signals
   * cards omit the live quote. */
    // Chosen: Twelve Data (direct, CORS — no proxy needed). Free "Basic" tier =
    // 8 credits/min, 800/day, so the adapter fetches 8 pairs per cycle and
    // rotates through all 18 (see price-adapter.js). OANDA is parked below and
    // can be swapped back in later via the proxy.
  price: {
    provider: "twelvedata",       // direct browser fetch, free tier

    // Twelve Data — browser-friendly (CORS-enabled). Free-tier key is a query
    // param; low-risk to expose, but rate-limited (8 credits/min, 800/day).
    twelvedata: {
      apiKey: "ca7cf3cd64cb4c10beb23b4fca64d47b",   // https://twelvedata.com/
    },

    // OANDA fxTrade *practice* — real-time FX, free account. The token is a
    // bearer secret and OANDA does not send browser CORS headers, so point the
    // app at the tiny proxy in ./proxy (which holds the token server-side).
    oanda: {
      proxyUrl: "",               // e.g. https://your-worker.workers.dev
      // direct mode (NOT recommended on a public site — exposes the token and
      // usually CORS-fails in the browser). Left here for completeness:
      token: "",
      accountId: "",
      practice: true,
    },

    // FOREX.COM / GAIN — Darius's broker. Placeholder for when/if he gets API
    // credentials; wire through the same proxy pattern. Not active yet.
    forexcom: {
      proxyUrl: "",
    },

    refreshMs: 90000,             // poll cadence (Twelve Data free tier friendly)
  },

  /* ---- Web Push ----------------------------------------------------------
   * VAPID *public* key (safe to expose). The matching private key lives in
   * push/vapid-private.txt (gitignored) and is used only by push/send-push.js.
   * subscribeUrl: the endpoint that stores a device's push subscription.
   * Leave empty to disable the "Enable alerts" button until you stand up the
   * collector (see README + ./proxy). */
  push: {
    enabled: true,                // live
    vapidPublicKey: "BNIuELx5htoIPreBatlat8-46ADSDFwQmhmiAt_CiJ6JzWTml9pbSEDiRHCpWcG6kqiHgXXotU1JM8wROgWbsdA",
    subscribeUrl: "https://fx-macro-proxy.dariusboldu2014.workers.dev/subscribe",
  },

  /* ---- Data source -------------------------------------------------------
   * Where the app fetches the macro payload published by the daily task.
   * Relative path works on GitHub Pages; the cache-buster keeps it fresh. */
  dataUrl: "data.json",
  dataPollMs: 5 * 60 * 1000,      // re-check for a fresh report every 5 min
};
