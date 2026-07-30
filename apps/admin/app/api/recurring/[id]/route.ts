import { RecurringService } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError, type ErrorCode } from "../../../../lib/admin-api";

const recurringService = new RecurringService();

const actionSchema = z
  .object({
    action: z.enum(["pause", "resume", "skip", "end"]),
    cancelFutureAppointments: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const SERIES_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  SERIES_NOT_FOUND: { code: "NOT_FOUND", message: "That recurring series does not exist." },
  SERIES_CHANGED: {
    code: "CONFLICT",
    message: "The series changed while this request was running. Try again.",
  },
  SERIES_TOO_STALE: {
    code: "CONFLICT",
    message: "This series has been paused too long to resume on the original cadence.",
  },
};

function translate(error: unknown): never {
  if (error instanceof Error) {
    const mapping = SERIES_ERRORS[error.message];
    if (mapping) {
      throw httpError(mapping.code, { message: mapping.message, logMessage: error.message });
    }
  }
  throw error;
}

export const GET = adminRoute<unknown, undefined, { id: string }>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/recurring/[id]",
  },
  async ({ params }) => {
    try {
      const data = await recurringService.getSeries(params.id);
      return { data };
    } catch (error) {
      translate(error);
    }
  },
);

export const PATCH = adminRoute<z.infer<typeof actionSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/recurring/[id]",
    schema: actionSchema,
    audit: { entityType: "recurringSeries", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    audit.setAction(`recurring.${body.action}`);

    try {
      if (body.action === "pause") {
        const data = await recurringService.pause(params.id);
        audit.setAfter(data);
        return { data };
      }
      if (body.action === "resume") {
        const data = await recurringService.resume(params.id);
        audit.setAfter(data);
        return { data };
      }
      if (body.action === "skip") {
        const data = await recurringService.skipNext(params.id, body.reason);
        audit.setAfter(data);
        return { data };
      }
      const data = await recurringService.endSeries(params.id, {
        cancelFutureAppointments: body.cancelFutureAppointments ?? false,
        reason: body.reason,
      });
      audit.setAfter(data);
      return { data };
    } catch (error) {
      translate(error);
    }
  },
);
