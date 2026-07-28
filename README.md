# Hair Simo Platform

Production-ready multilingual salon operating system with booking, payments, AI chat/voice, and admin backoffice.

## Monorepo structure

- `apps/web` — public website, booking wizard, payment + AI/voice webhooks
- `apps/admin` — authenticated backoffice with dashboard and CRUD APIs
- `packages/core` — business services (`BookingService`, `PricingService`, `AuthService`, `NotificationService`, `RefundService`)
- `packages/db` — Prisma schema, migrations, seed
- `packages/ai` — intent detection + tool orchestration
- `packages/i18n` — locale dictionaries + templates (de/it/fr/en)
- `packages/ui` — shared design system components
- `docs` — architecture, API, operations, decisions

## Requirements

- Node.js 22+
- pnpm 10+
- Docker (for local PostgreSQL via `docker compose`)

## Quick start

```bash
cp .env.example .env
# set JWT_SECRET and DATABASE_URL

pnpm install
pnpm db:setup   # starts postgres, pushes schema, seeds demo data
pnpm dev
```

- Web: http://localhost:3000
- Admin: http://localhost:3001/login

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
pnpm db:generate
pnpm db:push
pnpm db:seed
```

## MVP feature coverage

- 4-language website (`/de`, `/it`, `/fr`, `/en`) with SEO sitemap/robots/hreflang
- Multi-step booking wizard (service → stylist → slot → customer → payment intent)
- Availability engine with buffers and conflict checks
- Stripe checkout + webhook + refund endpoint
- JWT admin auth with role-based API access (`owner`, `manager`, `staff`)
- Admin dashboard, appointments, customers, services, staff, business hours
- AI chat endpoints (web/WhatsApp/SMS) with booking intents
- Twilio voice webhook with call logs + fallback handover
- Notification reminder pipeline (email log + Twilio SMS/WhatsApp adapters)
- GDPR-oriented consent records and audit status history

## Google Cloud (later)

Deploy `apps/web` and `apps/admin` to Cloud Run, PostgreSQL to Cloud SQL, secrets via Secret Manager. See `docs/architecture.md`.

## Documentation

- `docs/architecture.md`
- `docs/api.md`
- `docs/operations.md`
- `docs/decisions.md`
