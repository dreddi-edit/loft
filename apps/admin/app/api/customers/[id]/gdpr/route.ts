import { gdprService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../../lib/admin-api";
import {
  gdprReasonSchema,
  gdprReferenceSchema,
  reasonPhrase,
  toQueueRow,
} from "../../../gdpr/requests/route";

const CONSENT_HISTORY_LIMIT = 200;
const DATA_REQUEST_LIMIT = 100;

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The confirmation is not a checkbox. `confirm` has to be the literal word and `customerId`
 * has to repeat the customer already named in the path, so an operator cannot fire an
 * irreversible erasure by clicking the wrong row: the payload has to name the target twice.
 */
export const erasureSchema = z
  .object({
    confirm: z.literal("ERASE"),
    customerId: z.string().trim().min(1).max(64),
    reason: gdprReasonSchema,
    reference: gdprReferenceSchema.optional(),
    dataRequestId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

type IdParams = { id: string };

function customerId(rawId: string): string {
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) {
    throw httpError("VALIDATION_ERROR", {
      message: "The customer id is not valid.",
      logMessage: "malformed customer id in path",
    });
  }
  return parsed.data;
}

export const GET = adminRoute<unknown, undefined, IdParams>(
  { roles: ["owner", "manager"], route: "/api/customers/[id]/gdpr" },
  async ({ params }) => {
    const id = customerId(params.id);
    // Read outside LIVE_CUSTOMER_WHERE on purpose: the point of this view is to show what
    // happened to a person, including one who has already been erased.
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, anonymizedAt: true },
    });
    if (!customer) throw httpError("NOT_FOUND", { logMessage: `customer ${id} not found` });

    const [consent, requests] = await Promise.all([
      gdprService.readConsentHistory(id, { take: CONSENT_HISTORY_LIMIT }),
      gdprService.listDataRequests({ customerId: id, take: DATA_REQUEST_LIMIT }),
    ]);

    return NextResponse.json(
      {
        data: {
          customerId: id,
          erased: customer.anonymizedAt !== null,
          deletedAt: customer.deletedAt,
          anonymizedAt: customer.anonymizedAt,
          consent,
          dataRequests: requests.map(toQueueRow),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
);

/**
 * Art. 17 erasure. Irreversible, and the only endpoint in the product that is.
 *
 * `roles: ["owner"]` is the whole gate and it lives in the wrapper, not in an `if` inside a
 * handler a manager can also reach: a manager gets 403 before the body is even parsed.
 * The service anonymises rather than deletes, because the appointment and its payment are
 * accounting records Italian law keeps for ten years — the receipt returned here says
 * exactly what was destroyed and what was kept, and why.
 */
export const POST = adminRoute<z.infer<typeof erasureSchema>, undefined, IdParams>(
  {
    roles: ["owner"],
    route: "/api/customers/[id]/gdpr",
    policy: "adminSensitive",
    schema: erasureSchema,
    audit: {
      entityType: "customer",
      action: "gdpr.customer.erasure.ordered",
      entityId: (params) => params.id,
    },
  },
  async ({ body, params, session, audit }) => {
    const id = customerId(params.id);
    if (body.customerId !== id) {
      throw httpError("VALIDATION_ERROR", {
        message: "The confirmation does not name the customer in the path.",
        logMessage: "erasure confirmation did not match the path id",
      });
    }

    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw httpError("NOT_FOUND", { logMessage: `customer ${id} not found` });

    if (body.dataRequestId) {
      const request = await prisma.dataRequest.findUnique({
        where: { id: body.dataRequestId },
        select: { id: true, customerId: true, type: true, status: true },
      });
      if (!request) {
        throw httpError("NOT_FOUND", { logMessage: `data request ${body.dataRequestId} not found` });
      }
      // Without this an erasure could close somebody else's ticket, or an export ticket,
      // and the compliance trail would point at the wrong person.
      if (request.customerId !== id || request.type !== "erasure") {
        throw httpError("CONFLICT", {
          message: "That data request is not an erasure request for this customer.",
          logMessage: `data request ${request.id} does not match the erasure target`,
        });
      }
    }

    const result = await gdprService.eraseCustomerData(id, {
      requestedBy: session.email,
      reason: reasonPhrase(body.reason, body.reference),
      ...(body.dataRequestId ? { dataRequestId: body.dataRequestId } : {}),
    });

    // Who ordered it is already on the row: adminRoute stamps actorId, actorEmail and
    // actorRole from the session. What must NOT be here is the person being erased. No
    // name, no email, no phone is read by this handler, so none can reach the audit, and
    // the reason is a closed vocabulary plus a reference that cannot hold an address.
    // The counts prove the sweep ran without describing anybody.
    audit.setAfter({
      customerId: id,
      confirmed: body.confirm,
      reason: body.reason,
      reference: body.reference ?? null,
      alreadyErased: result.alreadyErased,
      dataRequestId: result.dataRequestId,
      removed: result.receipt.removed,
      retained: Object.fromEntries(
        result.receipt.retained.map((entry) => [entry.dataClass, entry.records]),
      ),
    });

    return NextResponse.json(
      { data: { receipt: result.receipt, dataRequestId: result.dataRequestId } },
      { headers: { "cache-control": "no-store" } },
    );
  },
);
