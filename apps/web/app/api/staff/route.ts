import { salonRepository } from "@hair-simo/core";
import { apiRoute } from "../../../lib/api-handler";

export const GET = apiRoute(
  { route: "/api/staff", methods: ["GET"], policy: "publicRead" },
  async () => {
    const staff = await salonRepository.listStaff({ isBookable: true });
    return { data: staff.map((member) => ({ id: member.id, displayName: member.displayName })) };
  },
);
