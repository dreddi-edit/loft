import { CUSTOMER_EXPORT_SCHEMA_VERSION, gdprService } from "@hair-simo/core";
import { prisma, type DataRequest } from "@hair-simo/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../../lib/admin-api";
import { gdprReferenceSchema, reasonPhrase, toQueueRow } from "../route";

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const FAILURE_REASONS = [
  "identity_not_verified",
  "customer_not_found",
  "withdrawn",
  "superseded",
  "technical_error",
] as const;

export const dataRequestProcessSchema = z
  .object({ action: z.literal("process") })
  .strict();

export const dataRequestFailSchema = z
  .object({
    action: z.literal("fail"),
    reason: z.enum(FAILURE_REASONS),
    reference: gdprReferenceSchema.optional(),
  })
  .strict();

type IdParams = { id: string };

async function loadRequest(rawId: string): Promise<DataRequest> {
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) {
    throw httpError("VALIDATION_ERROR", {
      message: "The data request id is not valid.",
      logMessage: "malformed data request id in path",
    });
  }
  const row = await prisma.dataRequest.findUnique({ where: { id: parsed.data } });
  if (!row) throw httpError("NOT_FOUND", { logMessage: `data request ${parsed.data} not found` });
  return row;
}

/** `resultLocation` is a JSON string written by GdprService; older rows may hold anything. */
function parseResult(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw: value };
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export const GET = adminRoute<unknown, undefined, IdParams>(
  { roles: ["owner", "manager"], route: "/api/gdpr/requests/[id]" },
  async ({ params }) => {
    const row = await loadRequest(params.id);
    return NextResponse.json(
      { data: { ...toQueueRow(row), result: parseResult(row.resultLocation) } },
      { headers: { "cache-control": "no-store" } },
    );
  },
);

/**
 * Processes an EXPORT request and hands the document back as a download.
 *
 * Delivery: an attachment, not a JSON body. The document enumerates every relation the
 * schema hangs off one customer — appointments, payments, whole chat transcripts — so it is
 * routinely megabytes and it is the customer's copy, not something the admin UI renders.
 * `Content-Disposition: attachment` means the browser writes it straight to disk with the
 * filename the service chose, and `no-store` keeps a subject-access disclosure out of every
 * cache between here and the operator. It is not streamed: GdprService materialises the
 * whole document in memory before serialising it, so a ReadableStream around the finished
 * string would buy nothing. True streaming needs a cursor API in the service (openIssues).
 *
 * Erasure requests are NOT executed here. Erasure is irreversible and owner-only, and that
 * is enforced by the wrapper on POST /api/customers/[id]/gdpr rather than by an `if` in a
 * route a manager can also reach.
 */
export const POST = adminRoute<z.infer<typeof dataRequestProcessSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager"],
    route: "/api/gdpr/requests/[id]",
    policy: "adminSensitive",
    schema: dataRequestProcessSchema,
    audit: { entityType: "dataRequest", action: "gdpr.request.export", entityId: (params) => params.id },
  },
  async ({ params, session, audit }) => {
    const row = await loadRequest(params.id);

    if (row.type !== "export") {
      throw httpError("CONFLICT", {
        message: "Erasure requests are executed from the customer erasure endpoint.",
        logMessage: `refused to process ${row.type} request ${row.id} here`,
      });
    }

    const file = await gdprService.exportCustomerDataAsJson(row.customerId, {
      dataRequestId: row.id,
      requestedBy: session.email,
    });
    const bytes = Buffer.byteLength(file.body, "utf8");

    audit.setEntityId(row.id);
    // Who disclosed what, when and how much. Not the document: the audit table must not
    // become a second copy of everything the salon knows about this person.
    audit.setAfter({
      dataRequestId: row.id,
      customerId: row.customerId,
      schemaVersion: CUSTOMER_EXPORT_SCHEMA_VERSION,
      delivery: "attachment",
      bytes,
    });

    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${safeFilename(file.filename)}"`,
        "content-length": String(bytes),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);

export const PATCH = adminRoute<z.infer<typeof dataRequestFailSchema>, undefined, IdParams>(
  {
    roles: ["owner", "manager"],
    route: "/api/gdpr/requests/[id]",
    schema: dataRequestFailSchema,
    audit: { entityType: "dataRequest", action: "gdpr.request.fail", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    const row = await loadRequest(params.id);

    // A completed request already produced a document or an erasure receipt. Rewriting its
    // status to failed would leave the salon holding a record that contradicts what it did.
    if (row.status === "completed") {
      throw httpError("CONFLICT", {
        message: "A completed data request cannot be marked failed.",
        logMessage: `refused to fail completed request ${row.id}`,
      });
    }

    const updated = await gdprService.failDataRequest(
      row.id,
      reasonPhrase(body.reason, body.reference),
    );

    audit.setEntityId(row.id);
    audit.setBefore({ status: row.status });
    audit.setAfter({
      status: updated.status,
      reason: body.reason,
      reference: body.reference ?? null,
      customerId: updated.customerId,
    });

    return { data: toQueueRow(updated) };
  },
);
