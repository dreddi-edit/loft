import { NotificationService } from "@hair-simo/core";
import { z } from "zod";
import { apiRoute } from "../../../lib/api-handler";

const notificationService = new NotificationService();

const CONTACT_BODY_LIMIT_BYTES = 8_192;

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(5).max(2_000),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
});

export const POST = apiRoute<z.infer<typeof contactSchema>>(
  {
    route: "/api/contact",
    methods: ["POST"],
    policy: "contact",
    bodyLimitBytes: CONTACT_BODY_LIMIT_BYTES,
    schema: contactSchema,
  },
  async ({ body }) => {
    const salonEmail = process.env.CONTACT_INBOX_EMAIL ?? "info@hairsimo.it";
    await notificationService.send({
      channel: "web",
      recipient: salonEmail,
      subject: `Contact form: ${body.name}`,
      message: `From: ${body.name} <${body.email}>\n\n${body.message}`,
      locale: body.locale,
    });
    return { ok: true };
  },
);
