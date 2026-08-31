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
# Clear locks via rename immediately before each index-writing step, and avoid
# no-op index commands (git status/fetch) in this script.
clear_locks() {
  for L in .git/index.lock .git/HEAD.lock .git/refs/heads/main.lock .git/refs/remotes/origin/main.lock; do
    if [ -e "$L" ]; then
      rm -f "$L" 2>/dev/null || mv "$L" "$L.stale_$(date +%s%N)" 2>/dev/null || true
    fi
  done
  return 0
}

clear_locks
git add data.json history/
# Commit only if something is actually staged for change.
if ! git diff --cached --quiet; then
  clear_locks
  git commit -m "data: $(date +%F)"
else
  echo "data.json/history unchanged; nothing to commit."
fi

clear_locks
git push origin main
echo "PUSH done -> local HEAD $(git rev-parse --short HEAD)"
