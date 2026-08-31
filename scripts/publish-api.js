#!/usr/bin/env node
/*
 * publish-api.js — DEGRADED-MOUNT FALLBACK publisher (added 2026-08-31).
 * ---------------------------------------------------------------------
 * Publishes data.json to GitHub over plain HTTPS using the Contents API, so it
 * works when the normal git path cannot.
 *
 * WHY THIS EXISTS
 * The workspace lives under ~/Documents (iCloud Drive) with "Optimize Mac
 * Storage" on. When the disk fills, iCloud evicts cold files: metadata stays,
 * content leaves. macOS re-downloads on read; the Cowork Linux sandbox reaching
 * the folder over FUSE CANNOT — read() returns EDEADLK. If `.git/HEAD|config|
 * index` or the SSH deploy key are among the evicted files, git and ssh are both
 * dead and the daily report never reaches the app.
 *
 * This script needs NONE of that. It only needs:
 *   1. Forex_Dashboard/data.js — written by the task moments earlier, and
 *      freshly-written files are ALWAYS readable even on a degraded mount.
 *   2. a GitHub token (see below).
 *   3. outbound HTTPS (already used by the task for research).
 *
 * It deliberately does NOT rebuild history/summary.json: that requires reading
 * the whole history archive, which is exactly what a degraded mount cannot do,
 * and a partial rebuild would destroy the timeline. The next healthy run of
 * build-data-json.js rebuilds it. The day's own snapshot IS published.
 *
 * Committing via the API is a real push to main, so .github/workflows/notify.yml
 * still fires and subscribers still get their notification.
 *
 * TOKEN
 * A fine-grained PAT with Contents: Read and write on DariusBoldu/fx-macro-app.
 * Read from the first of these that is readable (redundant copies hedge against
 * one of them being the evicted file), or the GH_TOKEN env var:
 *   .fx-deploy/gh_token            (outside the repo, never committed)
 *   .fx-deploy/gh_token.bak
 *   fx-macro-app/.gh_token         (gitignored)
 * Create/refresh them with:  node scripts/set-gh-token.js <token>
 *
 * USAGE
 *   node scripts/publish-api.js            # publish
 *   node scripts/publish-api.js --dry-run  # validate + show what would happen
 */
const fs = require('fs');
const path = require('path');
const { buildPayload } = require('./build-data-json.js');

const REPO_SLUG = 'DariusBoldu/fx-macro-app';
const BRANCH = 'main';
const API = 'https://api.github.com';

const ROOT = path.resolve(__dirname, '..', '..');
const TOKEN_PATHS = [
  path.join(ROOT, '.fx-deploy', 'gh_token'),
  path.join(ROOT, '.fx-deploy', 'gh_token.bak'),
  path.resolve(__dirname, '..', '.gh_token'),
];

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  for (const p of TOKEN_PATHS) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) { console.log('  token     : ' + p); return t; }
    } catch (e) { /* evicted or absent — try the next copy */ }
  }
  throw new Error(
    'No GitHub token available. Set GH_TOKEN or create one with:\n' +
    '  node scripts/set-gh-token.js <fine-grained-PAT>');
}

/* HTTP transport.
 * IMPORTANT: prefer curl. Node's native fetch does NOT honour http_proxy/
 * https_proxy, and the Cowork sandbox reaches the internet only through an
 * authenticated CONNECT proxy on :3128 — so a plain fetch() fails there with
 * ENOTFOUND, exactly in the situation this fallback exists for. curl is present
 * on macOS and in the sandbox and picks the proxy up from the environment
 * automatically (it is what the task already uses for its research). fetch stays
 * as the fallback for environments without curl. */
const { execFileSync } = require('child_process');
let HAS_CURL = null;
function haveCurl() {
  if (HAS_CURL === null) {
    try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); HAS_CURL = true; }
    catch (e) { HAS_CURL = false; }
  }
  return HAS_CURL;
}

/* Returns a fetch-like { ok, status, text(), json() } from either transport. */
async function gh(token, method, url, body) {
  const full = url.startsWith('http') ? url : API + url;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fx-macro-publish-api',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };

  if (haveCurl()) {
    const SENTINEL = '\n__FX_HTTP_STATUS__';
    const args = ['-sS', '-X', method, '-w', SENTINEL + '%{http_code}'];
    for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v);
    if (body) args.push('--data-binary', '@-');
    args.push(full);
    const out = execFileSync('curl', args, {
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
      maxBuffer: 64 * 1024 * 1024,
    });
    const i = out.lastIndexOf(SENTINEL);
    const raw = i >= 0 ? out.slice(0, i) : out;
    const status = i >= 0 ? parseInt(out.slice(i + SENTINEL.length), 10) : 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => raw,
      json: async () => JSON.parse(raw),
    };
  }

  return fetch(full, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

/* Fetch a file's current content + blob sha (sha is required to update it). */
async function getRemote(token, filePath) {
  const r = await gh(token, 'GET',
    `/repos/${REPO_SLUG}/contents/${encodeURIComponent(filePath)}?ref=${BRANCH}`);
  if (r.status === 404) return { sha: null, json: null };
  if (!r.ok) throw new Error(`GET ${filePath} -> HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  let parsed = null;
  try { parsed = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch (e) {}
  return { sha: j.sha, json: parsed };
}

async function putRemote(token, filePath, contentStr, sha, message) {
  const r = await gh(token, 'PUT', `/repos/${REPO_SLUG}/contents/${encodeURIComponent(filePath)}`, {
    message,
    content: Buffer.from(contentStr, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  if (!r.ok) throw new Error(`PUT ${filePath} -> HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.commit && j.commit.sha;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('FX publish via GitHub API (degraded-mount fallback)');

  const token = readToken();

  // Previous payload comes from GitHub, NOT the local disk: the remote copy is
  // always readable, so carry-forward keeps working on a degraded mount.
  const remote = await getRemote(token, 'data.json');
  console.log('  remote    : ' + (remote.json ? remote.json.meta.reportDate : '(none)'));

  // Same validation as the normal path — buildPayload is shared, not duplicated.
  const out = buildPayload(remote.json);
  const body = JSON.stringify(out, null, 2) + '\n';
  console.log('  reportDate: ' + out.meta.reportDate);
  console.log('  symbols   : ' + out.symbols.length);
  console.log('  currencies: ' + out.strength.length);

  if (out.meta.reportDate === (remote.json && remote.json.meta.reportDate)) {
    console.log('  note      : same reportDate as remote — republishing (updatedAt refreshes)');
  }

  if (dryRun) { console.log('DRY RUN — nothing published.'); return; }

  const msg = 'data: ' + out.meta.reportDate + ' (via API — degraded mount)';
  const c1 = await putRemote(token, 'data.json', body, remote.sha, msg);
  console.log('  pushed    : data.json -> ' + String(c1).slice(0, 7));

  // Publish the day's history snapshot too (summary.json is intentionally left
  // for the next healthy run — it needs the whole archive).
  const histPath = 'history/' + out.meta.reportDate + '.json';
  try {
    const h = await getRemote(token, histPath);
    const c2 = await putRemote(token, histPath, body, h.sha, msg);
    console.log('  pushed    : ' + histPath + ' -> ' + String(c2).slice(0, 7));
  } catch (e) {
    console.warn('  WARN      : history snapshot not published (' + e.message + ')');
  }

  console.log('PUBLISH OK — notify.yml will fire the push notification.');
  console.log('NOTE: history/summary.json was NOT rebuilt (needs the full archive);');
  console.log('      the next healthy build-data-json.js run restores it.');
}

main().catch((e) => { console.error('PUBLISH FAILED: ' + e.message); process.exit(1); });
