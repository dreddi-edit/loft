# Technical Decisions

## 2026-07-28 - Monorepo baseline

- **Package manager:** `pnpm` with workspace support for fast installs and strict dependency graphing.
- **Build orchestration:** `turbo` to execute and cache tasks across apps and packages.
- **Framework:** Next.js App Router for both `apps/web` and `apps/admin` to keep a shared full-stack model.
- **Language:** TypeScript strict mode enabled in shared base config.
- **Testing baseline:** Vitest configured at workspace level; business logic packages own critical tests.
- **Linting and formatting:** ESLint + Prettier at root with shared defaults for consistent code quality.
- **Cloud target default:** Architecture choices are compatible with containerized deployment on Google Cloud Run (apps) and Cloud SQL for PostgreSQL (planned in Step 2).

## 2026-07-28 - MVP system defaults

- **ORM choice:** Prisma + PostgreSQL to keep schema evolution explicit and type-safe.
- **Locale strategy:** URL-based locale routing with `en` fallback and dictionary-driven text lookup.
- **Booking conflict policy:** Staff-overlap conflicts are rejected (`SLOT_NOT_AVAILABLE`) during booking creation.
- **Payment strategy:** Stripe PaymentIntent API with explicit `deposit` vs `full` mode handling.
- **Chat/voice orchestration:** Intent routing via deterministic parser in `packages/ai` with shared tool contract.
- **Admin auth:** JWT cookie sessions (`admin_token`) with bcrypt password hashes and role checks.
- **Public endpoint safety baseline:** Added lightweight in-memory rate-limit guard for write-heavy public channels.
- **Voice fallback default:** If confidence is low (very short utterance), store callback-required `CallLog` entry and return handover message.
