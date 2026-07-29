import { apiRoute } from "../../../../lib/api-handler";
import { getPublicRuntimeConfig } from "../../../../lib/public-config";

export const GET = apiRoute(
  { route: "/api/config/public", methods: ["GET"], policy: "publicRead" },
  () => ({ data: getPublicRuntimeConfig() }),
);
