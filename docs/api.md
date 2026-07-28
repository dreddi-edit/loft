# API Reference (MVP)

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

## Payments (Stripe)

### `POST /api/payments/checkout`
Creates Stripe PaymentIntent and local payment record.

```json
{
  "appointmentId": "apt_id",
  "serviceSlug": "haircut-women",
  "mode": "deposit",
  "depositPercentage": 30
}
```

### `POST /api/payments/webhook`
Stripe webhook endpoint (`payment_intent.succeeded` and `payment_intent.payment_failed` handled).

## Notifications

### `POST /api/notifications/reminder`
Creates reminder log records used by anti-no-show automations.

## AI chat channels

### `POST /api/chat/web`
JSON chatbot API endpoint with tool-based intents.

### `POST /api/chat/whatsapp`
Twilio-compatible webhook endpoint for WhatsApp.

### `POST /api/chat/sms`
Twilio-compatible webhook endpoint for SMS.

## Voice

### `POST /api/voice/twilio`
Twilio voice webhook endpoint (language detection, intent handling, call log persistence, fallback support).

## Admin APIs (JWT protected)

Authenticate via `POST /api/auth/login` (sets `admin_token` cookie).

- `GET /api/dashboard`
- `GET /api/services`
- `POST /api/services`
- `PATCH /api/services/{id}`
- `GET /api/staff`
- `GET /api/customers`
- `POST /api/customers`
- `PATCH /api/customers/{id}`
- `GET /api/appointments`
- `POST /api/appointments`
- `POST /api/appointments/{id}/reschedule`
- `POST /api/appointments/{id}/cancel`
- `GET /api/business-hours`
- `PUT /api/business-hours`

## Refunds

### `POST /api/payments/refund`

Error format:
```json
{
  "error": "ERROR_CODE",
  "message": "Optional details"
}
```
