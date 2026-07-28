# Hair Simo Platform

Production-ready multilingual salon operating system on **100% Google Cloud Platform**.

## Monorepo structure

- `apps/web` — public website, booking wizard, GCP webhooks (Dialogflow, Gemini, Google Pay)
- `apps/admin` — Identity Platform authenticated backoffice
- `packages/core` — business services
- `packages/db` — Prisma schema, migrations, seed
- `packages/ai` — Vertex AI Gemini assistant with function calling
- `packages/gcp` — GCP client integrations (Vertex AI, STT/TTS, Identity Platform, Pub/Sub, Cloud Tasks)
- `packages/i18n` — locale dictionaries + templates (de/it/fr/en)
- `packages/ui` — shared design system components
- `infra/terraform` — Cloud Run, AlloyDB, Cloud Armor, Pub/Sub, Cloud Tasks
- `docs` — architecture, API, operations, decisions

## GCP stack

| Feature | Service |
|---------|---------|
| Hosting | Cloud Run |
| Database | AlloyDB for PostgreSQL |
| Chat AI | Vertex AI Gemini 2.5 Flash |
| Voice | Dialogflow CX + Phone Gateway |
| STT | Cloud Speech-to-Text (Chirp) |
| TTS | Cloud Text-to-Speech (Chirp 3 HD) |
| Auth | Identity Platform |
| Notifications | Pub/Sub + Cloud Tasks + Gmail API |
| Payments | Google Pay + PSP webhook |
| Security | Cloud Armor + Secret Manager |

## Requirements

- Node.js 22+
- pnpm 10+
- Docker (local PostgreSQL via `docker compose`)
- GCP project (for production features)

## Quick start (local — no GCP required)

**Terminal-Agent / Laptop:** See `docs/TERMINAL-AGENT-GUIDE.md` for clone-from-GitHub + gcloud step-by-step.

```bash
# One-shot: clone/pull from GitHub + install + db setup
bash scripts/bootstrap-from-github.sh

# Or manual:
cp .env.example .env
# Set JWT_SECRET only. Leave GCP_PROJECT_ID empty.

pnpm install
pnpm db:setup
pnpm dev
```

- Web: http://localhost:3000/de (chat widget on every page)
- Booking: http://localhost:3000/de/booking (includes mock payment)
- Admin: http://localhost:3001/login

Without `GCP_PROJECT_ID`, everything runs in local mode: regex AI, JWT auth, mock payments, console notifications.

**Go-live:** See `docs/GO-LIVE.md` — only keys and GCP wiring needed, no code changes.

### Demo admin credentials (seed)

- `owner@hairsimo.local` / `HairSimo2026!`
- `manager@hairsimo.local` / `HairSimo2026!`
- `staff@hairsimo.local` / `HairSimo2026!`

## Scripts

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:setup
```

## Production deployment

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
```

Build containers:
```bash
docker build -f apps/web/Dockerfile -t hair-simo-web .
docker build -f apps/admin/Dockerfile -t hair-simo-admin .
```

## Documentation

- `docs/architecture.md` — system design and GCP mapping
- `docs/api.md` — API reference
- `docs/operations.md` — runbook
- `docs/decisions.md` — technical decisions
- `docs/GO-LIVE.md` — **production checklist (keys + connect only)**
- `docs/TERMINAL-AGENT-GUIDE.md` — **laptop + Cursor CLI + gcloud (ultra detailed)**
- `infra/terraform/README.md` — infrastructure guide
