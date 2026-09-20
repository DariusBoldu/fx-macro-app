#!/usr/bin/env node
/*
 * release-due.mjs — helper for the local POST-RELEASE follow-up task.
 * ---------------------------------------------------------------------
 * The follow-up runs on the Mac (Claude Code scheduled task "fx-release-followup")
 * shortly after each ForexFactory RED-FOLDER release for the app's 8 currencies,
 * re-analyses the affected currency and republishes. This script does the
 * deterministic parts: which red-folder releases are due, their actual figures,
 * which app symbols they touch, and when the task should fire next.
 *
 * Matching uses proxy/release-match.js — the SAME module the Cloudflare Worker
 * uses for the pushes — so the notification and the re-analysis always agree.
 *
 * USAGE (run from anywhere)
 *   node scripts/release-due.mjs status         JSON: due red-folder groups (+figures, affected symbols), `next`, `retryFireAt`
 *   node scripts/release-due.mjs mark <id>...   record groups as handled (quote ids: they contain "|")
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
  fetchRedFolder, fetchCalendar, matchGroup, isNumeric, inferCurrency,
  affectedCurrencies, isAffectedSymbol, FLAG,
  commentaryGroups, relatedDecision, commentaryScope,
} from '../proxy/release-match.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROOT = path.resolve(REPO, '..');
// Overridable for the cloud routine, which works on shadow/ files and keeps its
// state IN the repo (a cloud run has no Mac to keep .release-state.json on).
const envPath = (v, dflt) => (process.env[v] ? path.resolve(process.env[v]) : dflt);
const DATA_JSON = envPath('FX_DATA_JSON', path.join(REPO, 'data.json'));
const DATA_JS = envPath('FX_DATA_JS', path.join(ROOT, 'Forex_Dashboard', 'data.js'));
const STATE = envPath('FX_RELEASE_STATE', path.join(REPO, '.release-state.json'));

const SETTLE_MIN = 2;          // a release isn't "due" until figures can plausibly exist
const STALE_H = 6;             // older than this: leave it to the next daily report
const FOLLOW_MIN = 5;          // the task fires this long after a release
const RETRY_MIN = 15;          // figures not out yet: try again this much later
const RESULT_WINDOW_MIN = 45;  // same windows as the Worker
const DECISION_WINDOW_MIN = 180;
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
 * requires an explicit offset. */
function localIso(ms) {
  const off = -new Date(ms).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return new Date(ms + off * 60000).toISOString().slice(0, 19) + `${sign}${hh}:${mm}`;
}

const sameTime = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) < 60000;

/* Handled already? Ids are "<when>|<CCY>". Ids written before the red-folder
 * switch (2026-09-14) were "<when>|<event-slug>" — still honoured, so a release
 * handled under the old scheme is never re-analysed twice. */
function isProcessed(state, g) {
  if (state.processed[g.id]) return true;
  return Object.keys(state.processed).some((k) => {
    const i = k.indexOf('|');
    if (i < 0 || !sameTime(k.slice(0, i), g.when)) return false;
    const rest = k.slice(i + 1);
    return rest === g.ccy || inferCurrency(rest.replace(/-/g, ' ')) === g.ccy;
  });
}

/* The daily report's own catalyst row for this release, if it has one. */
function catalystFor(data, g) {
  const c = (data.catalysts || []).find((x) => x.when && sameTime(x.when, g.when) && inferCurrency(x.event) === g.ccy);
  return c ? c.event : null;
}

function nextFire(groups, now) {
  const up = groups.filter((g) => g.numeric && Date.parse(g.when) > now);
  if (up.length) {
    const g = up[0];
    return {
      fireAt: localIso(Date.parse(g.when) + FOLLOW_MIN * 60000),
      releaseAt: g.when,
      groups: up.filter((x) => x.when === g.when).map((x) => `${x.ccy}: ${x.lines.map((l) => l.title).join(', ')}`),
    };
  }
  const d = new Date(now);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, FALLBACK.h, FALLBACK.m).getTime();
  return { fireAt: localIso(t), releaseAt: null, groups: [], note: 'no upcoming red-folder release in this week\'s ForexFactory feed — re-check tomorrow' };
}

async function loadGroups() {
  try { return await fetchRedFolder(); }
  catch (e) { fail('ForexFactory feed unavailable: ' + ((e && e.message) || e)); }
}

async function status() {
  const data = readJson(DATA_JSON, null);
  if (!data) fail('fx-macro-app/data.json is unreadable');
  const groups = await loadGroups();
  const state = loadState();
  const now = Date.now();
  const due = [];
  const staleSkipped = [];

  for (const g of groups) {
    if (!g.numeric) continue;                                   // speeches/statements carry no figures
    const t = Date.parse(g.when);
    if (t > now) continue;                                      // not released yet
    if (isProcessed(state, g)) continue;
    if (now - t > STALE_H * 3600000) { staleSkipped.push(g.id); continue; }

    let match = null; let error = null;
    try { match = matchGroup(g, await fetchCalendar(g.ccy, t, { spanMin: g.decision ? 150 : 10 })); }
    catch (e) { error = String((e && e.message) || e); }
    // Inside the settle window a group is due only once its figures are out. The
    // Worker fires the cloud routine as soon as they are (often within 60 s), and
    // an empty `due` there would read as "already handled" (2026-09-15, UK claimants).
    if (t > now - SETTLE_MIN * 60000 && !(match && match.anyActual)) continue;

    const windowMin = g.decision ? DECISION_WINDOW_MIN : RESULT_WINDOW_MIN;
    due.push({
      id: g.id, when: g.when, minutesAgo: Math.round((now - t) / 60000),
      ccy: g.ccy, flag: FLAG[g.ccy],
      redFolder: g.lines.map((l) => l.title),              // every red-folder line, incl. statements
      lines: match ? match.lines : g.lines.filter(isNumeric).map((l) => ({ title: l.title, actual: null, forecast: l.forecast, previous: l.previous, cmp: '' })),
      figuresOut: !!(match && match.anyActual),
      complete: !!(match && match.complete),
      notOnCalendarSource: match ? match.unmatched : [],
      windowEndsAt: new Date(t + windowMin * 60000).toISOString(),
      windowPassed: now > t + windowMin * 60000,
      catalyst: catalystFor(data, g),                      // report catalyst to annotate, or null
      currencies: affectedCurrencies(g.ccy),
      symbols: (data.symbols || []).map((s) => s.sym).filter((s) => isAffectedSymbol(s, g.ccy)),
      error,
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
    next: nextFire(groups, now),
    retryFireAt: localIso(now + RETRY_MIN * 60000),
  });
}

/* What a CENTRAL-BANK COMMENTARY pass has to work with: the event, the figures
 * that were already published for it, the report's own catalyst row, and the
 * scope (Fed/ECB/BoJ re-score the whole board; everyone else stays local). */
async function commentary(ids) {
  if (!ids.length) fail('commentary needs a release id');
  const id = ids[0];
  const data = readJson(DATA_JSON, null);
  if (!data) fail(DATA_JSON + ' is unreadable');
  const groups = await loadGroups();
  const all = commentaryGroups(groups);
  let c = all.find((x) => x.id === id);
  if (!c) {
    // ForexFactory restates central-bank times after the fact (BoJ 02:30 -> 02:54),
    // so fall back to the same currency within the decision window.
    const cut = String(id).indexOf('|');
    const t = Date.parse(String(id).slice(0, cut));
    const ccy = String(id).slice(cut + 1);
    c = all.find((x) => x.ccy === ccy && Math.abs(Date.parse(x.when) - t) <= DECISION_WINDOW_MIN * 60000) || null;
  }
  if (!c) {
    out({ id, found: false, note: 'no commentary event with this id in this week\'s ForexFactory feed — nothing to do' });
    return;
  }

  const state = loadState();
  const dec = c.kind === 'presser' ? relatedDecision(c, groups) : (c.decision ? c : null);
  let figures = [];
  let figuresError = null;
  if (dec) {
    try {
      const m = matchGroup(dec, await fetchCalendar(dec.ccy, Date.parse(dec.when), { spanMin: 150 }));
      figures = m.lines;
    } catch (e) { figuresError = String((e && e.message) || e); }
  }
  const scope = commentaryScope(c.ccy);
  const syms = (data.symbols || []).map((s) => s.sym);

  out({
    now: new Date().toISOString(),
    id: c.id, found: true, kind: c.kind, ccy: c.ccy, flag: FLAG[c.ccy],
    when: c.when, dueAt: c.dueAt,
    minutesSinceStart: Math.round((Date.now() - Date.parse(c.when)) / 60000),
    redFolder: c.lines.map((l) => l.title),
    alreadyHandled: !!state.processed[c.id],
    scope,                                        // 'full' = all 8 ccys / 35 symbols
    decision: dec ? { id: dec.id, when: dec.when, lines: figures, error: figuresError } : null,
    catalyst: catalystFor(data, c),
    currencies: scope === 'full' ? ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'] : affectedCurrencies(c.ccy),
    symbols: scope === 'full' ? syms : syms.filter((s) => isAffectedSymbol(s, c.ccy)),
    reportDate: data.meta && data.meta.reportDate,
    dataUpdatedAt: data.updatedAt,
  });
}

function mark(ids) {
  if (!ids.length) fail('mark needs at least one release id');
  const state = loadState();
  for (const id of ids) state.processed[id] = { at: new Date().toISOString(), outcome: 'handled' };
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
else if (cmd === 'commentary') await commentary(args);
else if (cmd === 'mark') mark(args);
else if (cmd === 'next') out(nextFire(await loadGroups(), Date.now()));
else if (cmd === 'fingerprint') fingerprint();
else fail('usage: release-due.mjs status | commentary <id> | mark <id>... | next | fingerprint');
