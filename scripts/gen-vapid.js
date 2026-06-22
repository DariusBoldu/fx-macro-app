#!/usr/bin/env node
/* Generate a fresh VAPID key pair for Web Push (P-256).
 * Usage:  node scripts/gen-vapid.js
 * Put the PUBLIC key in config.js (push.vapidPublicKey) and BOTH keys in
 * push/vapid-private.txt (gitignored). Rotating keys invalidates existing
 * subscriptions — users must re-enable alerts. */
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pub65 = pubDer.slice(pubDer.length - 65);
const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log('VAPID_PUBLIC=' + b64url(pub65));
console.log('VAPID_PRIVATE=' + b64url(d));
