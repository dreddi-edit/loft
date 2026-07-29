# Operations Guide

## 1) Service management

Services are stored in:
- `Service`
- `ServiceTranslation`

Operational steps:
1. Add or update base service (`slug`, duration, price, buffer) via `POST`/`PATCH
   /api/services[/id]`.
2. Add translations for `de/it/fr/en`.
3. Link service with staff via `PUT /api/staff/[id]/services`.

## 2) Staff and schedule management

Key entities:
- `StaffProfile`
- `StaffAvailabilityRule`
- `StaffTimeOff`
- `BusinessHours`

Steps:
1. Create `User` + `StaffProfile` (`POST /api/staff`).
2. Assign role (`owner`, `manager`, `staff`) via `UserRole` (`PATCH /api/staff/[id]`).
3. Define default weekly windows in `StaffAvailabilityRule`
   (`PUT /api/staff/[id]/availability`) — `dayOfWeek`/`startMin`/`endMin` are read as the
   **salon's own** calendar day and wall clock (`packages/core/src/time.ts`), never the
   server's.
4. Add planned absences in `StaffTimeOff` (`POST /api/staff/[id]/time-off`).

A staff member's subscribable calendar feed URL is looked up with
`GET /api/calendar/feed-url` — see section 12.

## 3) Booking operations

Flows:
- create: `POST /api/booking`
- customer-initiated reschedule/cancel: `POST /api/appointment/[token]` (signed manage
  token, `action: "reschedule" | "cancel"`)
- staff-initiated actions: `POST /api/appointments/[id]/[action]` in the admin app
  (`action` ∈ `reschedule, cancel, confirm, no_show, complete`)

**The old, unauthenticated `POST /api/booking/{id}/reschedule` and
`POST /api/booking/{id}/cancel` no longer exist.** They let anyone who knew or guessed an
appointment id move or cancel a stranger's booking. See `docs/api.md` for the token-based
replacement and why it is verified twice.

Status audit trail is persisted in `AppointmentStatusHistory`, and every admin-initiated
action additionally writes an `AuditLog` row (section 13).

### No-show protection

`evaluateNoShowPolicy` decides, from the service price alone, whether a booking needs a
deposit (`NO_SHOW_DEPOSIT_THRESHOLD_CENTS`, default EUR 50 and up) or a double opt-in
e-mail confirmation (below the threshold, web channel only — phone/WhatsApp bookings
already prove contact through the carrier). The confirmation link is redeemed at
`GET /api/verify/[token]` and re-sent at `POST /api/verify/resend`;
`POST /api/cron/sweep` releases slots whose link lapsed or was never issued. **As of
2026-07-29 this decision is not yet invoked automatically when a booking is created** — see
"Known gaps" in `docs/architecture.md` before assuming every no-deposit booking already
gets a verification e-mail.

### Waitlist

`POST /api/waitlist` queues a customer for a window on a service (unauthenticated, named by
service slug + e-mail). When a slot frees up, `WaitlistService.notifyMatches` offers it to
up to three people at once in strict join order; whoever claims first via
`POST /api/waitlist/[token]` gets the appointment, everyone else is told immediately and
returned to the front of the queue with no penalty. Admin visibility and manual
cancel/expire: `GET`/`PATCH`/`DELETE /api/waitlist[/id]`. The automatic expiry sweep
(`WaitlistService.expire`) is not yet called from `/api/cron/sweep` — run it by hand or
wire it in before relying on stale offers clearing themselves.

### Recurring series

A standing weekly/N-weekly booking is created with `RecurringService.createSeries` and
turned into real appointments by `RecurringService.materialiseDue`, which needs to run on a
schedule (there is no route or cron entry for it yet — see `docs/architecture.md`). Pausing,
resuming, skipping one occurrence, and ending a series (optionally cancelling future
occurrences) are all service methods; none has an admin route today.

## 4) Payment operations (Google Pay)

1. Call `POST /api/payments/checkout` — returns `googlePayRequest`.
2. Client renders the Google Pay button and completes payment.
3. PSP sends confirmation to `POST /api/payments/webhook` (HMAC body signature +
   bearer secret, see `docs/api.md`).
4. Payment status updated to `paid`; a refund is issued by admins at
   `POST /api/payments/refund`, or by the same webhook with `status: "refunded"`.

Configure in Secret Manager:
- `GCP_GOOGLE_PAY_MERCHANT_ID`
- `GCP_PAYMENT_GATEWAY` / `GCP_PAYMENT_GATEWAY_MERCHANT_ID`
- `GCP_PAYMENT_WEBHOOK_SECRET` — bearer secret for the webhook
- `PAYMENT_WEBHOOK_SIGNING_SECRET` — HMAC key over the raw webhook body
- `PAYMENTS_MERCHANT_COUNTRY` — ISO 3166-1 alpha-2, defaults to `IT`. This is the
  **merchant's** country, not the customer's; setting it to anything but `IT` for this
  salon is a bug, not a locale preference.

## 5) Chat channel activation

Set environment variables:
- `GCP_PROJECT_ID`
- `GCP_VERTEX_LOCATION`
- `GCP_GEMINI_MODEL`

Configure webhooks:
- Web chat: built into booking site (`/api/chat/web`)
- WhatsApp/SMS: route partner webhooks to `/api/chat/whatsapp` or `/api/chat/sms`

## 6) Voice activation (Dialogflow CX)

1. Create Dialogflow CX agent in `GCP_DIALOGFLOW_LOCATION`.
2. Configure Phone Gateway with an **Italian** number — the salon is in Brixen/Bressanone,
   South Tyrol, Italy, not Switzerland.
3. Set webhook URL: `https://<web-domain>/api/voice/dialogflow`, and set
   `GCP_DIALOGFLOW_WEBHOOK_SECRET` on both the Cloud Run service and the Dialogflow CX
   webhook's custom-header auth — the route refuses to start in production without it.
4. Enable Cloud Speech-to-Text (Chirp) and Text-to-Speech (Chirp 3 HD).

Chirp 3 HD voice mapping:
- German: `de-DE-Chirp3-HD-Charon`
- Italian: `it-IT-Chirp3-HD-Charon`
- French: `fr-FR-Chirp3-HD-Charon`
- English: `en-US-Chirp3-HD-Charon`

Behavior:
- Gemini processes intent with function calling.
- Chirp 3 HD synthesizes response audio.
- `CallLog` stored for audit.
- A low-confidence utterance (short transcript or low Dialogflow confidence) gets a fixed
  human-handover message instead of a synthesised guess at what was said; no Pub/Sub
  callback workflow exists for this today (see `docs/architecture.md`, "Known gaps" —
  there is no Pub/Sub consumer for anything in this platform).

## 7) Admin access

Production: Identity Platform
1. Enable Identity Platform in GCP console.
2. Set `GCP_IDENTITY_PLATFORM_ENABLED=true`.
3. Create users matching seed emails with appropriate custom claims (`role`).
4. Admin login accepts a Firebase `idToken`.

Local dev: JWT fallback
- Team accounts from seed (`simona@hairsimo.it`, etc. — hardcoded in
  `packages/db/src/seed.ts`, not read from `ADMIN_OWNER_EMAIL`; see the environment
  variable table below).
- Set `JWT_SECRET` in `.env`. Set `ADMIN_JWT_SECRET` separately in anything resembling
  production — see `docs/architecture.md` section 4 for why sharing it with
  `APPOINTMENT_TOKEN_SECRET` is a real weakening, not a cosmetic one.

Every admin session is re-validated against the database on every request
(`AuthService.verifyToken`), so deactivating a `User` or changing a role takes effect
immediately, on the very next request that session makes.

## 8) Notifications

Reminder pipeline:
1. Cloud Scheduler triggers `POST /api/cron/reminders` hourly.
2. `NotificationService` claims the appointment/template pair in a serializable transaction,
   then sends: e-mail via Gmail API (`GCP_GMAIL_SENDER`) directly; SMS/WhatsApp by
   publishing to the Pub/Sub topic `hair-simo-notifications` and reporting `sent` as soon as
   the publish itself succeeds.
3. **There is no consumer of that Pub/Sub topic in this repository.** An SMS or WhatsApp
   reminder is published and then delivered by nothing — there is no partner worker, no
   push subscription, no Cloud Function wired up. Only e-mail and cron-scheduled
   Cloud-Tasks delivery are connected end to end today. Do not tell a customer "we text
   reminders" until this is closed.

Review-request pipeline (`ReviewRequestService.dispatchDue`) follows the same
delay/cooldown/lifetime-cap logic as reminders but **has no cron entry point yet** — see
`docs/architecture.md`.

## 9) Waitlist, vouchers, recurring series, review requests — operational summary

See sections 3, 4 and 8 above and `docs/architecture.md` section 5 for the mechanics of
each. As a quick reference for what is actually reachable today (2026-07-29):

| Capability | Customer-facing route | Admin route | Scheduled job |
|---|---|---|---|
| Waitlist | `POST /api/waitlist`, `GET`/`POST /api/waitlist/[token]` | `GET /api/waitlist`, `PATCH`/`DELETE /api/waitlist/[id]` | not wired |
| Vouchers | `GET /api/vouchers/balance` | `GET`/`POST /api/vouchers` | n/a |
| Recurring series | none | none | not wired |
| Review requests | `GET /api/review/[token]` — **not present**, see below | none | not wired |
| No-show verification | `GET /api/verify/[token]`, `POST /api/verify/resend` | none | `POST /api/cron/sweep` |
| Customer history / colour formulas | n/a | none — `apps/admin/app/api/customers/[id]` still uses the older `salonRepository.addCustomerNote`, not `CustomerHistoryService` | n/a |
| GDPR export/erasure | none | none | not wired |
| ICS calendar | `GET /api/calendar/[token]`, `GET /api/calendar/appointment/[token]` | `GET /api/calendar/feed-url` | n/a |

`ReviewRequestService.buildReviewUrl` builds a link of the shape
`.../api/review/<token>`, but no `apps/web/app/api/review/[token]` route exists yet in this
snapshot — a review-request e-mail sent today would link to a 404. Confirm this against the
filesystem before sending one.

## 10) GDPR: export, erasure, data retention

`GdprService` (`packages/core/src/gdpr-service.ts`) implements Art. 15/20 export and Art. 17
erasure, tracked through the `DataRequest` model (`type: export | erasure`,
`status: pending | processing | completed | failed`). **No admin or customer-facing route
calls this service yet** — today it is only reachable from a Node REPL, a script, or a test.
Treat "GDPR requests can be handled" as false until a route exists; verify against
`apps/admin/app/api` before promising a customer a self-service export or deletion.

Erasure anonymises rather than deletes: identifiers are destroyed or replaced with an
irreversible placeholder, but the appointment, payment and refund rows survive, because
Italian law (Codice Civile art. 2220, DPR 633/1972 art. 39) requires accounting records to
be kept for **ten years**. `GdprService.verifyErasure` re-scans the database for the
destroyed identifiers to prove the erasure took.

**Data retention beyond GDPR erasure is a stated policy, not an automated job.**
`ErasureReceipt.retained` records the legal basis and retention period for every data class
kept back after an erasure (ten years for appointments/payments/refunds/voucher
redemptions, two years for audit-log entries, indefinite for the `DataRequest` record
itself) — but nothing purges a row once its retention period elapses. The
`POST /api/cron/sweep` source comment names a "GDPR retention job" explicitly as **not
written yet**. Do not represent this platform as automatically purging expired data.

## 11) Customer history and colour formulas

`CustomerHistoryService` (`packages/core/src/customer-history-service.ts`) is the intended
stylist-facing view: pinned notes, allergies (always pinned regardless of what the caller
passes), a two-year rolling visit window, derived preferred staff/service, lifetime value,
and colour-formula history stored as a JSON envelope inside a `formula`-kind
`CustomerNote.note` (see the docstring on `serializeFormula` in that file for why a JSON
string in an existing text column was chosen over a schema migration). **No admin route
uses this service today** — `PATCH /api/customers/[id]` still writes plain notes through
`salonRepository.addCustomerNote`. Recording a colour formula through the admin UI, if the
UI exists, is not backed by this service yet.

## 12) Calendar (ICS) feeds

Every appointment confirmation can carry an `.ics` attachment
(`GET /api/calendar/appointment/[token]`, same signed manage token as the appointment
itself), and each staff member has a read-only, subscribable calendar feed
(`GET /api/calendar/[token]`) that Google Calendar, Apple Calendar and Outlook poll on their
own schedule — there is no push, no OAuth, and no credential that expires. Look up (or
re-derive) a staff member's feed URL with `GET /api/calendar/feed-url`
(`?staffId=` for owner/manager; a `staff` session only ever gets its own). The token cannot
be revoked individually today short of rotating `STAFF_FEED_TOKEN_SECRET`, which invalidates
every staff feed at once, or deactivating the `User`, which also logs them out of the back
office — see the docstring on `verifyStaffFeedToken` in `packages/core/src/calendar.ts` for
the one-column schema change that would fix this properly. See `docs/decisions.md` for why
this replaced a Google Calendar OAuth sync rather than sitting alongside one.

## 13) Admin audit log

Every mutating `adminRoute` call writes an `AuditLog` row automatically — this needed no new
route, it piggybacks on every existing admin mutation (`apps/admin/lib/admin-api.ts`).
Redaction strips any key that looks like a password, token, secret, credential, card number
or IBAN before the row is written. The five legacy `/api/staff/[id]/**` routes that call
`requireSession` directly (see `docs/api.md`) are not audited — that gap is real, not a
documentation simplification.

## 14) Infrastructure deployment

```bash
cd infra/terraform
terraform init && terraform apply
```

Production region is **`europe-west8` (Milan)**, not Zurich — see `docs/decisions.md`.
Vertex AI stays in `europe-west1` (Belgium) for model availability. See
`infra/terraform/README.md` for the full deployment guide and cost breakdown, and
`docs/GO-LIVE.md` for the go-live checklist.

## 15) Rate limiting

Production: Cloud Armor policy on the load balancer (100 req/min per IP, Standard tier —
Adaptive Protection deliberately not enabled, see `docs/decisions.md`), **in addition to**
the app-level policies in `apps/web/lib/rate-limit.ts` and `apps/admin/lib/admin-api.ts`.
Development: the app-level in-memory limiter is the only one running. See `docs/api.md` for
the full policy table — the in-memory store is per Cloud Run instance and resets on every
scale-to-zero; a Postgres-backed store is a named but unimplemented seam.

## 16) Environment variables

Reconciled against every `process.env` read in the codebase as of 2026-07-29. "Read by"
lists where the variable is actually consulted; "In `.env.example`" flags anything the
example file does or does not mention.

### Documented in `.env.example` and used

| Variable | Read by |
|---|---|
| `NODE_ENV`, `NEXT_PUBLIC_BASE_URL` | throughout |
| `DATABASE_URL` | `packages/db/src/client.ts` |
| `JWT_SECRET` | fallback for `ADMIN_JWT_SECRET`/`APPOINTMENT_TOKEN_SECRET`/`STAFF_FEED_TOKEN_SECRET`/`WAITLIST_OFFER_SECRET`/`REVIEW_LINK_SECRET` |
| `ADMIN_JWT_SECRET`, `APPOINTMENT_TOKEN_SECRET` | `packages/core/src/auth-service.ts` |
| `TRUSTED_PROXY_HOPS` | `apps/admin/lib/login-throttle.ts` |
| `RATE_LIMIT_TRUSTED_HOPS` | `apps/web/lib/client-ip.ts` |
| `SALON_TIME_ZONE` | `packages/core/src/time.ts` |
| `GCP_IDENTITY_PLATFORM_ENABLED`, `GCP_FIREBASE_PROJECT_ID` | `packages/gcp/src/identity-platform.ts`, `config.ts` |
| `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | `packages/gcp/src/config.ts`, `access-token.ts` |
| `PAYMENTS_MOCK_ENABLED` | `apps/web/lib/public-config.ts` |
| `GCP_REGION`, `GCP_VERTEX_LOCATION`, `GCP_GEMINI_MODEL`, `GCP_DIALOGFLOW_AGENT_ID`, `GCP_DIALOGFLOW_LOCATION` | `packages/gcp/src/config.ts` |
| `GCP_STT_LANGUAGE_CODES`, `GCP_TTS_VOICE_{DE,IT,FR,EN}` | `packages/gcp/src/config.ts` |
| `GCP_PUBSUB_TOPIC_NOTIFICATIONS`, `GCP_CLOUD_TASKS_QUEUE`, `GCP_CLOUD_TASKS_HANDLER_URL` | `packages/gcp/src/config.ts` |
| `GCP_CLOUD_TASKS_SECRET` | shared secret `cloudTasks` and (with `CRON_SECRET`) `cron` |
| `GCP_GMAIL_SENDER` | `packages/core/src/notification-service.ts` |
| `GCP_GOOGLE_PAY_MERCHANT_ID`, `GCP_PAYMENT_GATEWAY`, `GCP_PAYMENT_GATEWAY_MERCHANT_ID` | `packages/core/src/payment-service.ts`, `apps/web/lib/public-config.ts` |
| `GCP_PAYMENT_WEBHOOK_SECRET` | shared secret `paymentWebhook` |
| `SEED_ADMIN_PASSWORD` | `packages/db/src/seed.ts` |
| `CRON_SECRET` | shared secret `cron` (with `GCP_CLOUD_TASKS_SECRET`) |

`GCP_REGION=europe-west6` in the checked-in `.env.example` is stale — production is
`europe-west8` (Milan). This file is owned outside this documentation pass; flagging it
here rather than editing it.

### Read by the code but missing from `.env.example`

| Variable | Read by | What it controls |
|---|---|---|
| `CONTACT_INBOX_EMAIL` | `apps/web/app/api/contact/route.ts` | Recipient of the contact form (falls back to `info@hairsimo.it`) |
| `GCP_DIALOGFLOW_WEBHOOK_SECRET` | `apps/web/app/api/_lib/route-secret.ts` | Auth for the Dialogflow CX webhook |
| `VOICE_SIMULATOR_ENABLED` | `apps/web/app/api/voice/simulate/route.ts` | Must be `"true"` to allow the simulator in production |
| `PAYMENT_WEBHOOK_SIGNING_SECRET` | `apps/web/app/api/payments/webhook/route.ts` | HMAC key over the raw payment webhook body |
| `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` | same | Replay window for the webhook signature (default 300s, capped at 3600s) |
| `PAYMENTS_MERCHANT_COUNTRY` | `packages/core/src/payment-service.ts` | Google Pay merchant country, defaults to `IT` |
| `PAYMENTS_DEPOSIT_THRESHOLD_CENTS`, `PAYMENTS_DEPOSIT_PERCENTAGE` | `packages/core/src/pricing-service.ts` | Deposit computed at checkout time (see below re: `NO_SHOW_*`) |
| `NO_SHOW_DEPOSIT_THRESHOLD_CENTS`, `NO_SHOW_DEPOSIT_PERCENTAGE`, `NO_SHOW_FEE_PERCENTAGE`, `NO_SHOW_GRACE_MINUTES` | `packages/core/src/no-show-policy.ts` | The no-show/verification policy decision (see `docs/architecture.md` — not yet invoked at booking time) |
| `STAFF_FEED_TOKEN_SECRET` | `packages/core/src/calendar.ts` | Signs staff calendar feed tokens (falls back to `JWT_SECRET`) |
| `WAITLIST_OFFER_SECRET`, `WAITLIST_CLAIM_BASE_URL`, `WAITLIST_OFFER_TTL_MINUTES`, `WAITLIST_OFFER_COOLDOWN_MINUTES`, `WAITLIST_MIN_LEAD_MINUTES` | `packages/core/src/waitlist-service.ts` | Waitlist offer tokens and timing |
| `REVIEW_LINK_SECRET`, `GOOGLE_REVIEW_URL`, `GOOGLE_MAPS_PLACE_ID` | `packages/core/src/review-request-service.ts` | Review-request click tokens and the Google review deep link |
| `VOUCHER_VALIDITY_MONTHS`, `VOUCHER_MIN_VALIDITY_MONTHS` | `packages/core/src/voucher-service.ts` | Default/minimum voucher validity |
| `SALON_CALENDAR_ORGANIZER_EMAIL` | `packages/core/src/calendar.ts` | ICS `ORGANIZER` e-mail (falls back to `GCP_GMAIL_SENDER`, then a fixed default) |
| `RATE_LIMIT_STORE` | `apps/web/lib/rate-limit.ts` | Set to anything but `"postgres"` today — `"postgres"` throws, the store is unimplemented |

There is no code review issue here, but two of the pairs above are worth understanding
together: `PAYMENTS_DEPOSIT_THRESHOLD_CENTS`/`PAYMENTS_DEPOSIT_PERCENTAGE`
(`pricing-service.ts`) compute the deposit amount actually charged at
`POST /api/payments/checkout`, while `NO_SHOW_DEPOSIT_THRESHOLD_CENTS`/
`NO_SHOW_DEPOSIT_PERCENTAGE` (`no-show-policy.ts`) are the newer module that also decides
*whether* a deposit should apply at all, plus the double-opt-in fallback. As of 2026-07-29
only the first pair is on the live path (booking creation does not call
`evaluateNoShowPolicy` yet); do not assume setting the `NO_SHOW_*` variables changes
anything a customer experiences until that wiring lands.

### Documented in `.env.example` but never read by the code

| Variable | Note |
|---|---|
| `LOG_LEVEL` | No code reads it. Every log line goes through the fixed severity mapping in `apps/web/lib/api-handler.ts`/`apps/admin/lib/admin-api.ts`. |
| `SENTRY_DSN` | No Sentry SDK is imported anywhere in the repository. |
| `ADMIN_OWNER_EMAIL` | `packages/db/src/seed.ts` hardcodes `simona@hairsimo.it` and the rest of the seed team directly; this variable is not consulted. |
