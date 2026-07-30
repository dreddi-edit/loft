import { ReviewRequestService } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute } from "../../../../lib/admin-api";

const reviewService = new ReviewRequestService();

const metricsQuerySchema = z
  .object({
    from: z.string().trim().datetime().optional(),
    to: z.string().trim().datetime().optional(),
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
  })
  .strict();

export const GET = adminRoute<unknown, z.infer<typeof metricsQuerySchema>>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/reviews/metrics",
    query: metricsQuerySchema,
  },
  async ({ query }) => {
    const metrics = await reviewService.getMetrics({
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.locale ? { locale: query.locale } : {}),
    });
    return { data: metrics };
  },
);
