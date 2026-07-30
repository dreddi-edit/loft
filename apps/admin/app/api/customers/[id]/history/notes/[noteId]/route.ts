import { z } from "zod";
import { adminRoute } from "../../../../../../../lib/admin-api";
import { assertNoteBelongsToCustomer, deleteNoteSchema, historyActor, historyService, parseCustomerId, updateNoteSchema } from "../../shared";

type IdParams = { id: string; noteId: string };

export const PATCH = adminRoute<z.infer<typeof updateNoteSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/customers/[id]/history/notes/[noteId]",
    schema: updateNoteSchema,
  },
  async ({ body, params, session }) => {
    const customerId = parseCustomerId(params.id);
    await assertNoteBelongsToCustomer(customerId, params.noteId);
    const data = await historyService.updateNote(
      params.noteId,
      {
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      },
      { actor: historyActor(session) },
    );
    return { data };
  },
);

export const DELETE = adminRoute<z.infer<typeof deleteNoteSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/customers/[id]/history/notes/[noteId]",
    schema: deleteNoteSchema,
  },
  async ({ body, params, session }) => {
    const customerId = parseCustomerId(params.id);
    await assertNoteBelongsToCustomer(customerId, params.noteId);
    const data = await historyService.deleteNote(params.noteId, {
      actor: historyActor(session),
      ...(body.confirmAllergyDeletion ? { confirmAllergyDeletion: true } : {}),
    });
    return { data };
  },
);
