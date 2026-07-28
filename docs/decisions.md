# Technical Decisions

## 2026-07-28 - Monorepo baseline

- **Package manager:** `pnpm` with workspace support for fast installs and strict dependency graphing.
- **Build orchestration:** `turbo` to execute and cache tasks across apps and packages.
- **Framework:** Next.js App Router for both `apps/web` and `apps/admin` to keep a shared full-stack model.
- **Language:** TypeScript strict mode enabled in shared base config.
- **Testing baseline:** Vitest configured at workspace level; business logic packages own critical tests.
- **Linting and formatting:** ESLint + Prettier at root with shared defaults for consistent code quality.
- **Cloud target default:** Architecture choices are compatible with containerized deployment on Google Cloud Run (apps) and Cloud SQL for PostgreSQL (planned in Step 2).
