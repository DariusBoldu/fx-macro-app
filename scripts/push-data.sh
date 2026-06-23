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

# --- stage credentials into ~/.ssh (no spaces in path -> no quoting issues) ---
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
cp "$KEY" "$HOME/.ssh/fx_deploy" && chmod 600 "$HOME/.ssh/fx_deploy"
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > "$HOME/.ssh/known_hosts"
cat > "$HOME/.ssh/config" <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/fx_deploy
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/known_hosts
  StrictHostKeyChecking yes
  ProxyCommand socat - PROXY:localhost:%h:%p,proxyport=3128
EOF
chmod 600 "$HOME/.ssh/config"
export GIT_SSH_COMMAND="ssh"   # use ~/.ssh/config (drops any inline env ProxyCommand)

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
git add data.json
# Commit only if data.json is actually staged for change.
if git diff --cached --name-only | grep -qx "data.json"; then
  clear_locks
  git commit -m "data: $(date +%F)"
else
  echo "data.json unchanged; nothing to commit."
fi

clear_locks
git push origin main
echo "PUSH done -> local HEAD $(git rev-parse --short HEAD)"
