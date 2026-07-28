# Hair Simo System Architecture

## 1) High-level modules

- **apps/web**  
  Public SEO website, booking UI, customer self-service flows, and GCP webhook handlers.
- **apps/admin**  
  Operational backoffice for owner/manager/staff with Identity Platform authentication.
- **packages/core**  
  Domain logic and service orchestration (`BookingService`, `PricingService`, `AuthService`, `NotificationService`, `PaymentService`, `RefundService`).
- **packages/db**  
  Prisma schema and data access with PostgreSQL/AlloyDB as source of truth.
- **packages/ai**  
  Vertex AI Gemini assistant with function calling; regex fallback for local dev.
- **packages/gcp**  
  GCP client integrations: Vertex AI, Dialogflow CX, Cloud STT/TTS, Identity Platform, Pub/Sub, Cloud Tasks.
- **packages/i18n**  
  Locale constants, dictionary lookup, locale routing helpers.

## 2) Layering

`Route handler (API) → Service (business rules) → Repository (Prisma queries) → PostgreSQL/AlloyDB`

Business rules stay outside UI components and are reusable across channels (web/admin/chat/voice).

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

### Payment flow (Google Pay)
1. Client calls `POST /api/payments/checkout`
2. `PricingService` computes deposit/full amount
3. `PaymentService` creates local payment record and returns Google Pay `paymentDataRequest`
4. Client completes Google Pay flow; PSP webhook calls `/api/payments/webhook`
5. Payment status updated to `paid`

### Chat flow (Vertex AI Gemini)
1. Incoming message reaches channel endpoint (`/api/chat/web`, `/api/chat/sms`, `/api/chat/whatsapp`)
2. `packages/ai` `runAssistant()` invokes Vertex AI Gemini 2.5 with function declarations
3. Gemini selects tools (`createBooking`, `rescheduleBooking`, etc.)
4. Tool results synthesized into natural language response in detected locale
5. Falls back to regex intent parser when `GCP_PROJECT_ID` is not set (local dev)

### Voice flow (Dialogflow CX + Chirp)
1. Caller dials Phone Gateway number connected to Dialogflow CX agent
2. Dialogflow CX sends webhook to `/api/voice/dialogflow`
3. Same Gemini assistant tooling processes intent
4. Response synthesized via Cloud Text-to-Speech (Chirp 3 HD voices)
5. `CallLog` saved for audit/fallback handover
6. Low-confidence utterances trigger human callback workflow via Pub/Sub

### Notification flow
1. Reminder scheduled via Cloud Scheduler or inline
2. `NotificationService` publishes to Pub/Sub topic
3. Cloud Tasks dispatches to `/api/tasks/notification`
4. Email sent via Gmail API; SMS/WhatsApp via Pub/Sub worker integration

## 4) Multi-language strategy

- URL-based locale prefixes: `/de`, `/it`, `/fr`, `/en`
- Fallback locale: `en`
- Dictionaries in `packages/i18n`
- `hreflang` alternate hints in locale metadata
- Chirp 3 HD voices per locale (de-DE, it-IT, fr-FR, en-US)
- Gemini system prompts per locale in `packages/i18n`

## 5) Google Cloud deployment

| Component | GCP Service |
|-----------|-------------|
| Web + Admin apps | Cloud Run |
| Database | AlloyDB for PostgreSQL |
| Admin auth | Identity Platform (Firebase Admin SDK) |
| Chat AI | Vertex AI Gemini 2.5 Flash |
| Voice telephony | Dialogflow CX + Phone Gateway |
| Speech recognition | Cloud Speech-to-Text (Chirp model) |
| Voice synthesis | Cloud Text-to-Speech (Chirp 3 HD) |
| Async messaging | Pub/Sub + Cloud Tasks |
| Scheduled jobs | Cloud Scheduler |
| Secrets | Secret Manager |
| WAF + rate limiting | Cloud Armor |
| Container registry | Artifact Registry |
| Infrastructure | Terraform (`infra/terraform/`) |

See `infra/terraform/README.md` for deployment instructions.
