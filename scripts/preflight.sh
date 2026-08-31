#!/usr/bin/env bash
# preflight.sh — run BEFORE build-data-json.js + push-data.sh (added 2026-08-28).
#
# Why this exists: the Cowork Linux sandbox reaches the workspace through a FUSE
# mount that can degrade so that files already on the host are unreadable —
# every read returns EDEADLK ("Resource deadlock avoided", errno -35) while
# stat/readdir keep working and freshly written files read fine. In that state
# `git` cannot open .git, and a naive build would rewrite history/summary.json
# from an empty archive.
#
# Exit codes:
#   0  mount healthy  -> run build-data-json.js then push-data.sh as normal
#   4  mount degraded -> data.js is still valid; report the manual commands
#                        instead of publishing. Do NOT try to work around it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$REPO/.." && pwd)"

fail=0
note() { printf '  %-46s %s\n' "$1" "$2"; }

check() { # check <label> <path>
  if [ ! -e "$2" ]; then note "$1" "MISSING"; fail=1; return; fi
  # up to 3 attempts: the deadlock is occasionally transient
  for _ in 1 2 3; do
    if head -c 16 "$2" >/dev/null 2>&1; then note "$1" "ok"; return; fi
    sleep 2
  done
  note "$1" "UNREADABLE (EDEADLK)"; fail=1
}

echo "FX publish preflight"
check "Forex_Dashboard/data.js"      "$ROOT/Forex_Dashboard/data.js"
check "fx-macro-app/data.json"       "$REPO/data.json"
check "history/summary.json"         "$REPO/history/summary.json"
check "scripts/build-data-json.js"   "$SCRIPT_DIR/build-data-json.js"
check "scripts/push-data.sh"         "$SCRIPT_DIR/push-data.sh"
check ".git/HEAD"                    "$REPO/.git/HEAD"
check ".fx-deploy/id_ed25519"        "$ROOT/.fx-deploy/id_ed25519"

if git -C "$REPO" rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
  note "git repository" "ok ($(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null))"
else
  note "git repository" "UNREACHABLE"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

PREFLIGHT FAILED — the workspace mount is degraded, not the data.
Do NOT run build-data-json.js or push-data.sh from here: the build would rewrite
history/summary.json from an unreadable archive and git cannot open .git anyway.

Finish the run by writing Forex_Dashboard/data.js only, then report that the
publish must be completed manually with these two commands in Terminal:

  node "$HOME/Documents/Claude/Projects/Trading forex/fx-macro-app/scripts/build-data-json.js"
  bash "$HOME/Documents/Claude/Projects/Trading forex/fx-macro-app/scripts/push-data.sh"
MSG
  exit 4
fi

echo "preflight OK — safe to build and push"
exit 0
