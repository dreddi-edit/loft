# Hair Simo System Architecture

## 1) High-level modules

- **apps/web**
  Public SEO website, booking wizard, customer self-service (manage/cancel/reschedule,
  double opt-in verification, waitlist join/claim, voucher balance, ICS calendar links),
  and GCP webhook handlers.
- **apps/admin**
  Operational backoffice for owner/manager/staff: appointments, customers, staff,
  services, products, waitlist, vouchers, reports, and calendar feed URLs, with an audit
  log on every mutation.
- **packages/core**
  Domain logic and service orchestration. The barrel (`packages/core/src/index.ts`) now
  exports, alongside the original services, nine feature domains added on top of the
  original booking/payment/notification core:

  | Service / module | File | What it owns |
  |---|---|---|
  | `calendar` (ICS) | `calendar.ts` | RFC 5545 generation: confirmation invite, cancellation, per-staff subscribable feed, staff-feed tokens |
  | `no-show-policy` | `no-show-policy.ts` | Deposit-threshold and no-show-fee decision, resolved once from the environment |
  | `booking-verification-service` | `booking-verification-service.ts` | Double opt-in for no-deposit bookings: issue, verify, expire, sweep orphans |
  | `waitlist-service` (`WaitlistService`) | `waitlist-service.ts` | Join, fairness-ordered matching, notify, claim (serializable), expire |
  | `gdpr-service` (`GdprService`) | `gdpr-service.ts` | Subject access export, erasure by anonymisation, erasure verification, consent history |
  | `customer-history-service` (`CustomerHistoryService`) | `customer-history-service.ts` | Stylist-facing profile: notes, colour formulas, stats, preferred staff/service |
  | `review-request-service` (`ReviewRequestService`) | `review-request-service.ts` | Post-visit Google review asks with frequency capping |
  | `voucher-service` (`VoucherService`) | `voucher-service.ts` | Gift-card codes with a checksum alphabet, issuance, redemption, liability reporting |
  | `recurring-service` (`RecurringService`) | `recurring-service.ts` | Standing weekly/N-weekly appointments, materialised by a scheduler |

  See "New capabilities" below for what each one actually does, and `docs/api.md` for
  which of them are reachable through a route today.
- **packages/db**
  Prisma schema and data access with **Cloud SQL for PostgreSQL 16** as the source of
  truth (see "Google Cloud deployment" below — this replaced AlloyDB on 2026-07-29).
- **packages/ai**
  Vertex AI Gemini assistant with function calling; regex fallback for local dev.
- **packages/gcp**
  GCP client integrations: Vertex AI, Dialogflow CX, Cloud STT/TTS, Identity Platform,
  Pub/Sub, Cloud Tasks.
- **packages/i18n**
  Locale constants, dictionary lookup, locale routing helpers.
- **packages/ui**
  Shared design-system components.

## 2) Layering

`Route handler (API) → Service (business rules) → Repository (Prisma queries) → PostgreSQL (Cloud SQL)`

Business rules stay outside UI components and are reusable across channels (web/admin/chat/voice).
`"use client"` components never import the `@hair-simo/core` barrel — it pulls in Prisma
and every server-only dependency behind it and would break the client bundle. The one
subpath that is safe on the client is `@hair-simo/core/time` (see below), which has no
dependency beyond the built-in `Intl` time zone database.

## 3) Salon time: why `packages/core/src/time.ts` is the only sanctioned time API

Business hours and staff availability rules are stored as **minutes-from-midnight
integers** (`BusinessHours.startMin`/`endMin`, `StaffAvailabilityRule.startMin`/`endMin`),
not as timestamps. Turning a minutes-from-midnight value into an actual instant means
picking a time zone, and the tempting way to do that — `date.setHours(Math.floor(min / 60),
min % 60)` — resolves against the **runtime's own** zone. A developer's laptop is usually
`Europe/Rome`, so this looked correct in every manual test. Cloud Run containers run in
`UTC`. The bug this produces is not a crash: every generated slot is silently off by one or
two hours (depending on daylight saving), booking confirmations quote the wrong time, and
nothing in a log line says why, because the arithmetic is "correct" from the container's
point of view.

`packages/core/src/time.ts` exists to make that bug structurally impossible instead of
relying on everyone remembering it:

- `SALON_TIME_ZONE` — resolved once at module load from `SALON_TIME_ZONE` (default
  `Europe/Rome`), validated against the `Intl` time zone database; a bad value fails at
  boot rather than shifting every appointment.
- `zonedMinutesToUtc(day, minutesFromMidnight)` — the one function that turns a salon-local
  wall-clock minute into a UTC instant, with explicit, tested handling of the March
  (nonexistent-hour) and October (ambiguous-hour) DST transitions.
- `salonDayOfWeek`, `startOfSalonDay`, `endOfSalonDay` (exclusive upper bound — use `<`,
  never `<=`), `salonDayKey`/`parseSalonDay` (the `"YYYY-MM-DD"` round trip), and
  `formatInSalonZone`/`formatSalonTimeRange` for every customer-facing and admin-facing
  timestamp.

`Date#setHours`, `Date#getDay` and `Date#toLocaleString` all resolve in the server's zone
and are bugs anywhere in this codebase that touches a salon-facing time. The module has
its own test suite (`time.test.ts`) that flips `process.env.TZ` mid-run specifically to
prove every exported function is immune to the host's zone, and several other modules
(`calendar.ts`, `recurring-service.ts`, `voucher-service.ts`) depend on that guarantee for
their own DST-correctness arguments — re-deriving a wall-clock hour anywhere outside this
module reintroduces the exact bug it was written to eliminate.

## 4) Auth

Two independent signing keys, both resolved by `resolveTokenSecret`/a per-name env lookup
in `packages/core/src/auth-service.ts`:

- **Admin sessions** — `ADMIN_JWT_SECRET`, audience `hair-simo-admin`, 12-hour TTL. Issued
  by `POST /api/auth/login` (Firebase `idToken` in production, local email/password
  fallback in development) and re-validated against the database on **every** request:
  `AuthService.verifyToken` reloads the `User` + role and compares a `tokenVersion` derived
  from `User.updatedAt`, so deactivating a user or changing their role invalidates every
  session they are holding immediately, without a revocation list.
- **Customer appointment links** — `APPOINTMENT_TOKEN_SECRET`, audience
  `hair-simo-appointment`, created by `createAppointmentAccessToken` and verified by
  `verifyAppointmentAccessToken`. The lifetime is derived from the appointment's own
  `startsAt` plus a 48-hour post-visit grace window (clamped between 1 and 45 days), not a
  fixed constant, because a link minted at 23:00 for a 09:00 appointment still has to
  survive the night. Verification is a two-pass check everywhere it is used
  (`/api/appointment/[token]`, `/api/verify/resend`,
  `/api/calendar/appointment/[token]`): once to learn which appointment the token names,
  once again against that row's own `id`/`customerId`, so a token minted for one customer
  can never be replayed against another customer's appointment.

Both secrets fall back to the shared `JWT_SECRET` when unset, with a one-time `console.warn`
— acceptable for local development, a real misconfiguration in production, because it means
an admin session and a customer's booking link are then signed with the same key. A
handful of other features have their own secret with the same fallback behaviour: the
staff calendar feed token (`STAFF_FEED_TOKEN_SECRET`), the waitlist offer token
(`WAITLIST_OFFER_SECRET`), and the review-request click token (`REVIEW_LINK_SECRET`) — see
`docs/operations.md` for the full environment variable table.

Admin authorization is role-based (`owner` > `manager` > `staff`, `ADMIN_ROLE_KEYS` in
`auth-service.ts`) and enforced per route by `adminRoute({ roles: [...] })` in
`apps/admin/lib/admin-api.ts`, which is also what writes the `AuditLog` row for every
mutating call — see "Admin audit log" below.

## 5) Main runtime flows

### Booking flow
1. Client calls `POST /api/booking`.
2. `BookingService.createBooking` validates the payload (Zod), finds eligible/available
   staff for the requested slot, upserts the customer, and creates the appointment inside
   a serializable transaction that re-checks the conflict window under the row lock it
   takes (`salonRepository.createAppointmentIfAvailable`).
3. A confirmation e-mail and a signed manage-link (`APPOINTMENT_TOKEN_SECRET`) are sent as
   best-effort post-commit side effects — their failure is logged and reported in the
   response payload, never turned into an error, because the appointment already exists.
4. The response returns the normalized appointment payload plus `manageUrl` and
   `confirmation.status`.

### Availability flow
1. Client calls `GET /api/availability?serviceSlug=...&day=...`.
2. `BookingService` loads business hours, staff availability rules, staff time-off and
   blocked appointments for that **salon day** (via `time.ts`, not the server's day) in one
   batch, then computes slots per eligible staff member.
3. Returns the merged, deduplicated set of bookable start times.

### Payment flow (Google Pay)
1. Client calls `POST /api/payments/checkout`.
2. `PricingService` computes the deposit/full amount from the appointment's own service
   row — never from a client-supplied price or percentage.
3. `PaymentService` creates a local payment record and returns a Google Pay
   `paymentDataRequest`.
4. The client completes the Google Pay flow; the PSP calls back to
   `POST /api/payments/webhook`, which verifies an HMAC body signature (see `docs/api.md`)
   before parsing anything, then confirms the payment.

### Chat flow (Vertex AI Gemini)
1. An incoming message reaches a channel endpoint (`/api/chat/web`, `/api/chat/sms`,
   `/api/chat/whatsapp`).
2. `packages/ai`'s `runAssistant()` invokes Vertex AI Gemini with function declarations.
3. Gemini selects tools (booking lookups, availability, etc.); results are synthesised into
   a natural-language reply in the detected locale.
4. Falls back to a regex intent parser when `GCP_PROJECT_ID` is unset (local dev).

### Voice flow (Dialogflow CX + Chirp)
1. A caller dials the Phone Gateway number connected to a Dialogflow CX agent.
2. Dialogflow CX sends a webhook to `/api/voice/dialogflow`, authenticated by
   `x-dialogflow-webhook-secret` against `GCP_DIALOGFLOW_WEBHOOK_SECRET`.
3. The same Gemini assistant tooling processes the intent.
4. The response is synthesised via Cloud Text-to-Speech (Chirp 3 HD voices) and a `CallLog`
   row is written for audit; a low-confidence utterance is answered with a fixed
   human-handover message instead of a synthesised guess.

### Notification flow
1. `POST /api/cron/reminders` (Cloud Scheduler, hourly) dispatches due reminders through
   `NotificationService`, which claims each appointment/template pair inside a serializable
   transaction before sending, so two overlapping cron runs cannot both send the same
   reminder.
2. E-mail goes via the Gmail API (`GCP_GMAIL_SENDER`); SMS/WhatsApp are published to
   Pub/Sub for a partner integration to pick up — **the publish is where this platform's
   own responsibility ends today; see "Known gaps".**
3. Delivery status (`sent`/`simulated`/`scheduled`/`failed`/`skipped`) is recorded on
   `NotificationLog`, and `simulated` (nothing left the process, used outside production)
   is deliberately never confused with `sent`.

### No-show protection: deposit threshold + double opt-in
1. `evaluateNoShowPolicy` (`packages/core/src/no-show-policy.ts`) is the single authority
   on the rule: a service priced at or above `NO_SHOW_DEPOSIT_THRESHOLD_CENTS` (default
   EUR 50) requires a deposit (`NO_SHOW_DEPOSIT_PERCENTAGE`, default 30%) and a no-show fee
   capped at the deposit itself; everything below the threshold requires no deposit but
   instead a double opt-in e-mail confirmation, because a web form can be filled with
   `nobody@example.com` and phone/WhatsApp bookings cannot.
2. `booking-verification-service.ts` issues a single-use, hashed token
   (`BookingVerification.tokenHash`, SHA-256 of a 256-bit random value — the raw token is
   never persisted), redeemed by `GET /api/verify/[token]` and (re-)issued by
   `POST /api/verify/resend`. The deadline is the shorter of "24 hours from now" and "2
   hours before the appointment", with a 30-minute floor.
3. `POST /api/cron/sweep` releases bookings whose link lapsed
   (`expireUnverifiedBefore`) and bookings that never got a verification row at all
   (`releaseOrphanedUnverified`).
4. **As of 2026-07-29**, steps 2 and 3 are reachable by route and covered by tests, but
   nothing in `POST /api/booking` calls `evaluateNoShowPolicy` or issues the first
   verification link automatically yet — every appointment is still created with the
   Prisma column defaults (`depositRequired: true`, `noShowFeeCents: 0`). Wiring the
   decision into booking creation is in progress in the same parallel workstream that added
   the routes above; verify against `packages/core/src/booking-service.ts` before relying
   on this being connected end to end.

### Waitlist
1. `POST /api/waitlist` (unauthenticated, named by service slug + customer e-mail, exactly
   like `/api/booking`) queues a customer for a time window via `WaitlistService.join`,
   which is idempotent for an overlapping open entry and capped at
   `MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER` (5).
2. When a slot frees up, `WaitlistService.findMatches`/`notifyMatches` offers it to up to
   three people at once in strict first-come-first-served order, each with a token bound to
   `(entry, slot, notifiedAt)` worth exactly one attempt.
3. `GET`/`POST /api/waitlist/[token]` reads the offer state and claims it;
   `WaitlistService.claim` runs the claim inside a serializable transaction that reads the
   same conflict predicate the normal booking flow does, so a waitlist claim and a walk-in
   web booking for the same slot can never both win.
4. `WaitlistService.expire` is the housekeeping sweep (lapsed offers back to `active`,
   past-window entries to `expired`, entries for GDPR-erased customers to `cancelled`) —
   **not yet wired into `/api/cron/sweep`**, see "Known gaps".
5. Admin: `GET /api/waitlist` (list, fairness order) and
   `PATCH`/`DELETE /api/waitlist/[id]` (cancel/expire one entry; a converted entry is
   permanent).

### Vouchers
1. Codes are generated (never chosen) from a 23-character alphabet deliberately missing
   every character pair that is confusable by handwriting or by phone in German/Italian
   (`VOUCHER_CODE_ALPHABET`), with a weighted checksum character that provably catches every
   single-character typo and adjacent transposition.
2. `VoucherService.redeem` spends a balance with one conditional `UPDATE`
   (`remainingCents = remainingCents - n WHERE remainingCents >= n`) inside a serializable
   transaction — never a read-then-write — so two concurrent redemptions cannot overdraw a
   voucher, and is idempotent per `(voucherId, appointmentId | paymentId)` so a retried
   request cannot spend twice.
3. `GET /api/vouchers/balance` is the public bearer-code balance lookup (throttled under
   its own rate-limit namespace, malformed/unknown codes indistinguishable). Admin:
   `GET`/`POST /api/vouchers` (list, `?view=liability` outstanding-balance report, issue —
   only `owner` may override the minimum validity floor).
4. **Redeeming a voucher against a live checkout is not wired into
   `POST /api/payments/checkout` yet** — the service and its admin-facing issuance/lookup
   routes exist; the customer-facing "pay with this voucher" step does not.

### Recurring series
`RecurringService.materialiseDue` is a scheduler: it walks every active series whose
`nextAt` falls inside a rolling 56-day horizon, books the next occurrence (same salon
weekday and wall-clock time, tolerant of a staff conflict by shifting up to two hours on
the *same* day, never onto another day), and advances the cursor in the same serializable
transaction that does the booking, so a crashed or duplicated cron run cannot double-book
or skip an occurrence. **Not yet reachable by any route or cron entry as of 2026-07-29** —
see "Known gaps".

### Review requests
`ReviewRequestService.scheduleForCompleted`/`dispatchDue` asks a customer for a Google
review a fixed delay after a completed appointment, gated by marketing consent (the AND of
the `Customer.marketingOptIn` flag and the newest `ConsentRecord` of the relevant type — a
stale flag can never override a withdrawal), a lifetime cap of 3 asks, and cooldowns after
both a send and a click. **Not yet reachable by any route or cron entry as of
2026-07-29** — see "Known gaps".

### GDPR export and erasure
`GdprService.exportCustomerData` assembles a complete, machine-readable Art. 15/20 export
by walking every relation the schema attaches to a customer with id-scoped queries (never a
filter that could widen beyond the one subject). `GdprService.eraseCustomerData` anonymises
rather than deletes — see "GDPR erasure by anonymisation, not deletion" in
`docs/decisions.md` for why — and `verifyErasure` re-scans the database for the destroyed
identifiers to prove the erasure actually took. **Not yet reachable by any admin route as
of 2026-07-29** — see "Known gaps".

### Customer history
`CustomerHistoryService.getCustomerProfile` is the stylist-facing "what do we know about
this hair" view: pinned notes, allergies (always pinned, regardless of what the caller
asked for — a colleague forgetting to pin an allergy note must not hide it), colour-formula
history (stored as a JSON envelope inside a `formula`-kind `CustomerNote`, see the
docstring on `serializeFormula` for the tradeoff of not adding a dedicated column), derived
preferred staff/service, and lifetime-value stats. **Not yet reachable by any admin route
as of 2026-07-29** — `apps/admin/app/api/customers/[id]/route.ts` still writes notes
through the older, plainer `salonRepository.addCustomerNote` rather than this service. See
"Known gaps".

### Admin audit log
Every mutating `adminRoute` call writes an `AuditLog` row (`actorId`, `actorEmail`,
`actorRole`, `action`, `entityType`/`entityId`, redacted `before`/`after` JSON, `ip`,
`userAgent`) via `salonRepository.createAuditLog`, and a failed audit write is logged loudly
rather than silently swallowed or allowed to roll back the mutation it describes.
Redaction (`redactForAudit`) strips any key that looks like a password, token, secret,
credential, card number or IBAN before the row is ever written. This is the one new
capability that is fully wired end to end today — it needs no separate route because it
piggybacks on every existing admin mutation. The five legacy `/api/staff/[id]/**` routes
that call `requireSession` directly instead of `adminRoute` (see `docs/api.md`) are the one
gap: those mutations are not audited.

## 6) Multi-language strategy

- URL-based locale prefixes: `/de`, `/it`, `/fr`, `/en`
- Fallback locale: `en`
- Dictionaries in `packages/i18n`
- `hreflang` alternate hints in locale metadata
- Chirp 3 HD voices per locale (de-DE, it-IT, fr-FR, en-US)
- Gemini system prompts per locale in `packages/i18n`
- Display formatting for every locale always goes through `formatInSalonZone`/
  `formatSalonTimeRange` (section 3) — never `Date#toLocaleString`

## 7) Google Cloud deployment

| Component | GCP Service |
|-----------|-------------|
| Web + Admin apps | Cloud Run (`europe-west8`, Milan) |
| Database | Cloud SQL for PostgreSQL 16, private IP only (`europe-west8`) |
| Admin auth | Identity Platform (Firebase Admin SDK) |
| Chat AI | Vertex AI Gemini 2.5 Flash (`europe-west1`, Belgium — model availability, not Cloud Run region, decides this) |
| Voice telephony | Dialogflow CX + Phone Gateway |
| Speech recognition | Cloud Speech-to-Text (Chirp model) |
| Voice synthesis | Cloud Text-to-Speech (Chirp 3 HD) |
| Async messaging | Pub/Sub + Cloud Tasks (dead-letter topic) |
| Scheduled jobs | Cloud Scheduler (reminders, verification sweep) |
| Secrets | Secret Manager |
| WAF + rate limiting | Cloud Armor (Standard tier — Adaptive Protection deliberately off, see `docs/decisions.md`) |
| CDN | Cloud CDN (static assets and media) |
| Container registry | Artifact Registry |
| Infrastructure | Terraform (`infra/terraform/`) |

`europe-west8` was chosen over the previous `europe-west6` (Zurich) and Cloud SQL over the
previous AlloyDB — both reversed on 2026-07-29, see `docs/decisions.md`. See
`infra/terraform/README.md` for deployment instructions and the full cost breakdown.

## 8) Known gaps

Stated plainly rather than left for someone to discover in production:

- **No multi-tenancy.** There is no `tenantId` anywhere in
  `packages/db/prisma/schema.prisma` or in any query in `packages/core`. One deployment
  serves exactly one salon. Onboarding a second salon today means a second deployment, not
  a new row.
- **No Pub/Sub consumer.** `packages/gcp/src/pubsub.ts` publishes SMS/WhatsApp
  notification events and `NotificationService` reports them as `sent` as soon as the
  publish call itself succeeds — but nothing in this repository subscribes to that topic.
  There is no worker, no push endpoint, and no partner integration wired up, so an SMS or
  WhatsApp notification is published and then goes nowhere. Only Gmail (the `web` channel)
  and Cloud Tasks-scheduled delivery are actually connected end to end.
- **`eslint-config-next` is inert.** It is a listed `devDependency` (`^16.0.0`) but the
  root `.eslintrc.cjs` extends only `eslint:recommended` and
  `plugin:@typescript-eslint/recommended` — nothing in the repository extends
  `eslint-config-next` or `next/core-web-vitals`, and neither `apps/web` nor `apps/admin`
  has an eslint config of its own. `eslint-config-next@16` also requires `eslint >=9.0.0`
  while the repo pins `eslint@^8.57.1`, so it could not be activated as-is even if
  something did extend it. The practical effect: no Next.js-specific rule, no
  accessibility (`jsx-a11y`) rule, and no `react-hooks` rule runs today. `pnpm lint` only
  ever ran the generic TypeScript rules.
- **The new feature services are ahead of their routes.** As detailed in section 5, five of
  the nine services added to `packages/core` (recurring series, review requests, GDPR
  export/erasure, customer history, and full waitlist/voucher housekeeping) are
  implemented and tested but not yet fully reachable through `apps/web`/`apps/admin` routes
  or scheduled jobs. This is expected to close as the parallel route-adding workstream
  continues; re-verify against `docs/api.md`'s dated snapshot before assuming otherwise.
- **The rate-limit store is per-instance and in-memory.** See `docs/api.md` — a
  Postgres-backed store is a named seam, not yet implemented.
