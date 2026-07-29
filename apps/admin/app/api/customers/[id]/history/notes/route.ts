import { z } from "zod";
import { adminRoute } from "../../../../../../lib/admin-api";
import {
  addNoteSchema,
  historyActor,
  historyService,
  parseCustomerId,
} from "../shared";

type IdParams = { id: string };

export const POST = adminRoute<z.infer<typeof addNoteSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/customers/[id]/history/notes",
    schema: addNoteSchema,
  },
  async ({ body, params, session }) => {
    const customerId = parseCustomerId(params.id);
    const data = await historyService.addNote({
      customerId,
      note: body.note,
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      actor: historyActor(session),
    });
    return { data };
  },
);
