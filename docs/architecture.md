# Architecture (Step 1 Baseline)

## Monorepo model

- **Apps layer**: user-facing and staff-facing products (`apps/web`, `apps/admin`)
- **Domain layer**: reusable business services (`packages/core`)
- **Integration layer**: DB access + AI channel orchestration (`packages/db`, `packages/ai`)
- **Shared foundation**: UI and i18n modules (`packages/ui`, `packages/i18n`)

## Execution model

- Turborepo orchestrates `lint`, `test`, `typecheck`, and later `build`.
- TypeScript strict mode is shared from `tsconfig.base.json`.
- MVP quality gates run from the root scripts for consistent CI behavior.

## Cloud readiness defaults

- Compatible with Google Cloud Run service deployment for `web` and `admin`.
- Database package is prepared for PostgreSQL/Cloud SQL integration in Step 2.
