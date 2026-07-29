import {
  VOUCHER_MAX_CENTS,
  VOUCHER_MIN_CENTS,
  VoucherService,
  parseVoucherCode,
  voucherExpiryPolicy,
  type VoucherStatus,
} from "@hair-simo/core";
import { prisma, type Prisma, type Voucher } from "@hair-simo/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  HttpError,
  adminRoute,
  httpError,
  paginated,
  paginationShape,
  type ErrorCode,
} from "../../../lib/admin-api";

const voucherService = new VoucherService();

/** Mirrors MAX_VALIDITY_MONTHS in packages/core/src/voucher-service.ts. */
const MAX_VALIDITY_MONTHS = 1_200;
const MAX_CODE_INPUT_LENGTH = 64;
const CODE_SUFFIX_LENGTH = 4;

type VoucherErrorMapping = { code: ErrorCode; message: string };

/**
 * VoucherService throws plain `new Error("CODE")` and none of those codes are in the
 * admin-api alias table, so without this they all normalise to INTERNAL and the operator
 * gets a 500 for typing a card number wrong. Exported because the sibling voucher routes
 * translate the same vocabulary.
 */
const VOUCHER_ERRORS: Record<string, VoucherErrorMapping> = {
  VOUCHER_CODE_MALFORMED: {
    code: "VALIDATION_ERROR",
    message: "That is not the shape of a voucher code.",
  },
  VOUCHER_CODE_CHECKSUM_FAILED: {
    code: "VALIDATION_ERROR",
    message: "That voucher code has a typo in it. Read it off the card again.",
  },
  VOUCHER_NOT_FOUND: { code: "NOT_FOUND", message: "No voucher matches this code." },
  VOUCHER_INACTIVE: { code: "CONFLICT", message: "This voucher has been blocked." },
  VOUCHER_EXPIRED: { code: "CONFLICT", message: "This voucher has expired." },
  VOUCHER_CURRENCY_MISMATCH: {
    code: "CONFLICT",
    message: "This voucher was issued in a different currency.",
  },
  VOUCHER_INSUFFICIENT_BALANCE: {
    code: "CONFLICT",
    message: "The voucher does not have that much left on it.",
  },
  VOUCHER_REDEMPTION_AMOUNT_MISMATCH: {
    code: "CONFLICT",
    message: "This voucher was already redeemed against this appointment for another amount.",
  },
  VOUCHER_EXPIRY_INVALID: {
    code: "VALIDATION_ERROR",
    message: "The expiry date is not a valid instant.",
  },
  VOUCHER_EXPIRY_IN_THE_PAST: {
    code: "VALIDATION_ERROR",
    message: "The expiry date is already in the past.",
  },
  VOUCHER_VALIDITY_TOO_SHORT: {
    code: "VALIDATION_ERROR",
    message: "That validity is shorter than the salon's minimum. Confirm it explicitly to issue it.",
  },
  VOUCHER_CODE_GENERATION_FAILED: {
    code: "CONFLICT",
    message: "The voucher code could not be allocated. Try again.",
  },
};

export function translateVoucherError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return error;
  const mapping = VOUCHER_ERRORS[error.message];
  if (!mapping) return error;
  return new HttpError(mapping.code, {
    message: mapping.message,
    cause: error,
    logMessage: error.message,
  });
}

export async function withVoucherErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateVoucherError(error);
  }
}

/** `parseVoucherCode` is synchronous, so it needs its own translation point. */
function canonicalCode(raw: string): string {
  try {
    return parseVoucherCode(raw);
  } catch (error) {
    throw translateVoucherError(error);
  }
}

/** Same rule as `voucherStatus` in voucher-service, which does not export it. */
export function statusOf(
  voucher: Pick<Voucher, "active" | "remainingCents" | "expiresAt">,
  now: Date,
): VoucherStatus {
  if (!voucher.active) return "inactive";
  if (voucher.expiresAt !== null && voucher.expiresAt <= now) return "expired";
  if (voucher.remainingCents <= 0) return "spent";
  return "active";
}

function whereForStatus(status: VoucherStatus, now: Date): Prisma.VoucherWhereInput {
  const live = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  if (status === "inactive") return { active: false };
  if (status === "expired") return { active: true, expiresAt: { lte: now } };
  if (status === "spent") return { active: true, remainingCents: { lte: 0 }, ...live };
  return { active: true, remainingCents: { gt: 0 }, ...live };
}

/**
 * A list row carries the last four characters, never the code. The whole point of the code
 * is that holding it is authorisation to spend, so a paginated endpoint that returns every
 * code turns one stolen operator session into every gift card in the salon. The full code
 * is handed out once at issue time, and one at a time from the detail route.
 */
function toRow(voucher: Voucher, now: Date) {
  return {
    id: voucher.id,
    codeSuffix: voucher.code.slice(-CODE_SUFFIX_LENGTH),
    initialCents: voucher.initialCents,
    remainingCents: voucher.remainingCents,
    currency: voucher.currency,
    status: statusOf(voucher, now),
    active: voucher.active,
    expiresAt: voucher.expiresAt,
    issuedToCustomerId: voucher.issuedToCustomerId,
    note: voucher.note,
    createdAt: voucher.createdAt,
  };
}

export const voucherListQuerySchema = z
  .object({
    view: z.enum(["list", "liability"]).default("list"),
    status: z.enum(["active", "spent", "expired", "inactive", "any"]).default("any"),
    code: z.string().trim().min(1).max(MAX_CODE_INPUT_LENGTH).optional(),
    customerId: z.string().trim().min(1).max(64).optional(),
    ...paginationShape,
  })
  .strict();

export const voucherIssueSchema = z
  .object({
    initialCents: z.number().int().min(VOUCHER_MIN_CENTS).max(VOUCHER_MAX_CENTS),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .default("EUR"),
    expiresAt: z.string().trim().datetime({ offset: true }).nullable().optional(),
    validityMonths: z.number().int().min(1).max(MAX_VALIDITY_MONTHS).optional(),
    issuedToCustomerId: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    overrideMinimumValidity: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.expiresAt === undefined || value.validityMonths === undefined, {
    message: "Pass either expiresAt or validityMonths, not both.",
    path: ["validityMonths"],
  });

export const GET = adminRoute<unknown, z.infer<typeof voucherListQuerySchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/vouchers",
    query: voucherListQuerySchema,
  },
  async ({ query }) => {
    const now = new Date();

    if (query.view === "liability") {
      return { data: await voucherService.outstandingLiability(now) };
    }

    // Canonicalised rather than matched as a substring: the checksum turns a mistyped card
    // into a clean 400 instead of a scan across the whole table.
    const code = query.code ? canonicalCode(query.code) : undefined;

    const where: Prisma.VoucherWhereInput = {
      ...(code ? { code } : {}),
      ...(query.customerId ? { issuedToCustomerId: query.customerId } : {}),
      ...(query.status === "any" ? {} : whereForStatus(query.status, now)),
    };

    const vouchers = await prisma.voucher.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: query.offset,
      take: query.limit,
    });

    return paginated(
      vouchers.map((voucher) => toRow(voucher, now)),
      query,
    );
  },
);

export const POST = adminRoute<z.infer<typeof voucherIssueSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/vouchers",
    policy: "adminSensitive",
    schema: voucherIssueSchema,
    successStatus: 201,
    audit: { entityType: "voucher", action: "voucher.issue" },
  },
  async ({ body, session, audit }) => {
    // The minimum validity is a legal guard rail, not a preference: Italian law constrains
    // how short a gift voucher may be and the salon's commercialista owns that number.
    // A manager may issue vouchers; only the owner may issue one that ignores the floor.
    if (body.overrideMinimumValidity && session.role !== "owner") {
      throw httpError("FORBIDDEN", {
        message: "Only the owner may issue a voucher below the minimum validity.",
        logMessage: `role ${session.role} attempted overrideMinimumValidity`,
      });
    }

    if (body.issuedToCustomerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: body.issuedToCustomerId },
        select: { id: true },
      });
      if (!customer) {
        throw httpError("NOT_FOUND", { logMessage: "issuedToCustomerId does not exist" });
      }
    }

    const voucher = await withVoucherErrors(() => voucherService.issue(body));

    audit.setEntityId(voucher.id);
    // Never the default `after` (the request body is fine, but be explicit) and never the
    // code: an AuditLog row is readable by every operator and would be a spendable copy.
    audit.setAfter({
      id: voucher.id,
      codeSuffix: voucher.code.slice(-CODE_SUFFIX_LENGTH),
      initialCents: voucher.initialCents,
      currency: voucher.currency,
      expiresAt: voucher.expiresAt,
      issuedToCustomerId: voucher.issuedToCustomerId,
      overrideMinimumValidity: body.overrideMinimumValidity,
    });

    // The only time the full code is returned in bulk context: it has to be written onto
    // the physical card. no-store keeps it out of any intermediary cache.
    return NextResponse.json(
      { data: { ...voucher, expiryPolicy: voucherExpiryPolicy() } },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
