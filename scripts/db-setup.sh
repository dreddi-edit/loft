#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d postgres
elif docker compose version >/dev/null 2>&1; then
  docker compose up -d postgres
else
  echo "Docker Compose not found. Start PostgreSQL manually or install Docker." >&2
  exit 1
fi

pnpm db:push
pnpm db:seed
