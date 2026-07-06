/* ============================================================================
 * webpush.js — minimal Web Push sender for Cloudflare Workers (and Node 18+).
 * Implements VAPID (RFC 8292, ES256 JWT) + aes128gcm payload encryption
 * (RFC 8291/8188) with pure WebCrypto — no dependencies, so the Worker's cron
 * can notify devices without the laptop being on.
 *
 * Usage:
 *   import { sendWebPush } from './webpush.js';
 *   const status = await sendWebPush(subscription, JSON.stringify(payload), {
 *     vapidPublicKey, vapidPrivateKey, subject: 'mailto:you@example.com' });
 *   // -> HTTP status from the push service (201 = accepted for delivery)
 * ==========================================================================*/

const te = new TextEncoder();

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/* HKDF-SHA256 (extract+expand) via WebCrypto */
async function hkdf(ikm, salt, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

/* VAPID ES256 JWT for the push service origin */
async function vapidAuthHeader(endpoint, pubB64u, privB64u, subject) {
  const pub = b64uToBytes(pubB64u);              // 65-byte uncompressed point
  const x = bytesToB64u(pub.slice(1, 33));
  const y = bytesToB64u(pub.slice(33, 65));
  const key = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', x, y, d: privB64u },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(te.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const signing = header + '.' + claims;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signing));
  return 'vapid t=' + signing + '.' + bytesToB64u(sig) + ', k=' + pubB64u;
}

/* RFC 8291 aes128gcm encryption of the payload for one subscription */
async function encryptPayload(sub, plaintext) {
  const uaPub = b64uToBytes(sub.keys.p256dh);    // user agent public key (65B)
  const authSecret = b64uToBytes(sub.keys.auth); // 16B auth secret

  const asKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPub,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"||0x00||ua_pub||as_pub, 32)
  const ikm = await hkdf(ecdh, authSecret,
    concat(te.encode('WebPush: info\0'), uaPub, asPubRaw), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);

  // single record: plaintext || 0x02 (final-record delimiter)
  const record = concat(te.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, record));

  // aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(as_pub 65)
  const rs = new Uint8Array([0, 0, 16, 0]);      // 4096
  return concat(salt, rs, new Uint8Array([asPubRaw.length]), asPubRaw, ct);
}

/* Send one push. Returns the push service's HTTP status (201 = accepted;
 * 404/410 = subscription expired and should be dropped). */
export async function sendWebPush(sub, payload, cfg) {
  const body = await encryptPayload(sub, payload);
  const auth = await vapidAuthHeader(sub.endpoint, cfg.vapidPublicKey, cfg.vapidPrivateKey,
    cfg.subject || 'mailto:admin@example.com');
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(cfg.ttl != null ? cfg.ttl : 3600),
      'Urgency': cfg.urgency || 'high',
    },
    body,
  });
  return res.status;
}
