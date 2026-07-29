import { BookingService, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import {
  adminRoute,
  paginated,
  paginationShape,
  recordStatusHistoryActor,
} from "../../../lib/admin-api";

const bookingService = new BookingService();

const statusSchema = z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]);

const listQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.string().trim().max(200).optional(),
    staffId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    serviceId: z.string().trim().min(1).optional(),
    query: z.string().trim().max(200).optional(),
    ...paginationShape,
  })
  .strict();

/** The booking service owns the field-level schema; the wrapper only asserts an object. */
const createBodySchema = z.record(z.string(), z.unknown());

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/appointments", query: listQuerySchema },
  async ({ query }) => {
    const statuses = query.status
      ? query.status
          .split(",")
          .filter(Boolean)
          .map((status) => statusSchema.parse(status))
      : undefined;
    const appointments = await salonRepository.listAppointments({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      statuses,
      staffId: query.staffId,
      customerId: query.customerId,
      serviceId: query.serviceId,
      query: query.query,
      skip: query.offset,
      take: query.limit,
    });
    return paginated(appointments, query);
  },
);

export const POST = adminRoute(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/appointments",
    schema: createBodySchema,
    successStatus: 201,
    audit: { entityType: "appointment", action: "appointment.create" },
  },
  async ({ body, session, audit, log }) => {
    const appointment = await bookingService.createBooking(body);
    await recordStatusHistoryActor(appointment.id, session, log);
    audit.setEntityId(appointment.id);
    audit.setAfter({
      id: appointment.id,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      customerId: appointment.customerId,
      serviceId: appointment.serviceId,
      staffId: appointment.staffId,
    });
    return { data: appointment };
  },
);
