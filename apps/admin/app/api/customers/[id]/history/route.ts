import { z } from "zod";
import { adminRoute } from "../../../../../lib/admin-api";
import { historyService, localeQuerySchema, parseCustomerId } from "./shared";

type IdParams = { id: string };

export const GET = adminRoute<unknown, z.infer<typeof localeQuerySchema>, IdParams>(
  { roles: ["owner", "manager", "staff"], route: "/api/customers/[id]/history", query: localeQuerySchema },
  async ({ params, query }) => {
    const customerId = parseCustomerId(params.id);
    const data = await historyService.getCustomerProfile(customerId, {
      ...(query.locale ? { locale: query.locale } : {}),
    });
    return { data };
  },
);
