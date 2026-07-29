export type Money = { amountCents: number; currency: "EUR" };

export type Slot = { startsAt: Date; endsAt: Date };

export function calculateDeposit(total: Money, percentage: number): Money {
  const safePercentage = Math.min(100, Math.max(0, percentage));
  return {
    amountCents: Math.round((total.amountCents * safePercentage) / 100),
    currency: total.currency,
  };
}

export function calculateTotalPrice(basePriceCents: number, addonsCents: number[] = []): Money {
  const amountCents = addonsCents.reduce((sum, value) => sum + value, basePriceCents);
  return { amountCents, currency: "EUR" };
}

export {
  ADMIN_ROLE_KEYS,
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_TYPE,
  AuthService,
  TOKEN_ISSUER,
  assertRole as assertAuthRole,
  hashPassword,
  resolveTokenSecret,
  timingSafeStringEqual,
  verifyAdminSessionToken,
  verifyPassword,
  type AdminTokenClaims,
  type AuthSession,
  type TokenSecretName,
} from "./auth-service";
export { BookingService } from "./booking-service";
export { NotificationService } from "./notification-service";
export { PaymentService } from "./payment-service";
export { PricingService } from "./pricing-service";
export { RefundService } from "./refund-service";
export { ReminderService } from "./reminder-service";
export {
  APPOINTMENT_TOKEN_AUDIENCE,
  APPOINTMENT_TOKEN_TYPE,
  createAppointmentAccessToken,
  verifyAppointmentAccessToken,
  type AppointmentAccessClaims,
  type AppointmentAccessTokenInput,
} from "./appointment-token";
export { salonRepository } from "./repositories";
export {
  SALON_TIME_ZONE,
  endOfSalonDay,
  formatInSalonZone,
  formatSalonTimeRange,
  isValidTimeZone,
  parseSalonDay,
  salonDayKey,
  salonDayOfWeek,
  startOfSalonDay,
  zonedMinutesToUtc,
} from "./time";

export * from "./calendar";
export * from "./no-show-policy";
export * from "./booking-verification-service";
export * from "./waitlist-service";
export * from "./gdpr-service";
export * from "./customer-history-service";
export * from "./review-request-service";
export * from "./voucher-service";
export * from "./recurring-service";
export * from "./data-retention";
export * from "./tenant-resolve";
