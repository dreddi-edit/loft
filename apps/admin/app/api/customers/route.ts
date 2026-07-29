import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    ...paginationShape,
  })
  .strict();

const createSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().max(30).optional(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
    marketingOptIn: z.boolean().default(false),
  })
  .strict();

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/customers", query: listQuerySchema },
  async ({ query }) => {
    const customers = await salonRepository.listCustomers({
      query: query.query,
      skip: query.offset,
      take: query.limit,
    });
    return paginated(customers, query);
  },
);

export const POST = adminRoute<z.infer<typeof createSchema>>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/customers",
    schema: createSchema,
    successStatus: 201,
    audit: { entityType: "customer", action: "customer.create" },
  },
  async ({ body, audit }) => {
    const customer = await salonRepository.createCustomer(body);
    audit.setEntityId(customer.id);
    audit.setAfter({
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      locale: customer.locale,
      marketingOptIn: customer.marketingOptIn,
    });
    return { data: customer };
  },
);
