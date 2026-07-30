import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    actorId: z.string().trim().min(1).max(64).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: z.string().trim().min(1).max(64).optional(),
    from: z.string().trim().datetime().optional(),
    to: z.string().trim().datetime().optional(),
    ...paginationShape,
  })
  .strict();

export const GET = adminRoute<unknown, z.infer<typeof listQuerySchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/audit-log",
    query: listQuerySchema,
  },
  async ({ query }) => {
    const data = await salonRepository.listAuditLog(
      {
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
      },
      { skip: query.offset, take: query.limit },
    );
    return paginated(data, query);
  },
);
