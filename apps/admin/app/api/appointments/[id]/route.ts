import { salonRepository } from "@hair-simo/core";
import { adminRoute, httpError } from "../../../../lib/admin-api";

export const GET = adminRoute<unknown, undefined, { id: string }>(
  { roles: ["owner", "manager", "staff"], route: "/api/appointments/[id]" },
  async ({ params }) => {
    const data = await salonRepository.findAppointmentById(params.id);
    if (!data) throw httpError("APPOINTMENT_NOT_FOUND");
    return { data };
  },
);
