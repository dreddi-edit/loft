import { salonRepository } from "@hair-simo/core";
import { adminRoute } from "../../../lib/admin-api";

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/dashboard" },
  async () => ({ data: await salonRepository.getDashboardStats() }),
);
