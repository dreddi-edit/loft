# Technical Decisions

## 2026-07-28 - Monorepo baseline

- **Package manager:** `pnpm` with workspace support for fast installs and strict dependency graphing.
- **Build orchestration:** `turbo` to execute and cache tasks across apps and packages.
- **Framework:** Next.js App Router for both `apps/web` and `apps/admin` to keep a shared full-stack model.
- **Language:** TypeScript strict mode enabled in shared base config.
- **Testing baseline:** Vitest configured at workspace level; business logic packages own critical tests.
- **Linting and formatting:** ESLint + Prettier at root with shared defaults for consistent code quality.

## 2026-07-28 - MVP system defaults

- **ORM choice:** Prisma + PostgreSQL to keep schema evolution explicit and type-safe.
- **Locale strategy:** URL-based locale routing with `en` fallback and dictionary-driven text lookup.
- **Booking conflict policy:** Staff-overlap conflicts are rejected (`SLOT_NOT_AVAILABLE`) during booking creation.

## 2026-07-28 - GCP-native platform (production target)

All external SaaS dependencies replaced with Google Cloud services:

| Area | Previous | Current (GCP) |
|------|----------|---------------|
| Chat AI | Regex intent parser | Vertex AI Gemini 2.5 + function calling |
| Voice | Twilio + `<Say voice="alice">` | Dialogflow CX + Phone Gateway + Cloud STT/TTS (Chirp) |
| Admin auth | JWT + bcrypt only | Identity Platform (Firebase Admin) + JWT fallback for local dev |
| Notifications | Twilio SMS/WhatsApp + SMTP log | Pub/Sub + Cloud Tasks + Gmail API |
| Rate limiting | In-memory (dev) | Cloud Armor at load balancer (prod) + in-memory fallback (dev) |
| Payments | Stripe PaymentIntent | Google Pay + PSP gateway webhook |
| Database | Local PostgreSQL / Cloud SQL | AlloyDB for PostgreSQL |
| Deployment | Docker Compose (local) | Cloud Run + Terraform |

### Payments note

Google Cloud does not provide a native payment processor. Google Pay handles tokenization; a Payment Service Provider (PSP) connected via Google Pay gateway processes the actual transaction. The platform records payment state locally and receives confirmation via `/api/payments/webhook`.

### SMS/WhatsApp note

GCP does not offer direct SMS/WhatsApp delivery. Outbound messages are published to Pub/Sub for integration with a Business Communications partner or Dialogflow CX messaging channels. Email uses Gmail API.

### Local development

When `GCP_PROJECT_ID` is unset:
- AI falls back to regex intent parser
- Notifications log to console
- Auth uses local JWT + seed users
- TTS/STT return empty results

Set `GCP_PROJECT_ID` and Application Default Credentials to enable full GCP stack locally.
