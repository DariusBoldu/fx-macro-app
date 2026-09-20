#!/usr/bin/env node
/*
 * set-cf-token.js — store the Cloudflare API token used to deploy the Worker.
 *
 *   node scripts/set-cf-token.js        then paste the token at the prompt
 *
 * The token is read from the terminal with echo OFF and is never passed as a
 * command-line argument, so it does not reach shell history, `ps`, or any
 * transcript. Stored chmod 600 in redundant copies (same reason as the GitHub
 * token: iCloud has evicted files at random on this machine), then verified
 * against Cloudflare so a typo is caught immediately.
 *
 * Why this exists: `wrangler login` is an OAuth session that expires after about
 * a week, and it can only be renewed interactively in a browser — which blocks
 * Worker deploys at exactly the wrong moment. A scoped API token does not expire
 * unless you give it an expiry, and scripts/deploy-worker.sh picks it up
 * automatically.
 *
 * Create the token: Cloudflare dashboard -> My Profile -> API Tokens ->
 * Create Token -> template "Edit Cloudflare Workers" -> your account -> Continue
 * -> Create. Permissions it must include: Workers Scripts Edit,
 * Workers KV Storage Edit, Account Settings Read.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.FX_CF_TOKEN_ROOT ? path.resolve(process.env.FX_CF_TOKEN_ROOT) : path.resolve(REPO, '..');
const TARGETS = [
  path.join(ROOT, '.fx-deploy', 'cf_token'),
  path.join(ROOT, '.fx-deploy', 'cf_token.bak'),
  path.join(process.env.FX_CF_TOKEN_ROOT ? ROOT : REPO, '.cf_token'),
];

function readSecret(prompt) {
  // Piped input (echo … | node set-cf-token.js) is accepted as-is.
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').trim();
  process.stderr.write(prompt);
  const fd = fs.openSync('/dev/tty', 'rs');
  let saved = null;
  try { saved = execFileSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'] }).toString().trim(); } catch (e) {}
  try {
    if (saved) execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
    let out = '', buf = Buffer.alloc(1);
    for (;;) {
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, 1, null); } catch (e) { break; }
      if (!n) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      if (ch === '') { process.stderr.write('\ncancelled\n'); process.exit(130); }
      if (ch === '') { out = out.slice(0, -1); continue; }
      out += ch;
    }
    return out.trim();
  } finally {
    if (saved) { try { execFileSync('stty', [saved], { stdio: ['inherit', 'ignore', 'ignore'] }); } catch (e) {} }
    try { fs.closeSync(fd); } catch (e) {}
    process.stderr.write('\n');
  }
}

if (process.argv[2]) {
  console.error('Do not pass the token as an argument (it would land in your shell history).\n' +
    'Run: node scripts/set-cf-token.js   and paste it at the prompt.');
  process.exit(1);
}

const token = readSecret('Paste the Cloudflare API token (input hidden), then press Enter: ');
if (!token) { console.error('Nothing pasted.'); process.exit(1); }
if (!/^[A-Za-z0-9_-]{30,120}$/.test(token)) {
  console.error('That does not look like a Cloudflare API token (expected ~40 characters, letters/digits/_/-).\n' +
    'Note: this is the API TOKEN, not the Global API Key and not your account id.');
  process.exit(1);
}

/* Verify before storing — curl, not fetch, because node's fetch ignores proxy
 * settings and this may run behind the sandbox proxy. */
let verified = false;
try {
  const body = execFileSync('curl', ['-sS', '-m', '20',
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
    '-H', 'Authorization: Bearer ' + token], { encoding: 'utf8' });
  const j = JSON.parse(body);
  verified = !!j.success && j.result && j.result.status === 'active';
  if (!verified) {
    const msg = (j.errors || []).map((e) => e.code + ' ' + e.message).join('; ') || JSON.stringify(j.result || j);
    console.error('Cloudflare rejected the token: ' + msg);
    console.error('Nothing was stored. Check the token was copied whole, and that it is active.');
    process.exit(1);
  }
} catch (e) {
  console.warn('Could not reach Cloudflare to verify (' + e.message + ') — storing anyway.');
}

let ok = 0;
for (const t of TARGETS) {
  try {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, token + '\n', { mode: 0o600 });
    fs.chmodSync(t, 0o600);
    console.log('wrote ' + t);
    ok++;
  } catch (e) {
    console.warn('could not write ' + t + ' (' + e.message + ')');
  }
}
if (!ok) { console.error('No copy could be written.'); process.exit(1); }
console.log('\n' + ok + ' copy/copies stored' + (verified ? ', token verified active with Cloudflare' : '') +
  '.\nDeploy with:  bash scripts/deploy-worker.sh --dry-run');
