import { prisma } from "@hair-simo/db";
import { adminRoute, paginated, paginationSchema } from "../../../lib/admin-api";

/**
 * Queried directly rather than through `salonRepository.listCallLogs`, which takes a limit
 * but no offset and orders on `createdAt` alone. Timestamps are millisecond-precise, so two
 * calls logged in the same tick tie and a paged read can repeat or drop one; ending the
 * sort on the cuid primary key makes the order total.
 */
export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/call-logs", query: paginationSchema },
  async ({ query }) => {
    const data = await prisma.callLog.findMany({
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: query.offset,
      take: query.limit,
    });
    return paginated(data, query);
  },
);
