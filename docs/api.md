# API Reference

Base URLs:
- Web app API: `https://<web-domain>/api/*`
- Admin app API: `https://<admin-domain>/api/*`

## Public website/data

### `GET /api/services`
Returns active service catalog including translations.

### `GET /api/availability?serviceSlug=<slug>&day=<isoDate>&staffId=<optional>`
Returns computed free slots for a day.

## Booking

### `POST /api/booking`
Creates a booking.

Request (JSON):
```json
{
  "serviceSlug": "haircut-women",
  "startsAt": "2026-08-01T09:00:00.000Z",
  "customerEmail": "maria@example.com",
  "locale": "it",
  "sourceChannel": "web",
  "staffId": "optional-staff-id"
}
```

### `POST /api/booking/{id}/reschedule`
```json
{
  "startsAt": "2026-08-02T10:00:00.000Z"
}
```

### `POST /api/booking/{id}/cancel`
```json
{
  "reason": "cannot attend"
}
```

## Config

### `GET /api/config/public`
Returns runtime flags for the frontend (`gcpEnabled`, `paymentsMockEnabled`, `googlePayConfigured`, `environment`).

## Payments (Google Pay)

### `POST /api/payments/checkout`
Creates payment record and returns Google Pay `paymentDataRequest`.

```json
{
  "appointmentId": "apt_id",
  "serviceSlug": "haircut-women",
  "mode": "deposit",
  "depositPercentage": 30
}
```

Response:
```json
{
  "data": {
    "paymentId": "...",
    "amountCents": 1500,
    "googlePayRequest": { "apiVersion": 2, "...": "..." },
    "provider": "google-pay"
  }
}
```

### `POST /api/payments/confirm-mock`
Dev-only mock payment confirmation. Enabled when `PAYMENTS_MOCK_ENABLED=true` or `NODE_ENV !== production`.

```json
{ "paymentId": "..." }
```

### `POST /api/payments/webhook`
PSP/Google Pay confirmation webhook. Requires `Authorization: Bearer <GCP_PAYMENT_WEBHOOK_SECRET>`.

```json
{
  "paymentId": "...",
  "status": "succeeded",
  "googlePayToken": "...",
  "providerReference": "..."
}
```

## Notifications

### `POST /api/notifications/reminder`
Creates reminder records and dispatches via Pub/Sub/Cloud Tasks.

### `POST /api/tasks/notification`
Cloud Tasks handler for async notification delivery. Requires `Authorization: Bearer <GCP_CLOUD_TASKS_SECRET>`.

## AI chat channels (Vertex AI Gemini)

### `POST /api/chat/web`
JSON chatbot endpoint with Gemini function calling.

```json
{
  "text": "I want to book a haircut tomorrow",
  "locale": "en",
  "conversationHistory": []
}
```

### `POST /api/chat/whatsapp`
JSON webhook for WhatsApp Business integration via Pub/Sub worker.

### `POST /api/chat/sms`
JSON webhook for SMS integration via Pub/Sub worker.

## Voice (Dialogflow CX + Chirp)

### `POST /api/voice/simulate`
Local voice simulator (text in → AI response out, optional Chirp audio with GCP).

```json
{ "text": "I want to book a haircut", "locale": "en" }
```

### `POST /api/voice/dialogflow`
Dialogflow CX webhook fulfillment endpoint. Processes utterances, runs Gemini tooling, synthesizes Chirp 3 HD audio.

### `POST /api/voice/synthesize`
Direct Cloud Text-to-Speech endpoint.

```json
{
  "text": "Welcome to Hair Simo",
  "locale": "de"
}
```

### `POST /api/voice/transcribe`
Direct Cloud Speech-to-Text endpoint. Accepts multipart `audio` file.

## Admin APIs (Identity Platform / JWT protected)

Authenticate via:
- `POST /api/auth/login` with Firebase `idToken` (production)
- `POST /api/auth/login` with email/password (local dev fallback)

Protected endpoints:
- `GET /api/dashboard`
- `GET /api/services`, `POST /api/services`, `PATCH /api/services/{id}`
- `GET /api/staff`
- `GET /api/customers`, `POST /api/customers`, `PATCH /api/customers/{id}`
- `GET /api/appointments`, `POST /api/appointments`
- `POST /api/appointments/{id}/reschedule`, `POST /api/appointments/{id}/cancel`
- `GET /api/business-hours`, `PUT /api/business-hours`

## Refunds

### `POST /api/payments/refund`
Dispatches refund request via Pub/Sub to PSP.

Error format:
```json
{
  "error": "ERROR_CODE",
  "message": "Optional details"
}
```
