# Hair Simo System Architecture

## 1) High-level modules

- **apps/web**  
  Public SEO website, booking UI, customer self-service flows, and public API/webhook handlers.
- **apps/admin**  
  Operational backoffice for owner/manager/staff with protected management endpoints.
- **packages/core**  
  Domain logic and service orchestration (`BookingService`, `PricingService`, slot engine, repository access).
- **packages/db**  
  Prisma schema and data access with PostgreSQL as source of truth.
- **packages/ai**  
  Channel-agnostic intent execution and multilingual prompt/template bundles.
- **packages/i18n**  
  Locale constants, dictionary lookup, locale routing helpers.

## 2) Layering

`Route handler (API) -> Service (business rules) -> Repository (Prisma queries) -> PostgreSQL`

This ensures business rules stay outside UI components and are reusable across channels (web/admin/chat/voice).

## 3) Main runtime flows

### Booking flow
1. Client calls `POST /api/booking`
2. `BookingService.createBooking` validates payload (Zod), checks service + slot conflicts
3. Repository upserts customer and creates appointment with status history
4. Response returns normalized appointment payload

### Availability flow
1. Client calls `GET /api/availability?serviceSlug=...&day=...`
2. Service loads blocked appointments and computes slots (`buildAvailabilitySlots`)
3. Returns available timeslots

### Payment flow
1. Client calls `POST /api/payments/checkout`
2. `PricingService` computes deposit/full amount
3. Stripe PaymentIntent created, `Payment` record persisted
4. Stripe webhook (`/api/payments/webhook`) updates `Payment.status`

### Chat flow (web/WhatsApp/SMS)
1. Incoming message reaches channel endpoint
2. `packages/ai` detects locale + intent
3. Intent mapped to tools (`createBooking`, `rescheduleBooking`, etc.)
4. Endpoint responds in detected locale

### Voice flow
1. Twilio posts call speech payload to `/api/voice/twilio`
2. Intent/locale inferred and routed to same AI tooling
3. TwiML response generated
4. `CallLog` saved for audit/fallback handover

## 4) Multi-language strategy

- URL-based locale prefixes: `/de`, `/it`, `/fr`, `/en`
- Fallback locale: `en`
- Dictionaries in `packages/i18n`
- `hreflang` alternate hints in locale metadata
- Locale-aware templates/prompts in `packages/ai`

## 5) Deployment target: Google Cloud

- `apps/web` and `apps/admin` deployed independently on Cloud Run
- PostgreSQL via Cloud SQL
- Webhook ingress routed to web service endpoints
- Secrets managed via Secret Manager
- Horizontal scaling controlled at Cloud Run service level
