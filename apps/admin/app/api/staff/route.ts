import { hashPassword, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, paginated, paginationShape } from "../../../lib/admin-api";

const listQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    isBookable: z.enum(["true", "false"]).optional(),
    ...paginationShape,
  })
  .strict();

const createStaffSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(150),
    bio: z.string().trim().max(2000).optional(),
    phone: z.string().trim().max(30).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    isBookable: z.boolean().default(true),
    role: z.enum(["owner", "manager", "staff"]).default("staff"),
  })
  .strict();

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/staff", query: listQuerySchema },
  async ({ query }) => {
    const staff = await salonRepository.listStaff({
      query: query.query,
      isBookable: query.isBookable === undefined ? undefined : query.isBookable === "true",
      skip: query.offset,
      take: query.limit,
    });
    return paginated(staff, query);
  },
);

export const POST = adminRoute<z.infer<typeof createStaffSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/staff",
    schema: createStaffSchema,
    policy: "adminSensitive",
    successStatus: 201,
    audit: { entityType: "staff", action: "staff.create" },
  },
  async ({ body, audit }) => {
    const staff = await salonRepository.createStaff({
      ...body,
      passwordHash: await hashPassword(body.password),
    });
    audit.setEntityId(staff.id);
    audit.setAfter({
      userId: staff.id,
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      isBookable: body.isBookable,
    });
    return { data: staff };
  },
);
