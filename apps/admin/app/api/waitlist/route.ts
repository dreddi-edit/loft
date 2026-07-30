import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    status: z.enum(["active", "notified", "converted", "expired", "cancelled"]).optional(),
    serviceId: z.string().trim().min(1).max(64).optional(),
    staffId: z.string().trim().min(1).max(64).optional(),
    ...paginationShape,
  })
  .strict();

/**
 * Sorted oldest first on `[createdAt, id]`, which is the fairness order `findMatches` hands
 * offers out in — the list on screen is the queue, not a recent-activity feed. Ending the
 * sort on the cuid primary key makes it total, so two entries created in the same
 * millisecond cannot repeat or drop across pages. `paginationShape` caps the page at
 * MAX_PAGE_SIZE, so the include below can never fan out unbounded.
 */
export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/waitlist", query: listQuerySchema },
  async ({ query }) => {
    const data = await prisma.waitlist.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.serviceId ? { serviceId: query.serviceId } : {}),
        ...(query.staffId ? { staffId: query.staffId } : {}),
      },
      select: {
        id: true,
        status: true,
        earliestAt: true,
        latestAt: true,
        locale: true,
        channel: true,
        notifiedAt: true,
        convertedAppointmentId: true,
        createdAt: true,
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        service: {
          select: {
            id: true,
            slug: true,
            durationMin: true,
            translations: { select: { locale: true, name: true } },
          },
        },
        staff: { select: { id: true, displayName: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: query.offset,
      take: query.limit,
    });
    return paginated(data, query);
  },
);
