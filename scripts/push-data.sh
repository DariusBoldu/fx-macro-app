#!/usr/bin/env bash
# Auto-push fx-macro-app/data.json to GitHub Pages.
# Used by the daily Cowork FX scheduled task (File 1d). Mount-path independent.
#
# Auth: dedicated ed25519 DEPLOY KEY stored OUTSIDE the repo, in the persistent
# workspace folder ("Trading forex/.fx-deploy/"), so it survives sandbox resets
# and is never committed. At push time the key + a github ssh-config are staged
# into ~/.ssh (a space-free path), and GitHub is reached through the sandbox's
# allowlisted proxy via socat (the same routing the environment ships with).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS="$(cd "$REPO/.." && pwd)/.fx-deploy"
KEY="$SECRETS/id_ed25519"

if [ ! -f "$KEY" ]; then
  echo "ERROR: deploy key not found at: $KEY" >&2
  exit 3
fi

# --- stage credentials (NEVER touches the shared ~/.ssh/config) --------------
# FIX 2026-08-31: this script used to overwrite ~/.ssh/config (and ~/.ssh/
# known_hosts) with a socat ProxyCommand block. That is right inside the Cowork
# Linux sandbox, but this script is ALSO the documented manual fallback run on
# the Mac — and macOS has no socat and no :3128 proxy, so every later github.com
# SSH connection on the host broke ("command not found: socat").
# Now: a DEDICATED config file + `ssh -F`, so the user's own ~/.ssh/config is
# never read nor written, and the proxy is only used on Linux.
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
cp "$KEY" "$HOME/.ssh/fx_deploy" && chmod 600 "$HOME/.ssh/fx_deploy"
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > "$HOME/.ssh/fx_known_hosts"
FX_SSH_CONFIG="$HOME/.ssh/fx_deploy_config"

PROXY_LINE=""
if [ "$(uname -s)" = "Linux" ]; then
  # --- sandbox only: reach GitHub through the allowlisted CONNECT proxy ------
  # The sandbox CONNECT proxy on :3128 requires basic auth. Credentials are
  # minted per bash invocation and exposed in $https_proxy as
  #   http://<urlencoded-user>:<pass>@localhost:3128
  # They must be read at RUNTIME (never hardcoded) and URL-decoded, because the
  # username is base64 and its "==" padding arrives as "%3D%3D".
  #
  # The decoded username contains "%" and "=", which ssh's ProxyCommand runs
  # through percent_expand() -> "unknown key %3" and the connection dies. So the
  # socat invocation is written to a tiny helper script and ssh is pointed at
  # that, keeping every "%" away from ssh's expander.
  if ! command -v socat >/dev/null 2>&1; then
    echo "ERROR: socat needed for the sandbox proxy but not installed." >&2
    exit 5
  fi
  PROXY_AUTH=""
  if [ -n "${https_proxy:-}" ] && printf '%s' "$https_proxy" | grep -q '@'; then
    _pu=$(printf '%s' "$https_proxy" | sed -E 's|^https?://([^:]+):([^@]+)@.*|\1|')
    _pp=$(printf '%s' "$https_proxy" | sed -E 's|^https?://([^:]+):([^@]+)@.*|\2|')
    # URL-decode the username (%3D -> '=', etc).
    _pu=$(printf '%s' "$_pu" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))' 2>/dev/null || printf '%s' "$_pu")
    [ -n "$_pu" ] && PROXY_AUTH=",proxyauth=$_pu:$_pp"
  fi
  printf '%s\n' '#!/bin/sh' \
    "exec socat - PROXY:localhost:\$1:\$2,proxyport=3128${PROXY_AUTH}" \
    > "$HOME/.ssh/fx_proxy"
  chmod 700 "$HOME/.ssh/fx_proxy"
  PROXY_LINE="  ProxyCommand $HOME/.ssh/fx_proxy %h %p"
fi
# macOS / anywhere else: PROXY_LINE stays empty -> plain outbound SSH.

{
  echo "Host github.com"
  echo "  HostName github.com"
  echo "  User git"
  echo "  IdentityFile $HOME/.ssh/fx_deploy"
  echo "  IdentitiesOnly yes"
  echo "  UserKnownHostsFile $HOME/.ssh/fx_known_hosts"
  echo "  StrictHostKeyChecking yes"
  [ -n "$PROXY_LINE" ] && echo "$PROXY_LINE"
} > "$FX_SSH_CONFIG"
chmod 600 "$FX_SSH_CONFIG"

# -F <file> makes ssh ignore ~/.ssh/config entirely (safe on both platforms).
export GIT_SSH_COMMAND="ssh -F $FX_SSH_CONFIG"

cd "$REPO"

# Some sandbox mounts block unlink/rm but allow same-dir rename; a git command
# that opens the index without rewriting it can leave a stale *.lock behind.
# Clear locks immediately before each index-writing step.
#
# FIX 2026-09-14: the rename fallback used to produce "<ref>.lock.stale_<ts>".
# Under .git/refs/ git parses EVERY file as a ref, so those names broke
# `git fetch` ("bad object refs/remotes/origin/main.lock.s..."). A renamed lock
# now ENDS in ".lock", which git's ref scanner always skips. Where unlink works
# (the Mac), old remnants are swept away entirely.
clear_locks() {
  for L in .git/index.lock .git/HEAD.lock .git/refs/heads/main.lock .git/refs/remotes/origin/main.lock; do
    [ -e "$L" ] || continue
    # A lock under ~1 minute old may belong to a git command running RIGHT NOW:
    # the Mac's post-release follow-up and the sandbox's daily run share this
    # .git. Deleting a live lock can corrupt the index, so wait (max 60 s) for
    # it to clear; only a lock that outlives that is treated as stale.
    for _ in $(seq 1 30); do
      [ -e "$L" ] && [ -z "$(find "$L" -mmin +1 2>/dev/null)" ] || break
      sleep 2
    done
    [ -e "$L" ] || continue
    rm -f "$L" 2>/dev/null && continue
    mv "$L" "${L%.lock}.stale_$(date +%s)$RANDOM.lock" 2>/dev/null || true
  done
  return 0
}
sweep_stale_locks() {   # best effort: works on macOS, silently no-ops on the sandbox mount
  find .git \( -name '*.lock.stale_*' -o -name '*.lock.s[0-9]*' -o -name '*.lock.x[0-9]*' \
            -o -name '*.stale_*.lock' \) -type f -size 0 -delete 2>/dev/null || true
}

sweep_stale_locks
clear_locks
git add data.json history/
# Commit only if something is actually staged for change.
# FX_COMMIT_MSG lets the post-release follow-up label its commits.
if ! git diff --cached --quiet; then
  clear_locks
  git commit -m "${FX_COMMIT_MSG:-data: $(date +%F)}"
else
  echo "data.json/history unchanged; nothing to commit."
fi

# Integrate anything published from elsewhere first: scripts/publish-api.js
# commits straight to GitHub, and without this the push below is rejected as
# non-fast-forward.
clear_locks
if git fetch -q origin main 2>/dev/null; then
  if ! git merge-base --is-ancestor origin/main HEAD; then
    clear_locks
    # During a rebase "theirs" = OUR local commits being replayed, so the
    # freshest local data.json wins any conflict with the copy on GitHub.
    if ! git rebase --autostash -X theirs origin/main; then
      git rebase --abort 2>/dev/null || true
      echo "ERROR: could not rebase onto origin/main; nothing pushed. Resolve manually." >&2
      exit 6
    fi
  fi
else
  echo "WARN: git fetch failed; attempting a plain push." >&2
fi

clear_locks
git push origin main
echo "PUSH done -> local HEAD $(git rev-parse --short HEAD)"
