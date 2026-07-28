# Operations Guide

## 1) Service management

Services are stored in:
- `Service`
- `ServiceTranslation`

Operational steps:
1. Add or update base service (`slug`, duration, price, buffer)
2. Add translations for `de/it/fr/en`
3. Link service with staff via `StaffService`

## 2) Staff and schedule management

Key entities:
- `StaffProfile`
- `StaffAvailabilityRule`
- `StaffTimeOff`
- `BusinessHours`

Steps:
1. Create `User` + `StaffProfile`
2. Assign role (`owner`, `manager`, `staff`) via `UserRole`
3. Define default weekly windows in `StaffAvailabilityRule`
4. Add planned absences in `StaffTimeOff`

## 3) Booking operations

Flows:
- create: `POST /api/booking`
- reschedule: `POST /api/booking/{id}/reschedule`
- cancel: `POST /api/booking/{id}/cancel`

Status audit trail is persisted in `AppointmentStatusHistory`.

## 4) Payment operations (Google Pay)

1. Call `POST /api/payments/checkout` — returns `googlePayRequest`
2. Client renders Google Pay button and completes payment
3. PSP sends confirmation to `POST /api/payments/webhook`
4. Payment status updated to `paid`

Configure in Secret Manager:
- `GCP_GOOGLE_PAY_MERCHANT_ID`
- `GCP_PAYMENT_GATEWAY` / `GCP_PAYMENT_GATEWAY_MERCHANT_ID`
- `GCP_PAYMENT_WEBHOOK_SECRET`

## 5) Chat channel activation

Set environment variables:
- `GCP_PROJECT_ID`
- `GCP_VERTEX_LOCATION`
- `GCP_GEMINI_MODEL`

Configure webhooks:
- Web chat: built into booking site (`/api/chat/web`)
- WhatsApp/SMS: route partner webhooks to `/api/chat/whatsapp` or `/api/chat/sms`

## 6) Voice activation (Dialogflow CX)

1. Create Dialogflow CX agent in `GCP_DIALOGFLOW_LOCATION`
2. Configure Phone Gateway with Swiss number
3. Set webhook URL: `https://<web-domain>/api/voice/dialogflow`
4. Enable Cloud Speech-to-Text (Chirp) and Text-to-Speech (Chirp 3 HD)

Chirp 3 HD voice mapping:
- German: `de-DE-Chirp3-HD-Charon`
- Italian: `it-IT-Chirp3-HD-Charon`
- French: `fr-FR-Chirp3-HD-Charon`
- English: `en-US-Chirp3-HD-Charon`

Behavior:
- Gemini processes intent with function calling
- Chirp 3 HD synthesizes response audio
- `CallLog` stored for audit
- Low-confidence utterances trigger human callback via Pub/Sub

## 7) Admin access

Production: Identity Platform
1. Enable Identity Platform in GCP console
2. Set `GCP_IDENTITY_PLATFORM_ENABLED=true`
3. Create users matching seed emails with appropriate custom claims (`role`)
4. Admin login accepts Firebase `idToken`

Local dev: JWT fallback
- Seed users with password `HairSimo2026!`
- Set `JWT_SECRET` in `.env`

## 8) Notifications

Reminder pipeline:
1. Cloud Scheduler triggers `/api/notifications/reminder` hourly
2. Events published to Pub/Sub topic `hair-simo-notifications`
3. Cloud Tasks dispatches to `/api/tasks/notification`
4. Email via Gmail API (`GCP_GMAIL_SENDER`)

## 9) Infrastructure deployment

```bash
cd infra/terraform
terraform init && terraform apply
```

See `infra/terraform/README.md` for full deployment guide.

## 10) Rate limiting

Production: Cloud Armor policy on load balancer (100 req/min per IP, ban 5 min on exceed).
Development: in-memory rate limit in API routes.
