import { NotificationService } from "@hair-simo/core";
import { adminRoute } from "../../../../../lib/admin-api";

const notificationService = new NotificationService();

export const POST = adminRoute<unknown, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/notifications/[id]/retry",
    audit: {
      entityType: "notificationLog",
      action: "notification.retry",
      entityId: (params) => params.id,
    },
  },
  async ({ params, audit }) => {
    const result = await notificationService.retry(params.id);
    if (result.record) {
      audit.setAfter({
        status: result.record.status,
        attempts: result.record.attempts,
        channel: result.record.channel,
      });
    }
    return { data: result };
  },
);
