#!/usr/bin/env bash
# preflight.sh — run BEFORE build-data-json.js + push-data.sh (added 2026-08-28,
# revised 2026-08-31 once the root cause was identified).
#
# ROOT CAUSE (confirmed on the Mac 2026-08-31): the workspace lives under
# ~/Documents, which is an iCloud Drive-synced location, and macOS "Optimize Mac
# Storage" is ON. When the disk fills, iCloud EVICTS cold files: the metadata
# stays (stat/readdir work) but the content is gone from local disk — the file
# carries the macOS `dataless` flag and must be re-downloaded on first read.
# macOS materialises it transparently; the Cowork Linux sandbox, reaching the
# folder over FUSE, CANNOT — its read() returns EDEADLK ("Resource deadlock
# avoided", errno -35). Hence: ~30% of files unreadable, scattered arbitrarily,
# metadata healthy, freshly written files always fine.
#
# Permanent fix is host-side: System Settings > Apple ID > iCloud > iCloud Drive
# > turn OFF "Optimize Mac Storage" (and/or free disk space). Nothing this
# script does can materialise an evicted file from inside the sandbox.
#
# Exit codes:
#   0  mount healthy  -> run build-data-json.js then push-data.sh as normal
#   4  mount degraded -> data.js is still valid; report the manual commands
#                        instead of publishing. Do NOT try to work around it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$REPO/.." && pwd)"

fail=0; ok_n=0; bad_n=0
note() { printf '  %-46s %s\n' "$1" "$2"; }

check() { # check <label> <path>
  if [ ! -e "$2" ]; then note "$1" "MISSING"; fail=1; bad_n=$((bad_n+1)); return; fi
  # One retry only: the eviction failure is deterministic per file (measured
  # 20/20 identical failures 250 ms apart), so the old 3x+sleep loop just burnt
  # ~6 s per bad file. The single retry stays as cheap insurance.
  if head -c 16 "$2" >/dev/null 2>&1 || { sleep 1; head -c 16 "$2" >/dev/null 2>&1; }; then
    note "$1" "ok"; ok_n=$((ok_n+1)); return
  fi
  note "$1" "UNREADABLE (EDEADLK / evicted)"; fail=1; bad_n=$((bad_n+1))
}

echo "FX publish preflight"
check "Forex_Dashboard/data.js"      "$ROOT/Forex_Dashboard/data.js"
check "fx-macro-app/data.json"       "$REPO/data.json"
check "history/summary.json"         "$REPO/history/summary.json"
check "scripts/build-data-json.js"   "$SCRIPT_DIR/build-data-json.js"
check "scripts/push-data.sh"         "$SCRIPT_DIR/push-data.sh"
# git needs all three of these readable, not just HEAD (index/config were the
# actual blockers on 2026-08-31).
check ".git/HEAD"                    "$REPO/.git/HEAD"
check ".git/config"                  "$REPO/.git/config"
check ".git/index"                   "$REPO/.git/index"
check ".fx-deploy/id_ed25519"        "$ROOT/.fx-deploy/id_ed25519"

# Sample the history archive: build-data-json.js reads EVERY history/*.json to
# rebuild summary.json, so partial damage there must be caught before the build.
# NB: use a glob into an array, never $(ls ...) — the workspace path contains a
# space ("Trading forex") and word-splitting would break every path in half.
hist_bad=0; hist_seen=0
shopt -s nullglob
hist_files=( "$REPO"/history/[0-9]*.json )
shopt -u nullglob
hist_start=0
[ "${#hist_files[@]}" -gt 8 ] && hist_start=$(( ${#hist_files[@]} - 8 ))
for f in "${hist_files[@]:$hist_start}"; do
  hist_seen=$((hist_seen+1))
  head -c 16 "$f" >/dev/null 2>&1 || hist_bad=$((hist_bad+1))
done
if [ "$hist_seen" -gt 0 ]; then
  if [ "$hist_bad" -eq 0 ]; then
    note "history/*.json (last $hist_seen)" "ok"
  else
    note "history/*.json (last $hist_seen)" "$hist_bad UNREADABLE — archive at risk"
    fail=1
  fi
fi

if git -C "$REPO" rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
  note "git repository" "ok ($(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null))"
else
  note "git repository" "UNREACHABLE"; fail=1
fi

# Machine-readable summary so degradation can be tracked run to run.
echo "PREFLIGHT_SUMMARY readable=$ok_n unreadable=$bad_n history_unreadable=$hist_bad status=$([ "$fail" -eq 0 ] && echo OK || echo DEGRADED)"

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

PREFLIGHT FAILED — the workspace mount is degraded, not the data.

CAUSE: iCloud "Optimize Mac Storage" has evicted some files from ~/Documents.
Their content is no longer on local disk, and this sandbox cannot make iCloud
re-download them (macOS can; Linux/FUSE cannot -> EDEADLK).

Do NOT run build-data-json.js or push-data.sh from here: the build would rewrite
history/summary.json from an unreadable archive and git cannot open .git anyway.

FALLBACK (preferred — publishes without git, works on a degraded mount):

  node "<workspace>/fx-macro-app/scripts/publish-api.js"

It commits data.json over HTTPS with the GitHub Contents API, needing only
data.js (just written, so always readable) and a token. Notifications still
fire. It skips history/summary.json on purpose; the next healthy run rebuilds it.
If that also fails (no token), the publish must be completed manually on the Mac:

  node "$HOME/Documents/Claude/Projects/Trading forex/fx-macro-app/scripts/build-data-json.js"
  bash "$HOME/Documents/Claude/Projects/Trading forex/fx-macro-app/scripts/push-data.sh"

PERMANENT FIX (do once, on the Mac):
  System Settings > [your name] > iCloud > iCloud Drive > Optimize Mac Storage: OFF
MSG
  exit 4
fi

echo "preflight OK — safe to build and push"
exit 0
