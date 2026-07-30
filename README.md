# Hair Simo Platform

Production-ready multilingual salon operating system on **100% Google Cloud Platform**, for
a real hair salon in Brixen / Bressanone, South Tyrol, Italy (`Europe/Rome`).

## Monorepo structure

- `apps/web` — public website, booking wizard, customer self-service (manage, verify,
  waitlist, voucher balance, ICS calendar links), GCP webhooks (Dialogflow, Gemini, Google
  Pay)
- `apps/admin` — Identity Platform authenticated backoffice, with an audit log on every
  mutation
- `packages/core` — business services: booking, pricing, payments, refunds, reminders,
  auth, plus nine feature domains — ICS calendar feeds, no-show policy, booking
  verification (double opt-in), waitlist, GDPR export/erasure, customer history & colour
  formulas, review requests, vouchers, recurring series — see `docs/architecture.md` for
  which of them are wired up to a route today
- `packages/db` — Prisma schema, migrations, seed (Cloud SQL for PostgreSQL 16)
- `packages/ai` — Vertex AI Gemini assistant with function calling
- `packages/gcp` — GCP client integrations (Vertex AI, STT/TTS, Identity Platform, Pub/Sub,
  Cloud Tasks)
- `packages/i18n` — locale dictionaries + templates (de/it/fr/en)
- `packages/ui` — shared design system components
- `infra/terraform` — Cloud Run, Cloud SQL, Cloud Armor, Pub/Sub, Cloud Tasks (`europe-west8`, Milan)
- `docs` — architecture, API, operations, decisions

## GCP stack

| Feature | Service |
|---------|---------|
| Hosting | Cloud Run (`europe-west8`, Milan) |
| Database | Cloud SQL for PostgreSQL 16, private IP |
| Chat AI | Vertex AI Gemini 2.5 Flash (`europe-west1`, Belgium) |
| Voice | Dialogflow CX + Phone Gateway |
| STT | Cloud Speech-to-Text (Chirp) |
| TTS | Cloud Text-to-Speech (Chirp 3 HD) |
| Auth | Identity Platform |
| Notifications | Pub/Sub + Cloud Tasks + Gmail API |
| Payments | Google Pay + PSP webhook |
| Security | Cloud Armor (Standard tier) + Secret Manager |

See `docs/architecture.md` for why Vertex AI runs in a different region from everything
else, and `docs/decisions.md` for why the region and the database engine both changed on
2026-07-29.

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

## Admin access (seed)

Set `SEED_ADMIN_PASSWORD` in `.env`, then run `pnpm db:seed`.

Team accounts:
- `simona@hairsimo.it` (owner)
- `daniela@hairsimo.it`, `helga@hairsimo.it`, `tina@hairsimo.it` (staff)

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

- `docs/architecture.md` — system design, GCP mapping, and what each new capability
  actually does today
- `docs/api.md` — API reference, enumerated from the filesystem with a date stamp
- `docs/operations.md` — runbook, including the full environment-variable reconciliation
- `docs/decisions.md` — technical decisions, including the ones taken after go-live
- `docs/GO-LIVE.md` — **production checklist (keys + connect only)**
- `docs/TERMINAL-AGENT-GUIDE.md` — **laptop + Cursor CLI + gcloud (ultra detailed)**
- `infra/terraform/README.md` — infrastructure guide
