import { ReminderService } from "@hair-simo/core";
import { forEachActiveTenant } from "@hair-simo/db";
import { z } from "zod";
import { apiRoute } from "../../../../lib/api-handler";

const reminderService = new ReminderService();

const CRON_BODY_LIMIT_BYTES = 1_024;
const MAX_WITHIN_HOURS = 24 * 7;

const reminderBatchSchema = z.object({
  withinHours: z.coerce.number().int().min(1).max(MAX_WITHIN_HOURS).default(24),
});

export const POST = apiRoute<z.infer<typeof reminderBatchSchema>>(
  {
    route: "/api/cron/reminders",
    methods: ["POST"],
    policy: "internal",
    sharedSecret: "cron",
    bodyLimitBytes: CRON_BODY_LIMIT_BYTES,
    schema: reminderBatchSchema,
  },
  async ({ body }) => {
    const batches: Awaited<ReturnType<ReminderService["dispatchDueReminders"]>>[] = [];
    await forEachActiveTenant(async () => {
      batches.push(await reminderService.dispatchDueReminders(body.withinHours));
    });

    if (batches.length === 1) {
      return { data: batches[0] };
    }

    return {
      data: {
        processed: batches.reduce((sum, batch) => sum + batch.processed, 0),
        sent: batches.reduce((sum, batch) => sum + batch.sent, 0),
        simulated: batches.reduce((sum, batch) => sum + batch.simulated, 0),
        failed: batches.reduce((sum, batch) => sum + batch.failed, 0),
        skipped: batches.reduce((sum, batch) => sum + batch.skipped, 0),
        unreachable: batches.reduce((sum, batch) => sum + batch.unreachable, 0),
        results: batches.flatMap((batch) => batch.results),
        tenantCount: batches.length,
      },
    };
  },
);
