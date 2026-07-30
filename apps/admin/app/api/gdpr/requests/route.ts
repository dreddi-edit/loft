import { gdprService } from "@hair-simo/core";
import { prisma, type DataRequest } from "@hair-simo/db";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";

/** `listDataRequests` caps `take` at 200; the queue for one salon never approaches it. */
const MAX_QUEUE_PAGE = 200;

/**
 * Free text is how identifiers leak back into a compliance record. The erasure receipt and
 * the audit row both persist whatever reason they are given, and an operator typing
 * "Anna Bauer asked by mail" would write the very name the erasure just destroyed straight
 * back into the database. So the vocabulary is closed, and the only variable part is a
 * reference that must start with a letter, which excludes a bare phone number, and forbids
 * "@" and spaces, which excludes an address and a full name.
 *
 * Exported so the erasure endpoint speaks the same vocabulary; a receipt whose reason drifts
 * from the ticket it was raised under is worth very little in an audit.
 */
export const GDPR_REASONS = [
  "subject_request",
  "consent_withdrawn",
  "retention_expired",
  "supervisory_order",
  "unlawful_processing",
] as const;

export const gdprReasonSchema = z.enum(GDPR_REASONS);

export const gdprReferenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._/-]{0,63}$/, "A reference must start with a letter.");

/** Both the erasure reasons above and the failure reasons in `[id]/route.ts` render here. */
export function reasonPhrase(reason: string, reference?: string): string {
  return reference ? `${reason} ref:${reference}` : reason;
}

export const dataRequestListQuerySchema = z
  .object({
    customerId: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_QUEUE_PAGE).default(50),
  })
  .strict();

export const dataRequestCreateSchema = z
  .object({
    customerId: z.string().trim().min(1).max(64),
    type: z.enum(["export", "erasure"]),
  })
  .strict();

/**
 * `resultLocation` holds the whole erasure receipt as a JSON string, which is far too heavy
 * for a queue view. The list says whether a result exists; the detail route returns it.
 */
export function toQueueRow(row: DataRequest) {
  return {
    id: row.id,
    customerId: row.customerId,
    type: row.type,
    status: row.status,
    requestedBy: row.requestedBy,
    hasResult: row.resultLocation !== null,
    error: row.error,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

export const GET = adminRoute<unknown, z.infer<typeof dataRequestListQuerySchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/gdpr/requests",
    query: dataRequestListQuerySchema,
  },
  async ({ query }) => {
    const rows = await gdprService.listDataRequests({
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      take: query.limit,
    });

    // Not the shared `paginated()` envelope: GdprService.listDataRequests takes a limit and
    // no offset, so claiming an offset here would promise a second page that cannot be
    // fetched. Narrow the filters instead.
    return {
      data: rows.map(toQueueRow),
      pagination: { limit: query.limit, count: rows.length, hasMore: rows.length === query.limit },
    };
  },
);

export const POST = adminRoute<z.infer<typeof dataRequestCreateSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/gdpr/requests",
    schema: dataRequestCreateSchema,
    successStatus: 201,
    audit: { entityType: "dataRequest", action: "gdpr.request.create" },
  },
  async ({ body, session, audit }) => {
    // Deliberately not read through findLiveCustomer: a soft-deleted or already anonymised
    // person can still raise an access request, and refusing to file it would be the wrong
    // answer under Art. 15.
    const customer = await prisma.customer.findUnique({
      where: { id: body.customerId },
      select: { id: true },
    });
    if (!customer) {
      throw httpError("NOT_FOUND", {
        logMessage: `data request raised for unknown customer ${body.customerId}`,
      });
    }

    // requestedBy is accountability, so it is taken from the session and never from the
    // body: the operator who filed the ticket is the one who has to stand behind it.
    const created = await gdprService.createDataRequest({
      customerId: body.customerId,
      type: body.type,
      requestedBy: session.email,
    });

    audit.setEntityId(created.id);
    audit.setAfter({
      id: created.id,
      customerId: created.customerId,
      type: created.type,
      status: created.status,
      requestedBy: created.requestedBy,
    });

    return { data: toQueueRow(created) };
  },
);
