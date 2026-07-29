import { ReminderService } from "@hair-simo/core";
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
  async ({ body }) => ({ data: await reminderService.dispatchDueReminders(body.withinHours) }),
);
