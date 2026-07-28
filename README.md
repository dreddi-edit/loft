# Hair Simo Platform

Production-ready MVP foundation for a multilingual salon operating system with booking, payments, AI chat, voice intake, and admin operations.

## Monorepo structure

- `apps/web`: Public website, multilingual pages, booking flows, payment + AI/voice webhooks
- `apps/admin`: Backoffice UI and role-protected admin APIs
- `packages/core`: Business layer (`API -> service -> repository`)
- `packages/db`: Prisma schema, client access, migrations, seed
- `packages/ai`: Intent detection, tool wiring, multilingual prompt/templates
- `packages/i18n`: Locale helpers and dictionaries (`de`, `it`, `fr`, `en`)
- `packages/ui`: Shared UI base package
- `docs`: Architecture, API, operations, decisions

## Requirements

- Node.js 22+
- pnpm 10+
- PostgreSQL 15+ (local or managed)
- Stripe account (test mode for MVP)
- Twilio account (WhatsApp/SMS/Voice webhooks)

## Quick start

1. Install dependencies:

```bash
pnpm install
```

2. Copy and fill environment variables:

```bash
cp .env.example .env
```

3. Generate Prisma client, migrate DB, seed demo data:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

4. Start all apps:

```bash
pnpm dev
```

- Web: `http://localhost:3000`
- Admin: `http://localhost:3001`

## Main scripts

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format
```

## Functional MVP coverage

- Website routing with locale prefixes: `/de`, `/it`, `/fr`, `/en`
- Required pages and booking entry points
- Availability + booking create/reschedule/cancel APIs
- Stripe PaymentIntent endpoint + webhook status sync
- Admin APIs with role checks (`x-role` header in MVP)
- AI chat endpoints for web/WhatsApp/SMS intents
- Twilio voice webhook with language detection and fallback call logging
- Notification reminder logging structure (anti-no-show preparation)

## Google Cloud deployment baseline

- Run `apps/web` and `apps/admin` as separate Cloud Run services
- Use Cloud SQL (PostgreSQL) for `DATABASE_URL`
- Use Secret Manager for Stripe/Twilio/auth secrets
- Set `NEXT_PUBLIC_BASE_URL` per deployed domain
- Configure ingress webhooks:
  - `/api/payments/webhook`
  - `/api/chat/whatsapp`
  - `/api/chat/sms`
  - `/api/voice/twilio`

## Known MVP TODOs

- Replace header-based admin auth with full auth provider (Clerk/Auth0/Descope)
- Add real outbound SMS/WhatsApp/email dispatch implementation
- Add Stripe refund workflow endpoint over `Refund` model
- Extend automated tests for route handlers and webhook contracts
