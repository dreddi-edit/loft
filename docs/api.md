# API Reference

Base URLs:
- Web app API: `https://<web-domain>/api/*`
- Admin app API: `https://<admin-domain>/api/*`

**This route list was enumerated directly from the filesystem** (`find apps/web/app/api
apps/admin/app/api -name route.ts`) **on 2026-07-29.** Two other workflows are adding new
feature routes (waitlist, vouchers, verification, calendar feeds, and their admin
counterparts) in parallel with this document, so treat this as a dated snapshot rather than
a promise — re-run the same `find` before trusting a route that is not listed here, and
before assuming one listed here still has the same shape.

Every unauthenticated route below is wrapped by `apiRoute` (`apps/web/lib/api-handler.ts`),
which assigns a request id, resolves the trusted client IP, applies the named rate-limit
policy, enforces the body-size cap, validates with Zod, and serialises errors through the
taxonomy in "Error responses" below. Every admin route is wrapped by `adminRoute`
(`apps/admin/lib/admin-api.ts`), which additionally requires a session in one of the listed
roles and writes an `AuditLog` row for every mutating call — **except** the five
`/api/staff/[id]/**` routes marked *(legacy)* below, which call `requireSession` directly
and therefore get none of `adminRoute`'s per-operator rate limiting or audit trail. That is
a real inconsistency in the current code, not a documentation simplification.

## Public website/data

### `GET /api/services`
Returns the active service catalog with translations. Policy: `publicRead`.

### `GET /api/staff`
Returns bookable staff (`id`, `displayName` only). Policy: `publicRead`.

### `GET /api/availability?serviceSlug=<slug>&day=<YYYY-MM-DD|isoDate>&staffId=<optional>`
Returns computed free slots for a salon day, bounded to 180 days ahead. Policy:
`availability`. `day` is read as a salon calendar day via `parseSalonDay`, never as a UTC
midnight.

### `GET /api/config/public`
Runtime flags for the frontend: `gcpEnabled`, `identityPlatformEnabled`,
`paymentsMockEnabled`, `googlePayConfigured`, `environment`. Policy: `publicRead`.

### `POST /api/contact`
Sends a contact-form message to `CONTACT_INBOX_EMAIL` (falls back to `info@hairsimo.it`).
Policy: `contact` (3 + 2 burst per hour per client IP — the strictest policy in the table).

## Booking and self-service

### `POST /api/booking`
Creates a booking. Accepts `json` or `form` bodies. Policy: `booking`. Returns `201`.

```json
{
  "serviceSlug": "haircut-women",
  "startsAt": "2026-08-01T09:00:00.000Z",
  "customerEmail": "cliente@example.com",
  "locale": "it",
  "sourceChannel": "web",
  "staffId": "optional-staff-id",
  "termsAccepted": true
}
```

The response embeds a `manageUrl` built from a signed `createAppointmentAccessToken`
(`APPOINTMENT_TOKEN_SECRET`) and a `confirmation` object reporting whether the
confirmation e-mail was actually delivered. A Gmail outage or a missing token secret is
logged and reported in `confirmation.status`, never turned into an error response — the
appointment already exists and returning a failure here would read as "your booking did
not go through" when it did.

### `GET /api/appointment/[token]`
Reads one appointment through its signed manage token. Policy: `availability`.

### `POST /api/appointment/[token]`
Cancels or reschedules the appointment named by the token. Policy: `booking`.

```json
{ "action": "cancel", "reason": "cannot attend" }
```
```json
{ "action": "reschedule", "startsAt": "2026-08-02T10:00:00.000Z" }
```

**This replaces the old, unauthenticated `POST /api/booking/{id}/cancel` and
`POST /api/booking/{id}/reschedule`, which have been deleted.** Anything that still
references those two paths is wrong and describes a security hole: they let anyone who
guessed or enumerated an appointment id cancel or move somebody else's booking. The token
is verified twice — once to learn which appointment it names, once against that
appointment's own `id`/`customerId` — precisely so a token minted for one customer cannot
be replayed against another customer's row.

### `GET /api/verify/[token]` / `HEAD /api/verify/[token]`
Redeems the double opt-in link for a no-deposit booking (see "No-show protection" in
`docs/architecture.md`). Policy: `availability`. Idempotent — a second click answers
`already_confirmed` rather than an error — and defends against mail-scanner prefetching by
recognising `Sec-Purpose`/`Purpose`/`X-Purpose`/`X-Moz` prefetch headers and a
`Sec-Fetch-Dest` other than `empty`, answering those with `pending` instead of redeeming.
Unknown, expired and superseded tokens are indistinguishable (`invalid`), on purpose.

### `POST /api/verify/resend`
Issues (or re-issues) the verification link for the appointment named by an
`APPOINTMENT_TOKEN_SECRET` manage token. Policy: `contact`. Capped at
`MAX_VERIFICATION_SENDS` (3) sends per appointment with a cooldown between sends; both
limits answer `429 RATE_LIMITED` with a body-appropriate `Retry-After` (or none, when the
cap itself — not the cooldown — is what was hit).

## Waitlist

### `POST /api/waitlist`
Unauthenticated join: names the service by slug and the customer by e-mail, exactly like
`/api/booking` — there is no raw `customerId` field, so a caller cannot attach a waitlist
entry to a stranger's record. Policy: `booking`. Accepts `json` or `form`.

```json
{
  "serviceSlug": "balayage-straehnen",
  "earliestAt": "2026-08-04T07:00:00.000Z",
  "latestAt": "2026-08-06T15:00:00.000Z",
  "customerEmail": "cliente@example.com",
  "locale": "de",
  "termsAccepted": true
}
```

The response is deliberately uniform (`{ "status": "queued", ... }`) — it never reports
whether an equivalent entry already existed or which appointments the customer already
holds, because either would turn the endpoint into an oracle for "is this e-mail address
in our system".

### `GET /api/waitlist/[token]`
Reads the state of one offer (`open` / `expired` / `claimed` / `unavailable`) named by a
signed offer token. Policy: `availability`.

### `POST /api/waitlist/[token]`
Claims the offered slot. Policy: `booking`. Losing the race is a normal outcome, not an
error: the response is `200` with `{ "claimed": false, "reason": "SLOT_TAKEN" | ... }`, and
the appointment id of whoever won is never disclosed. On success the response includes a
fresh manage-token URL for the appointment just created.

## Vouchers

### `GET /api/vouchers/balance?code=<voucher-code>`
Customer-facing balance lookup by bearer code. Policy: `contact`, keyed under its own
`voucher-balance` namespace so this endpoint and the contact form do not share one
allowance. Malformed codes and unknown codes answer the identical `404 NOT_FOUND` — "That
is not the shape of a code" and "that code does not exist" must not be distinguishable to a
scanner. The response carries only `remainingCents`, `currency`, `status`, `expiresAt` —
never the code itself, never `initialCents` (the buyer's business), never who it was issued
to.

## Calendar (ICS)

### `GET /api/calendar/[token]` / `HEAD /api/calendar/[token]`
The subscribable, read-only per-staff feed (`text/calendar`), unwrapped from the usual
`{ data }` envelope so calendar clients can consume it directly. Policy: `publicRead`,
keyed by the verified staff id when the token checks out (so one salon's feed cannot
exhaust another's allowance on shared calendar-client infrastructure) and by client IP
otherwise. Supports conditional `If-None-Match` / `If-Modified-Since` and answers `304`
against an ETag computed with the `DTSTAMP` line stripped out, so a poll that changed
nothing does not re-download the whole calendar. Every failure — bad signature, deactivated
staff member — is `404`, never `401`: a calendar subscription cannot answer a challenge.

### `GET /api/calendar/appointment/[token]` / `HEAD /api/calendar/appointment/[token]`
The single-event "add to calendar" file for the confirmation mail, named by the same
`APPOINTMENT_TOKEN_SECRET` manage token as `/api/appointment/[token]`. A cancelled
appointment answers `METHOD:CANCEL` under the same `UID`, so re-opening the link after a
cancellation removes the event from whatever calendar it was added to instead of re-adding
it.

## Config

### `GET /api/config/public`
See "Public website/data" above.

## Payments (Google Pay)

### `POST /api/payments/checkout`
Creates a payment record and returns the Google Pay `paymentDataRequest`. Policy:
`payment`. `serviceSlug` and a client-supplied deposit percentage are accepted from older
clients and silently ignored — the amount is always derived from the appointment's own
service row and the server-side deposit policy, never from the request body.

```json
{ "appointmentId": "apt_id", "mode": "deposit", "tipCents": 500 }
```

### `POST /api/payments/confirm-mock`
Dev-only mock payment confirmation. Answers `404` in production unless
`PAYMENTS_MOCK_ENABLED=true` is explicitly set — the flag is otherwise ignored in
production so a stray environment variable cannot turn real money-less confirmations back
on. Policy: `payment`.

```json
{ "paymentId": "..." }
```

### `POST /api/payments/webhook`
PSP/Google Pay confirmation webhook. Requires both a signed body — HMAC-SHA256 over
`${t}.${rawBody}` keyed with `PAYMENT_WEBHOOK_SIGNING_SECRET`, sent as
`x-payment-signature: t=<unix>,v1=<hex>`, verified before the body is even parsed as JSON —
and the `paymentWebhook` shared secret (`GCP_PAYMENT_WEBHOOK_SECRET`) as
`Authorization: Bearer <secret>`. A signature presented while no signing secret is
configured is refused, not silently accepted. Policy: `payment`.

```json
{
  "paymentId": "...",
  "status": "succeeded",
  "amountCents": 1500,
  "googlePayToken": "...",
  "providerReference": "..."
}
```

## Notifications and scheduled jobs

### `POST /api/cron/reminders`
Dispatches due appointment reminders. Requires the `cron` shared secret (either
`GCP_CLOUD_TASKS_SECRET` or `CRON_SECRET`). Policy: `internal`.

### `POST /api/cron/sweep`
Periodic maintenance run: expires unverified no-deposit bookings whose double opt-in link
lapsed (`expireUnverifiedBefore`) and releases orphaned unverified bookings that never got a
verification row at all (`releaseOrphanedUnverified`). Requires the `cron` shared secret.
Policy: `internal`. Safe to run concurrently with itself — every release is a conditional
`UPDATE` guarded by `status: "pending"` — and answers `200` even when a job fails, so a
partial failure does not make Cloud Scheduler re-run jobs that already succeeded.

As of 2026-07-29 this endpoint only runs the two verification-sweep jobs. Its own source
comment names three more that are not wired in yet: waitlist offer expiry
(`WaitlistService.expire`), review-request dispatch (`ReviewRequestService.dispatchDue`),
and a GDPR retention sweep that has not been written at all. See "Known gaps" in
`docs/architecture.md`.

### `POST /api/tasks/notification`
Cloud Tasks handler for asynchronous notification delivery. Requires the `cloudTasks`
shared secret (`GCP_CLOUD_TASKS_SECRET`). Policy: `internal`.

## AI chat channels (Vertex AI Gemini)

### `POST /api/chat/web`
JSON chatbot endpoint with Gemini function calling. Policy: `chat`.

```json
{ "text": "I want to book a haircut tomorrow", "locale": "en", "conversationHistory": [] }
```

### `POST /api/chat/whatsapp` / `POST /api/chat/sms`
JSON webhooks for the WhatsApp Business and SMS integrations. Policy: `chat`. Both share one
implementation (`chatChannelRoute`) parameterised only by channel name.

## Voice (Dialogflow CX + Chirp)

### `POST /api/voice/simulate`
Local voice simulator (text in, AI response out, optional Chirp audio with GCP connected).
Disabled in production unless `VOICE_SIMULATOR_ENABLED=true` — otherwise it is a paid,
credential-free endpoint anyone could drive. Policy: `voice`.

### `POST /api/voice/dialogflow`
Dialogflow CX webhook fulfilment endpoint. Requires the `x-dialogflow-webhook-secret`
header to match `GCP_DIALOGFLOW_WEBHOOK_SECRET` — verified before anything else runs, so an
unauthenticated caller gets `401` instead of a spoken error with a `CallLog` row behind it.
Policy: `internal` (the caller is Google's infrastructure, not a human, so the per-address
allowance is a blast-radius cap rather than a human rate limit).

### `POST /api/voice/synthesize`
Direct Cloud Text-to-Speech endpoint, capped at 500 characters per call (billed per
character). Policy: `voice`.

### `POST /api/voice/transcribe`
Direct Cloud Speech-to-Text endpoint. Multipart `audio` file, capped at 1 MiB. Policy:
`voice`.

## Admin APIs (session + role protected)

Authenticate via `POST /api/auth/login` — Firebase `idToken` in production, email/password
local-JWT fallback in development — which sets an `admin_token` httpOnly cookie.
`DELETE /api/auth/login` clears it. Login is throttled per IP and per e-mail independently
of the admin rate-limit policies below (`apps/admin/lib/login-throttle.ts`).

Every route needs a session in one of the listed roles. `owner` and `manager` can do
everything `staff` can; the table only calls out where a route is narrower.

| Route | Methods | Roles | Notes |
|---|---|---|---|
| `/api/dashboard` | GET | owner, manager, staff | |
| `/api/services` | GET, POST | GET: all · POST: owner, manager | |
| `/api/services/[id]` | GET, PATCH | GET: all · PATCH: owner, manager | |
| `/api/staff` | GET, POST | GET: all · POST: owner, manager | |
| `/api/staff/[id]` | GET, PATCH, DELETE | GET: all · PATCH/DELETE: owner, manager | *(legacy — `requireSession`, not `adminRoute`)* |
| `/api/staff/[id]/availability` | GET, PUT | GET: all · PUT: owner, manager | *(legacy)* |
| `/api/staff/[id]/services` | GET, PUT | GET: all · PUT: owner, manager | *(legacy)* |
| `/api/staff/[id]/time-off` | GET, POST | GET: all · POST: owner, manager | *(legacy)* |
| `/api/staff/[id]/time-off/[timeOffId]` | PATCH, DELETE | owner, manager | *(legacy)* |
| `/api/business-hours` | GET, PUT | GET: all · PUT: owner, manager | |
| `/api/customers` | GET, POST | all | |
| `/api/customers/[id]` | GET, PATCH | all | `PATCH` can also append a `CustomerNote` |
| `/api/appointments` | GET, POST | all | |
| `/api/appointments/[id]` | GET | all | |
| `/api/appointments/[id]/[action]` | POST | all | `action` ∈ `reschedule, cancel, confirm, no_show, complete` |
| `/api/call-logs` | GET | all | paginated |
| `/api/notifications` | GET | all | paginated |
| `/api/notifications/[id]/retry` | POST | owner, manager | |
| `/api/payments/refund` | POST | owner, manager | policy `adminSensitive` |
| `/api/products` | GET, POST | GET: all · POST: owner, manager | |
| `/api/products/[id]` | GET, PATCH, DELETE | GET: all · PATCH/DELETE: owner, manager | `PATCH`/`DELETE` policy `adminSensitive` |
| `/api/products/[id]/inventory` | GET, POST | GET: all · POST: owner, manager | |
| `/api/reports` | GET | owner, manager | |
| `/api/waitlist` | GET | all | paginated, sorted oldest-first (the fairness queue order) |
| `/api/waitlist/[id]` | PATCH, DELETE | owner, manager | `PATCH { status: "cancelled" \| "expired" }`; a converted entry can never be changed |
| `/api/vouchers` | GET, POST | GET: owner, manager · POST: owner, manager | `?view=liability` returns outstanding balance instead of a list; `POST` policy `adminSensitive`; only `owner` may pass `overrideMinimumValidity` |
| `/api/calendar/feed-url` | GET | all | policy `adminSensitive`; a `staff` session may only ever fetch its own feed URL, not another staff member's |

### Error responses

Both `apps/web/lib/api-errors.ts` and `apps/admin/lib/admin-api.ts` define the identical
error taxonomy independently (not shared code — a deliberate duplication so the admin app
never accidentally imports Prisma-adjacent internals through the web app's error module).
Every error response has this shape:

```json
{
  "error": "SLOT_NOT_AVAILABLE",
  "message": "The selected time slot is no longer available.",
  "requestId": "…",
  "details": [{ "path": "startsAt", "code": "invalid_date", "message": "…" }]
}
```

`message` is always the static, safe copy for the code — never `error.message` from the
thrown exception — so a configuration failure such as `ADMIN_JWT_SECRET_MISSING` can never
leak to a client; it is reported as `INTERNAL` and logged server-side with the real reason
attached to `requestId`.

| Code | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod (or a `.strict()` schema) rejected the request; `details` carries per-field issues |
| `UNAUTHORIZED` | 401 | Missing/invalid session, token, or shared secret |
| `FORBIDDEN` | 403 | Authenticated, but the role or ownership check failed |
| `NOT_FOUND` | 404 | No such record |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method not declared for this route |
| `CONFLICT` | 409 | State conflict — double booking, already-converted waitlist entry, Prisma unique/FK violation (admin) |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeded the route's configured limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Content-Type not accepted by this route |
| `RATE_LIMITED` | 429 | Rate-limit policy exceeded; `Retry-After` set when meaningful |
| `SLOT_NOT_AVAILABLE` | 409 | The requested appointment slot is taken |
| `SERVICE_NOT_FOUND` | 404 | Unknown or inactive service |
| `STAFF_NOT_ELIGIBLE` | 409 | Staff member cannot perform the requested service |
| `APPOINTMENT_NOT_FOUND` | 404 | |
| `PAYMENT_NOT_FOUND` | 404 | |
| `PAYMENT_FAILED` | 402 | Amount/currency mismatch, missing intent, etc. |
| `INSUFFICIENT_STOCK` | 409 | Product inventory movement would go negative |
| `UPSTREAM_UNAVAILABLE` | 503 | A downstream GCP service failed (Vertex AI, Pub/Sub, verification e-mail delivery) |
| `INTERNAL` | 500 | Everything else, including every error string not in the alias table on purpose |

The admin taxonomy additionally maps Prisma error codes directly: `P2002`/`P2003`/`P2014` →
`CONFLICT`, `P2025` → `NOT_FOUND`, `P2034` (serialization failure) → `CONFLICT`. Only the
Prisma code is consulted, never `error.message`, because Prisma puts the offending table,
column and index name in the message and that must stay server-side.

### Rate limit policies

Both apps key rate limits on the trusted client IP — `resolveClientIp` /
`extractClientIp`, counted from the *right-hand end* of `x-forwarded-for` by
`RATE_LIMIT_TRUSTED_HOPS` / `TRUSTED_PROXY_HOPS` hops, never the left-hand end a client can
set to anything. `limit` is the sustained allowance inside `windowMs`; `burst` is extra
headroom in the same window, so the enforced ceiling is `limit + burst`. The store is an
in-memory map (`MemoryRateLimitStore`) **per Cloud Run instance** — with
`max_instance_count` above 1 the effective ceiling multiplies by however many instances are
warm, and every scale-to-zero resets every counter. A Postgres-backed store is a named,
unimplemented seam (`createRateLimitStore("postgres")` throws
`RATE_LIMIT_STORE_NOT_IMPLEMENTED:postgres`) — see "Known gaps" in `docs/architecture.md`.

Web (`apps/web/lib/rate-limit.ts`):

| Policy | Limit | Window | Burst | Ceiling |
|---|---|---|---|---|
| `booking` | 5 | 10 min | 2 | 7 / 10 min |
| `contact` | 3 | 60 min | 2 | 5 / hour |
| `chat` | 15 | 5 min | 5 | 20 / 5 min |
| `voice` | 8 | 5 min | 4 | 12 / 5 min |
| `payment` | 20 | 5 min | 10 | 30 / 5 min |
| `availability` | 60 | 1 min | 30 | 90 / min |
| `publicRead` | 120 | 1 min | 60 | 180 / min |
| `internal` | 60 | 1 min | 30 | 90 / min |

Admin (`apps/admin/lib/admin-api.ts`), sized for four operators sharing one backoffice, not
for a public API:

| Policy | Limit | Window | Burst | Ceiling | Used for |
|---|---|---|---|---|---|
| `adminIp` | 300 | 1 min | 120 | 420 / min | Pre-authentication guard, keyed on IP before the session lookup runs |
| `adminRead` | 240 | 1 min | 60 | 300 / min | Default for GET |
| `adminMutation` | 60 | 1 min | 30 | 90 / min | Default for POST/PUT/PATCH/DELETE |
| `adminSensitive` | 10 | 5 min | 5 | 15 / 5 min | Opt-in per route: voucher issuance, product edits, refunds, calendar feed URLs |

Production rate limiting also runs at the edge via Cloud Armor (100 requests per IP per
minute, both apps) — see `infra/terraform/README.md`. The two layers are independent: Cloud
Armor protects the load balancer regardless of which app-level policy a route declares.
