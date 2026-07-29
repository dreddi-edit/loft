import { BookingService, parseSalonDay, startOfSalonDay } from "@hair-simo/core";
import { z } from "zod";
import { HttpError } from "../../../lib/api-errors";
import { apiRoute } from "../../../lib/api-handler";
import { withDomainErrors } from "../_lib/domain-errors";

const bookingService = new BookingService();

const MS_PER_DAY = 86_400_000;

/**
 * Mirrors MAX_BOOKING_HORIZON_DAYS in packages/core/src/booking-service.ts, which is not
 * re-exported from the package root yet (see coreExports). Each eligible staff member
 * costs about four queries per request, so an unbounded `day` is a cheap way to make the
 * database work hard for a date nobody could book anyway.
 */
const AVAILABILITY_HORIZON_DAYS = 180;

const querySchema = z.object({
  serviceSlug: z.string().trim().min(1).max(100),
  day: z.iso.date(),
  staffId: z.string().trim().min(1).max(64).optional(),
});

function assertDayInRange(day: string): void {
  const requested = parseSalonDay(day);
  const today = startOfSalonDay(new Date());
  if (requested.getTime() < today.getTime()) {
    throw new HttpError("VALIDATION_ERROR", {
      message: "The requested day is in the past.",
      logMessage: `availability requested for past day ${day}`,
    });
  }
  if (requested.getTime() > today.getTime() + AVAILABILITY_HORIZON_DAYS * MS_PER_DAY) {
    throw new HttpError("VALIDATION_ERROR", {
      message: `The calendar is only open ${AVAILABILITY_HORIZON_DAYS} days ahead.`,
      logMessage: `availability requested beyond horizon for ${day}`,
    });
  }
}

export const GET = apiRoute<unknown, z.infer<typeof querySchema>>(
  {
    route: "/api/availability",
    methods: ["GET"],
    policy: "availability",
    query: querySchema,
  },
  async ({ query }) => {
    assertDayInRange(query.day);
    const slots = await withDomainErrors(() =>
      bookingService.getAvailability(query.serviceSlug, query.day, query.staffId),
    );
    return { data: slots };
  },
);
