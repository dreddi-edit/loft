import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    status: z.enum(["pending", "sent", "failed", "abandoned"]).optional(),
    channel: z.enum(["web", "whatsapp", "sms", "voice"]).optional(),
    ...paginationShape,
  })
  .strict();

/**
 * Queried directly rather than through `salonRepository.listNotificationLogs`, which takes a
 * limit but no offset and orders on `createdAt` alone — a millisecond tie between two logs
 * written in the same batch makes a paged read repeat or drop rows.
 */
export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/notifications", query: listQuerySchema },
  async ({ query }) => {
    const data = await prisma.notificationLog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
      },
      include: { appointment: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: query.offset,
      take: query.limit,
    });
    return paginated(data, query);
  },
);
