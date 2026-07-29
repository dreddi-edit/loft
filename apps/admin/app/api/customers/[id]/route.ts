import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";

export const customerUpdateSchema = z
  .object({
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
    marketingOptIn: z.boolean().optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const GET = adminRoute<unknown, undefined, { id: string }>(
  { roles: ["owner", "manager", "staff"], route: "/api/customers/[id]" },
  async ({ params }) => {
    const data = await salonRepository.findCustomerById(params.id);
    if (!data) throw httpError("NOT_FOUND", { logMessage: `customer ${params.id} not found` });
    return { data };
  },
);

export const PATCH = adminRoute<z.infer<typeof customerUpdateSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/customers/[id]",
    schema: customerUpdateSchema,
    audit: { entityType: "customer", action: "customer.update", entityId: (params) => params.id },
  },
  async ({ body, params, session, audit }) => {
    const current = await salonRepository.findCustomerById(params.id);
    if (!current) throw httpError("NOT_FOUND", { logMessage: `customer ${params.id} not found` });

    const { note, ...customerFields } = body;
    audit.setBefore({
      firstName: current.firstName,
      lastName: current.lastName,
      email: current.email,
      phone: current.phone,
      locale: current.locale,
      marketingOptIn: current.marketingOptIn,
    });

    if (note) {
      await salonRepository.addCustomerNote(params.id, note, { authorId: session.userId });
    }
    const customer = Object.keys(customerFields).length
      ? await salonRepository.updateCustomer(params.id, customerFields)
      : current;

    audit.setAfter({
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      locale: customer.locale,
      marketingOptIn: customer.marketingOptIn,
      ...(note ? { noteAdded: true } : {}),
    });
    return { data: customer };
  },
);
