import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    lowStockAt: z.coerce.number().int().min(0).max(1_000_000).optional(),
    ...paginationShape,
  })
  .strict();

const createProductSchema = z
  .object({
    sku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    priceCents: z.number().int().nonnegative(),
    stock: z.number().int().nonnegative().default(0),
  })
  .strict();

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/products", query: listQuerySchema },
  async ({ query }) => {
    const data = await salonRepository.listProducts({
      query: query.query,
      lowStockAt: query.lowStockAt,
      skip: query.offset,
      take: query.limit,
    });
    return paginated(data, query);
  },
);

export const POST = adminRoute<z.infer<typeof createProductSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/products",
    schema: createProductSchema,
    successStatus: 201,
    audit: { entityType: "product", action: "product.create" },
  },
  async ({ body, audit }) => {
    const created = await salonRepository.createProduct(body);
    const data = await salonRepository.findProductById(created.id);
    if (!data) throw httpError("NOT_FOUND", { logMessage: `product ${created.id} vanished` });
    audit.setEntityId(data.id);
    audit.setAfter({ id: data.id, sku: data.sku, name: data.name, priceCents: data.priceCents, stock: data.stock });
    return { data };
  },
);
