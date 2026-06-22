#!/usr/bin/env node
/* Print the SHA-256 of a passcode for config.js -> passcodeSha256.
 * Usage:  node scripts/hash-passcode.js "my new passcode"            */
const crypto = require('crypto');
const pass = process.argv.slice(2).join(' ');
if (!pass) {
  console.error('Usage: node scripts/hash-passcode.js "your passcode"');
  process.exit(1);
}
const hash = crypto.createHash('sha256').update(pass).digest('hex');
console.log(hash);
console.error('\nPaste this into config.js -> passcodeSha256, then redeploy.');
