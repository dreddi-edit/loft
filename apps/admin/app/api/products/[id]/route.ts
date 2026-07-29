import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";

const updateProductSchema = z
  .object({
    sku: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    priceCents: z.number().int().nonnegative().optional(),
  })
  .strict();

function snapshot(product: { sku: string; name: string; priceCents: number; stock: number }) {
  return {
    sku: product.sku,
    name: product.name,
    priceCents: product.priceCents,
    stock: product.stock,
  };
}

export const GET = adminRoute<unknown, undefined, { id: string }>(
  { roles: ["owner", "manager", "staff"], route: "/api/products/[id]" },
  async ({ params }) => {
    const data = await salonRepository.findProductById(params.id);
    if (!data) throw httpError("NOT_FOUND", { logMessage: `product ${params.id} not found` });
    return { data };
  },
);

export const PATCH = adminRoute<z.infer<typeof updateProductSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/products/[id]",
    schema: updateProductSchema,
    audit: { entityType: "product", action: "product.update", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    const current = await salonRepository.findProductById(params.id);
    if (!current) throw httpError("NOT_FOUND", { logMessage: `product ${params.id} not found` });
    audit.setBefore(snapshot(current));
    const data = await salonRepository.updateProduct(params.id, body);
    audit.setAfter(snapshot(data));
    return { data };
  },
);

export const DELETE = adminRoute<unknown, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/products/[id]",
    policy: "adminSensitive",
    audit: { entityType: "product", action: "product.delete", entityId: (params) => params.id },
  },
  async ({ params, audit }) => {
    const current = await salonRepository.findProductById(params.id);
    if (!current) throw httpError("NOT_FOUND", { logMessage: `product ${params.id} not found` });
    audit.setBefore(snapshot(current));
    const data = await salonRepository.deleteProduct(params.id);
    audit.setAfter({ deleted: true });
    return { data };
  },
);
