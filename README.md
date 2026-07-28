# Hair Simo Platform

Production-oriented monorepo foundation for the Hair Simo salon operating system.

## Workspace structure

- `apps/web` - Public website and booking UX (Next.js App Router)
- `apps/admin` - Backoffice and team operations UI (Next.js App Router)
- `packages/ui` - Shared UI primitives and design-system base
- `packages/db` - Database package scaffold (Prisma schema/migrations in step 2)
- `packages/core` - Domain/business logic services
- `packages/ai` - AI orchestration entry points for chat and voice
- `packages/i18n` - Localization helpers and locale defaults
- `docs` - Architecture and engineering decisions

## Prerequisites

- Node.js 22+
- pnpm 10+

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

- Web app: http://localhost:3000
- Admin app: http://localhost:3001

## Quality checks

```bash
pnpm lint
pnpm test
pnpm typecheck
```

## Current status

Step 1 (monorepo baseline) is implemented. Step 2 adds database schema, migration flow, and seed data.
