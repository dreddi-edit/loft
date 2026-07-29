import { WaitlistService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";

const waitlistService = new WaitlistService();

export const waitlistUpdateSchema = z.object({ status: z.enum(["cancelled", "expired"]) }).strict();

type TargetStatus = z.infer<typeof waitlistUpdateSchema>["status"];

const ENTRY_FIELDS = {
  id: true,
  status: true,
  customerId: true,
  serviceId: true,
  staffId: true,
  earliestAt: true,
  latestAt: true,
  notifiedAt: true,
  convertedAppointmentId: true,
} as const;

async function loadEntry(id: string) {
  const entry = await prisma.waitlist.findUnique({ where: { id }, select: ENTRY_FIELDS });
  if (!entry) throw httpError("NOT_FOUND", { logMessage: `waitlist entry ${id} not found` });
  return entry;
}

/**
 * A converted entry is the audit trail of an appointment that exists, so it is never
 * rewritten — the appointment is cancelled through /api/appointments/[id]/cancel instead.
 * Expiring is only meaningful while the entry is still in the queue.
 */
function assertTransition(current: { status: string }, next: TargetStatus): void {
  if (current.status === "converted") {
    throw httpError("CONFLICT", {
      message: "A converted waitlist entry can no longer be changed.",
      logMessage: `waitlist entry is converted, refusing ${next}`,
    });
  }
  if (next === "expired" && current.status === "cancelled") {
    throw httpError("CONFLICT", {
      message: "A cancelled waitlist entry cannot be expired.",
      logMessage: "waitlist entry is cancelled, refusing expire",
    });
  }
}

async function applyStatus(id: string, next: TargetStatus): Promise<void> {
  if (next === "cancelled") {
    await waitlistService.cancel(id);
    return;
  }
  // The service only expires windows in bulk, and only for entries still in the queue. The
  // same guard is repeated in the WHERE clause so a concurrent claim cannot be overwritten.
  await prisma.waitlist.updateMany({
    where: { id, status: { in: ["active", "notified"] } },
    data: { status: "expired" },
  });
}

export const PATCH = adminRoute<z.infer<typeof waitlistUpdateSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/waitlist/[id]",
    schema: waitlistUpdateSchema,
    audit: { entityType: "waitlist", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    const current = await loadEntry(params.id);
    assertTransition(current, body.status);
    audit.setAction(body.status === "cancelled" ? "waitlist.cancel" : "waitlist.expire");
    audit.setBefore(current);

    await applyStatus(params.id, body.status);

    const data = await loadEntry(params.id);
    audit.setAfter(data);
    return { data };
  },
);

export const DELETE = adminRoute<unknown, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/waitlist/[id]",
    audit: { entityType: "waitlist", action: "waitlist.cancel", entityId: (params) => params.id },
  },
  async ({ params, audit }) => {
    const current = await loadEntry(params.id);
    assertTransition(current, "cancelled");
    audit.setBefore(current);

    await applyStatus(params.id, "cancelled");

    const data = await loadEntry(params.id);
    audit.setAfter(data);
    return { data };
  },
);
