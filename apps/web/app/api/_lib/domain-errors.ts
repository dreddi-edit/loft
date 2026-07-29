import { HttpError, type ErrorCode } from "../../../lib/api-errors";

type DomainMapping = { code: ErrorCode; message: string };

/**
 * Plain error strings thrown by BookingService that the api-errors alias table does not
 * know yet. Without this mapping they normalise to INTERNAL, so a customer who picks a
 * slot inside the two hour lead time gets a 500 instead of being told why it was refused.
 */
const DOMAIN_ERRORS: Record<string, DomainMapping> = {
  INVALID_DAY: {
    code: "VALIDATION_ERROR",
    message: "The requested day is not a valid salon day.",
  },
  INVALID_START: {
    code: "VALIDATION_ERROR",
    message: "The requested start time is not a valid instant.",
  },
  BOOKING_TOO_SOON: {
    code: "SLOT_NOT_AVAILABLE",
    message: "This time is too close to now to be booked online. Please call the salon.",
  },
  BOOKING_TOO_FAR_AHEAD: {
    code: "SLOT_NOT_AVAILABLE",
    message: "The calendar is not open that far ahead yet.",
  },
  APPOINTMENT_TOKEN_BINDING_MISMATCH: {
    code: "UNAUTHORIZED",
    message: "This appointment link is not valid for this appointment.",
  },
};

export function translateDomainError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return error;
  const mapping = DOMAIN_ERRORS[error.message];
  if (!mapping) return error;
  return new HttpError(mapping.code, {
    message: mapping.message,
    cause: error,
    logMessage: error.message,
  });
}

/** Runs `work` and rethrows known domain failures as their HTTP equivalent. */
export async function withDomainErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateDomainError(error);
  }
}
