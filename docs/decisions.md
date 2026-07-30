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
| Database | Local PostgreSQL / Cloud SQL for PostgreSQL 16 | AlloyDB (reversed 2026-07-29 — too expensive for salon volume) |
| Deployment | Docker Compose (local) | Cloud Run + Terraform |

*The Database row above was the call made on 2026-07-28. It was reversed the next day —
see "Cloud SQL over AlloyDB" below, which is the row that actually reflects
`packages/db/prisma/schema.prisma` and `infra/terraform` today.*

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

## 2026-07-29 - Cloud SQL over AlloyDB

AlloyDB was replaced by **Cloud SQL for PostgreSQL 16** as the production database, one day
after the decision above shipped.

AlloyDB is priced and provisioned for analytical/high-throughput workloads — a minimum
node shape, a columnar accelerator nobody here queries, and a price floor that makes sense
for a multi-tenant SaaS backend, not for one four-chair salon in Brixen doing a few hundred
appointment writes a day. Cloud SQL for PostgreSQL 16 gives the same engine, the same
Prisma provider (`provider = "postgresql"` in `packages/db/prisma/schema.prisma` did not
change), private-IP-only connectivity, and automated backups with point-in-time recovery,
at a cost this salon can actually justify. Every `DateTime` column is `@db.Timestamptz(3)`
regardless of which managed Postgres sits underneath, so the switch touched
`infra/terraform` and connection strings, not the schema or the application code.

## 2026-07-29 - Milan over Zurich

`var.region` moved from `europe-west6` (Zurich) to `europe-west8` (Milan). Zurich is one of
the more expensive GCP regions, and despite looking close to Brixen on a map it is further
away than Milan both physically and in network terms — Milan is the nearer major GCP
region to South Tyrol. Every regional resource (Cloud Run, Cloud SQL, Artifact Registry,
Cloud Tasks, Cloud Scheduler, the subnet, the serverless NEGs) follows `var.region` and
moved together.

Vertex AI deliberately did **not** move with it: Gemini model availability is decided per
region on its own list, separate from Cloud Run's, and `europe-west1` (Belgium) is the
closest region that reliably serves `gemini-2.5-flash`. `GCP_VERTEX_LOCATION` therefore
stays `europe-west1` while `GCP_REGION` is `europe-west8`; data stays inside the EU either
way. See `infra/terraform/README.md` for the check to run before collapsing the two.

## 2026-07-29 - ICS calendar feeds instead of a Google Calendar OAuth sync

The owner asked for "the appointments in my calendar app" and the two-way Google Calendar
OAuth sync that phrase usually implies was deliberately rejected in favour of one-way
iCalendar (RFC 5545) generation, built in `packages/core/src/calendar.ts`.

A real OAuth sync is ongoing maintenance a four-person salon cannot carry: refresh tokens
that expire silently, watch-channel renewals that Google caps at **seven days** and that
someone has to remember to re-arm forever, and conflict resolution the day a stylist edits
an event on both sides at once. None of that is a one-time integration cost — it is a
standing operational duty with a silent failure mode (a channel that quietly stops
renewing looks identical to "nothing changed" until a customer is missed).

What ships instead is the boring, durable half of the same feature: an `.ics` attachment on
the confirmation mail (`METHOD:REQUEST`), a matching `METHOD:CANCEL` file so a cancelled
appointment disappears from the calendar it was added to, and a read-only, per-staff
subscribable `VCALENDAR` feed (`/api/calendar/[token]`) that Google Calendar, Apple
Calendar and Outlook all poll on their own schedule. Nothing here holds a credential that
expires and nothing needs a renewal job. The tradeoff, accepted deliberately: a stylist who
edits an event by hand in their own calendar app does not write back to Hair Simo — the
feed is refreshed from the appointment book, not merged with it.

## 2026-07-29 - GDPR erasure by anonymisation, not deletion

`GdprService.eraseCustomerData` anonymises a customer rather than deleting their row or
the appointments and payments attached to it. Three obligations collide here and the
resolution is deliberate, not a shortcut:

- Art. 17 (erasure) requires the personal data to go, and it does: name, email, phone,
  free-text notes, chat transcripts, call summaries and notification payloads are
  overwritten with an irreversible placeholder or a redaction marker inside one
  transaction, verified by re-scanning the database for the destroyed identifiers
  (`GdprService.verifyErasure`).
- Art. 17(3)(b) explicitly preserves processing needed to comply with a legal obligation,
  and Italian law imposes one: **Codice Civile art. 2220** and **DPR 633/1972 art. 39**
  require invoices and accounting entries to be kept for **ten years**. An appointment and
  its payment are the salon's accounting record of a service rendered and money taken, so
  the row has to survive; only the identifiers pointing back at the person do not.
- Art. 7(1) requires the controller to be able to demonstrate consent, so `ConsentRecord`
  rows survive erasure too, with any free-form metadata redacted but the type/granted/
  source/timestamp tuple intact.

The result is a customer that is unreachable and unidentifiable — new random name, cleared
email and phone released for reuse — sitting on top of an appointment and payment history
that the salon's accountant can still audit for ten years. `ErasureReceipt.retained` lists
every data class kept back, its legal basis and its retention period, so an erasure is
never a silent partial deletion.

## 2026-07-29 - Cloud Armor Adaptive Protection left off

Both Cloud Armor policies (`hair-simo-armor` and the admin policy) are **Standard tier**.
Adaptive Protection (`layer_7_ddos_defense_config`), the machine-learning-based Layer 7 DDoS
detection, is deliberately **not** enabled — it requires Cloud Armor Enterprise, billed at
roughly **USD 3,000/month**. That is several times the entire rest of the monthly bill for
a single four-chair salon (see "Cost expectation" in `docs/GO-LIVE.md`), for protection
against an attack profile this site has no reason to expect. The rate-limiting rule at 100
requests per IP per minute stays on the Standard tier and costs nothing extra. Revisit only
if the salon starts fielding a volumetric attack the Standard-tier rule cannot absorb —
not preemptively.
