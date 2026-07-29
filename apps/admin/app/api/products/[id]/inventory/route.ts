import { salonRepository } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, httpError, paginated, paginationSchema } from "../../../../../lib/admin-api";

export const inventoryAdjustmentSchema = z
  .object({
    quantity: z
      .number()
      .int()
      .refine((value) => value !== 0),
    type: z.enum(["adjustment", "purchase", "sale", "return"]).default("adjustment"),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const GET = adminRoute<unknown, z.infer<typeof paginationSchema>, { id: string }>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/products/[id]/inventory",
    query: paginationSchema,
  },
  async ({ params, query }) => {
    // `salonRepository.listProductInventoryMovements` takes a limit but no offset, so a
    // stock history longer than one page could not be walked through it.
    const movements = await prisma.inventoryMovement.findMany({
      where: { productId: params.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: query.offset,
      take: query.limit,
    });
    return paginated(movements, query);
  },
);

export const POST = adminRoute<z.infer<typeof inventoryAdjustmentSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/products/[id]/inventory",
    schema: inventoryAdjustmentSchema,
    successStatus: 201,
    audit: {
      entityType: "product",
      action: "product.inventoryAdjustment",
      entityId: (params) => params.id,
    },
  },
  async ({ body, params, audit }) => {
    const current = await salonRepository.findProductById(params.id);
    if (!current) throw httpError("NOT_FOUND", { logMessage: `product ${params.id} not found` });
    audit.setBefore({ stock: current.stock });
    const data = await salonRepository.adjustProductStock(params.id, body);
    audit.setAfter({
      stock: data.product.stock,
      delta: data.movement.delta,
      type: data.movement.type,
      reason: data.movement.reason,
    });
    return { data };
  },
);
