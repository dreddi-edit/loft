import { NotificationService } from "@hair-simo/core";
import { z } from "zod";
import { apiRoute } from "../../../../lib/api-handler";

const notificationService = new NotificationService();

const TASK_BODY_LIMIT_BYTES = 8_192;

const taskSchema = z.object({
  type: z.string().trim().min(1).max(100),
  data: z.record(z.string(), z.unknown()).default({}),
});

const notificationTaskSchema = z.object({
  channel: z.enum(["web", "sms", "whatsapp", "voice"]).default("web"),
  recipient: z.string().trim().min(3).max(254),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(4_000),
  locale: z.enum(["de", "it", "fr", "en"]).optional(),
});

export const POST = apiRoute<z.infer<typeof taskSchema>>(
  {
    route: "/api/tasks/notification",
    methods: ["POST"],
    policy: "internal",
    sharedSecret: "cloudTasks",
    bodyLimitBytes: TASK_BODY_LIMIT_BYTES,
    schema: taskSchema,
  },
  async ({ body, log }) => {
    if (body.type !== "notification.send") {
      log.warn("unknown cloud task type ignored", { type: body.type });
      return { ok: true, handled: false };
    }

    const payload = notificationTaskSchema.parse(body.data);
    const delivery = await notificationService.send(payload);
    return { ok: true, handled: true, status: delivery.status };
  },
);
