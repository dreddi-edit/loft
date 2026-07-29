import { BookingService, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError, recordStatusHistoryActor } from "../../../../../lib/admin-api";

const bookingService = new BookingService();

const actionSchema = z.enum(["reschedule", "cancel", "confirm", "no_show", "complete"]);

/**
 * One tolerant body for all five actions. The calendar and the appointment drawer post the
 * same payload whichever button was pressed, so rejecting an unused `reason` or `startsAt`
 * would break the buttons rather than protect anything: only the fields the chosen action
 * needs are ever read.
 */
const actionBodySchema = z
  .object({
    startsAt: z.string().datetime().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

type Action = z.infer<typeof actionSchema>;
type ActionBody = z.infer<typeof actionBodySchema>;

const DEFAULT_REASONS: Record<Action, string> = {
  reschedule: "rescheduled by staff",
  cancel: "cancelled by staff",
  confirm: "confirmed by staff",
  no_show: "marked no-show",
  complete: "marked completed",
};

function runAction(action: Action, appointmentId: string, body: ActionBody, reason: string) {
  if (action === "reschedule") {
    if (!body.startsAt) {
      throw httpError("VALIDATION_ERROR", {
        message: "A new start time is required to reschedule.",
        details: [{ path: "startsAt", code: "invalid_type", message: "Required" }],
        logMessage: "reschedule without startsAt",
      });
    }
    return bookingService.reschedule(appointmentId, body.startsAt);
  }
  if (action === "cancel") return bookingService.cancel(appointmentId, reason);
  if (action === "confirm") return bookingService.confirm(appointmentId, reason);
  const status = action === "no_show" ? "no_show" : "completed";
  return salonRepository.updateAppointmentStatus(appointmentId, status, reason);
}

export const POST = adminRoute<ActionBody, undefined, { id: string; action: string }>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/appointments/[id]/[action]",
    schema: actionBodySchema,
    audit: { entityType: "appointment", entityId: (params) => params.id },
  },
  async ({ body, params, session, audit, log }) => {
    const action = actionSchema.parse(params.action);
    const reason = body.reason ?? DEFAULT_REASONS[action];
    audit.setAction(`appointment.${action}`);

    const current = await salonRepository.findAppointmentById(params.id);
    if (!current) throw httpError("APPOINTMENT_NOT_FOUND");
    audit.setBefore({
      id: current.id,
      status: current.status,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      staffId: current.staffId,
    });

    const data = await runAction(action, params.id, body, reason);
    await recordStatusHistoryActor(params.id, session, log);
    audit.setAfter({
      id: data.id,
      status: data.status,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      staffId: data.staffId,
      reason,
    });
    return { data };
  },
);
