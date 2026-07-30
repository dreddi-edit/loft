import { RecurringService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const recurringService = new RecurringService();

const listQuerySchema = z
  .object({
    active: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === "true")),
    customerId: z.string().trim().min(1).max(64).optional(),
    ...paginationShape,
  })
  .strict();

export const GET = adminRoute<unknown, z.infer<typeof listQuerySchema>>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/recurring",
    query: listQuerySchema,
  },
  async ({ query }) => {
    const data = await prisma.recurringSeries.findMany({
      where: {
        ...(query.active === undefined ? {} : { active: query.active }),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        service: {
          select: {
            id: true,
            slug: true,
            translations: { select: { locale: true, name: true } },
          },
        },
        staff: { select: { id: true, displayName: true } },
      },
      orderBy: [{ nextAt: "asc" }, { id: "asc" }],
      skip: query.offset,
      take: query.limit,
    });
    return paginated(data, query);
  },
);

const createSchema = z
  .object({
    customerId: z.string().trim().min(1).max(64),
    serviceId: z.string().trim().min(1).max(64),
    staffId: z.string().trim().min(1).max(64).optional(),
    firstAt: z.string().trim().datetime(),
    intervalWeeks: z.number().int().min(1).max(26),
    endsAt: z.string().trim().datetime().nullable().optional(),
    occurrences: z.number().int().min(1).max(104).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("de"),
    channel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
  })
  .strict();

export const POST = adminRoute<z.infer<typeof createSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/recurring",
    schema: createSchema,
    successStatus: 201,
    audit: { entityType: "recurringSeries", action: "recurring.create" },
  },
  async ({ body, audit }) => {
    const series = await recurringService.createSeries(body);
    audit.setEntityId(series.id);
    audit.setAfter({ customerId: series.customerId, serviceId: series.serviceId, nextAt: series.nextAt });
    return { data: series };
  },
);
