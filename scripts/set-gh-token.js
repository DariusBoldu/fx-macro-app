#!/usr/bin/env node
/*
 * set-gh-token.js — store the GitHub token used by the API fallback publisher.
 *
 *   node scripts/set-gh-token.js ghp_xxx_or_github_pat_xxx
 *
 * Writes REDUNDANT copies (chmod 600). Why redundant: on a degraded mount iCloud
 * has evicted roughly a third of files at random, so a single token file is a
 * single point of failure; publish-api.js reads whichever copy is still
 * materialised. All locations are outside git or gitignored.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = [
  path.join(ROOT, '.fx-deploy', 'gh_token'),
  path.join(ROOT, '.fx-deploy', 'gh_token.bak'),
  path.resolve(__dirname, '..', '.gh_token'),
];

const token = (process.argv[2] || '').trim();
if (!token) {
  console.error('Usage: node scripts/set-gh-token.js <github-token>\n\n' +
    'Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new\n' +
    '  Repository access : only DariusBoldu/fx-macro-app\n' +
    '  Permissions       : Contents = Read and write\n');
  process.exit(1);
}
if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
  console.error('That does not look like a GitHub token (expected ghp_… or github_pat_…).');
  process.exit(1);
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
console.log('\n' + ok + ' copy/copies stored. Verify with:\n  node scripts/publish-api.js --dry-run');
