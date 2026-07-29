import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute } from "../../../lib/admin-api";

/**
 * The editor round-trips the row it was rendered with, so the server-owned identifiers come
 * back on the wire. They are accepted and dropped rather than rejected; only the four
 * editable fields are ever forwarded to the repository.
 */
const upsertSchema = z
  .object({
    id: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    dayOfWeek: z.number().int().min(0).max(6),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
    isOpen: z.boolean(),
  })
  .strict()
  .refine((input) => !input.isOpen || input.endMin > input.startMin, {
    message: "endMin must be after startMin on an open day",
    path: ["endMin"],
  });

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/business-hours" },
  async () => ({ data: await salonRepository.listBusinessHours() }),
);

export const PUT = adminRoute<z.infer<typeof upsertSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/business-hours",
    schema: upsertSchema,
    audit: { entityType: "businessHours", action: "businessHours.upsert" },
  },
  async ({ body, audit }) => {
    const current = (await salonRepository.listBusinessHours()).find(
      (entry) => entry.dayOfWeek === body.dayOfWeek,
    );
    if (current) {
      audit.setBefore({
        dayOfWeek: current.dayOfWeek,
        startMin: current.startMin,
        endMin: current.endMin,
        isOpen: current.isOpen,
      });
    }
    const updated = await salonRepository.upsertBusinessHours(
      body.dayOfWeek,
      body.startMin,
      body.endMin,
      body.isOpen,
    );
    audit.setEntityId(updated.id);
    audit.setAfter({
      dayOfWeek: updated.dayOfWeek,
      startMin: updated.startMin,
      endMin: updated.endMin,
      isOpen: updated.isOpen,
    });
    return { data: updated };
  },
);
