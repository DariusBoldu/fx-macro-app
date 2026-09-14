#!/usr/bin/env node
/*
 * release-due.mjs — helper for the local POST-RELEASE follow-up task.
 * ---------------------------------------------------------------------
 * The follow-up runs on the Mac (Claude Code scheduled task "fx-release-followup")
 * shortly after each HIGH-impact release, re-analyses the affected currency and
 * republishes. This script does the deterministic parts so the analysis prompt
 * doesn't have to: which releases are due, their actual figures, which app
 * symbols they touch, and when the task should fire next.
 *
 * Matching uses proxy/release-match.js — the SAME module the Cloudflare Worker
 * uses for the result push notifications — so both always agree.
 *
 * USAGE (run from anywhere)
 *   node scripts/release-due.mjs status         JSON: due releases (+actuals, affected symbols) and `next`
 *   node scripts/release-due.mjs mark <id>...   record releases as handled (quote ids: they contain "|")
 *   node scripts/release-due.mjs next           JSON: { fireAt } to re-arm the task
 *   node scripts/release-due.mjs fingerprint    sha256 of Forex_Dashboard/data.js (race guard)
 *
 * State lives in fx-macro-app/.release-state.json (gitignored, local only).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  fetchCalendar, matchRelease, releaseId, inferCurrency, affectedCurrencies, isAffectedSymbol,
} from '../proxy/release-match.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROOT = path.resolve(REPO, '..');
const DATA_JSON = path.join(REPO, 'data.json');
const DATA_JS = path.join(ROOT, 'Forex_Dashboard', 'data.js');
const STATE = path.join(REPO, '.release-state.json');

const SETTLE_MIN = 2;      // a release isn't "due" until figures can plausibly exist
const STALE_H = 6;         // older than this: leave it to the next daily report
const FOLLOW_MIN = 5;      // the task fires this long after a release
const FALLBACK = { h: 10, m: 45 };   // nothing scheduled: re-check after tomorrow's daily report (local time)

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const fail = (msg) => { process.stderr.write('ERROR: ' + msg + '\n'); process.exit(1); };
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }

function loadState() {
  const s = readJson(STATE, {});
  s.processed = s.processed || {};
  return s;
}
function saveState(s) {
  const cutoff = Date.now() - 14 * 86400000;   // keep two weeks of history
  for (const [k, v] of Object.entries(s.processed)) {
    if (Date.parse((v && v.at) || 0) < cutoff) delete s.processed[k];
  }
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}

/* ISO timestamp carrying the Mac's own UTC offset — the scheduler's fireAt
 * requires an explicit offset, and a bare "Z" time would be easy to misread. */
function localIso(ms) {
  const off = -new Date(ms).getTimezoneOffset();          // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return new Date(ms + off * 60000).toISOString().slice(0, 19) + `${sign}${hh}:${mm}`;
}

const highCatalysts = (data) => (data.catalysts || [])
  .filter((c) => c.impact === 'high' && c.when && !isNaN(Date.parse(c.when)));

function nextFire(data, now) {
  const upcoming = highCatalysts(data).map((c) => Date.parse(c.when)).filter((t) => t > now).sort((a, b) => a - b);
  if (upcoming.length) {
    const at = upcoming[0];
    return {
      fireAt: localIso(at + FOLLOW_MIN * 60000),
      releaseAt: new Date(at).toISOString(),
      events: highCatalysts(data).filter((c) => Date.parse(c.when) === at).map((c) => c.event),
    };
  }
  const d = new Date(now);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, FALLBACK.h, FALLBACK.m).getTime();
  return { fireAt: localIso(t), releaseAt: null, events: [], note: 'no upcoming release in data.json — re-check after the next daily report' };
}

async function status() {
  const data = readJson(DATA_JSON, null);
  if (!data) fail('fx-macro-app/data.json is unreadable');
  const state = loadState();
  const now = Date.now();
  const due = [];
  const staleSkipped = [];

  for (const c of highCatalysts(data)) {
    const t = Date.parse(c.when);
    const id = releaseId(c);
    if (state.processed[id]) continue;
    if (t > now - SETTLE_MIN * 60000) continue;                     // not released yet
    if (now - t > STALE_H * 3600000) { staleSkipped.push(id); continue; }

    const ccy = inferCurrency(c.event) || inferCurrency(c.note);
    let actuals = null; let error = null;
    try { actuals = matchRelease(c, await fetchCalendar(ccy, t)); }
    catch (e) { error = String((e && e.message) || e); }

    due.push({
      id, when: c.when, minutesAgo: Math.round((now - t) / 60000),
      event: c.event, note: c.note || '',
      ccy, currencies: affectedCurrencies(ccy),
      symbols: (data.symbols || []).map((s) => s.sym).filter((s) => isAffectedSymbol(s, ccy)),
      actuals, error,
    });
  }

  if (staleSkipped.length) {
    for (const id of staleSkipped) state.processed[id] = { at: new Date().toISOString(), outcome: 'stale: older than ' + STALE_H + 'h' };
    saveState(state);
  }

  out({
    now: new Date(now).toISOString(),
    reportDate: data.meta && data.meta.reportDate,
    dataUpdatedAt: data.updatedAt,
    due, staleSkipped,
    next: nextFire(data, now),
  });
}

function mark(ids) {
  if (!ids.length) fail('mark needs at least one release id');
  const state = loadState();
  for (const id of ids) state.processed[id] = { at: new Date().toISOString(), outcome: 'reanalysed' };
  saveState(state);
  out({ marked: ids });
}

function fingerprint() {
  try {
    out({ sha256: crypto.createHash('sha256').update(fs.readFileSync(DATA_JS)).digest('hex') });
  } catch (e) { fail('cannot read Forex_Dashboard/data.js'); }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'status') await status();
else if (cmd === 'mark') mark(args);
else if (cmd === 'next') { const d = readJson(DATA_JSON, null); if (!d) fail('data.json unreadable'); out(nextFire(d, Date.now())); }
else if (cmd === 'fingerprint') fingerprint();
else fail('usage: release-due.mjs status | mark <id>... | next | fingerprint');
