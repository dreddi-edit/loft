#!/usr/bin/env bash
set -euo pipefail

# Hair Simo — clone or update from GitHub and prepare local dev.
# Safe to run repeatedly (idempotent).

REPO_URL="${HAIR_SIMO_REPO_URL:-https://github.com/dreddi-edit/loft.git}"
BRANCH="${HAIR_SIMO_BRANCH:-cursor/delete-all-repo-content-e10a}"
TARGET_DIR="${1:-${HAIR_SIMO_DIR:-$HOME/loft}}"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

log "Checking prerequisites"
require_cmd git
require_cmd node
require_cmd pnpm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "Node.js 22+ recommended (found $(node -v))"
fi

if [ -d "$TARGET_DIR/.git" ]; then
  log "Updating existing repo at $TARGET_DIR"
  git -C "$TARGET_DIR" fetch origin
  git -C "$TARGET_DIR" checkout "$BRANCH"
  git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH"
else
  log "Cloning $REPO_URL (branch: $BRANCH) into $TARGET_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"

log "Installing dependencies"
pnpm install

if [ ! -f .env ]; then
  log "Creating .env from .env.example"
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
  JWT_SECRET="$(openssl rand -base64 48)"
  if sed --version >/dev/null 2>&1; then
    sed -i "s|JWT_SECRET=replace-with-long-random-secret|JWT_SECRET=$JWT_SECRET|" .env
  else
    sed -i '' "s|JWT_SECRET=replace-with-long-random-secret|JWT_SECRET=$JWT_SECRET|" .env
  fi
  log "Generated JWT_SECRET in .env"
  else
    warn "openssl not found — set JWT_SECRET manually in .env"
  fi
else
  log ".env already exists — leaving unchanged"
fi

if command -v docker >/dev/null 2>&1; then
  log "Setting up local PostgreSQL + database schema"
  pnpm db:setup
else
  warn "Docker not found — skip pnpm db:setup. Install Docker or set DATABASE_URL manually."
fi

log "Done."
cat <<EOF

Repository ready at: $TARGET_DIR
Branch: $(git rev-parse --abbrev-ref HEAD)
Commit: $(git rev-parse --short HEAD)

Next steps:
  cd "$TARGET_DIR"
  pnpm dev

Docs for Cursor terminal agent:
  docs/TERMINAL-AGENT-GUIDE.md

Copy-paste starter prompt for 'agent':
  cat docs/TERMINAL-AGENT-GUIDE.md | sed -n '/STARTER_PROMPT_BEGIN/,/STARTER_PROMPT_END/p'

EOF
