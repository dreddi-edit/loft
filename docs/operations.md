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

## 4) Payment operations

1. Call `POST /api/payments/checkout`
2. Confirm payment client-side with Stripe using `clientSecret`
3. Stripe webhook updates payment statuses

Refund basis:
- `Refund` model exists and is ready for explicit refund endpoint implementation.

## 5) Chat channel activation

Set environment variables:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_SMS_FROM`

Configure Twilio webhooks:
- WhatsApp: `/api/chat/whatsapp`
- SMS: `/api/chat/sms`

## 6) Voice activation

Configure Twilio voice webhook:
- `/api/voice/twilio`

Behavior:
- detects language (de/it/fr/en)
- infers intent (book/reschedule/cancel/FAQ)
- stores `CallLog`
- fallback for uncertain input

## 7) Admin access in MVP

MVP uses JWT session cookies and role checks on admin APIs.
