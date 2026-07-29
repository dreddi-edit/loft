import { VoucherService } from "@hair-simo/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute } from "../../../../lib/api-handler";

const voucherService = new VoucherService();

/** A printed code is 12 characters plus two hyphens; the slack absorbs stray spacing. */
const MAX_SUBMITTED_CODE_LENGTH = 64;

const querySchema = z.object({
  code: z.string().trim().min(1).max(MAX_SUBMITTED_CODE_LENGTH),
});

/**
 * A voucher code is a bearer credential: whoever types it is treated as the holder, so this
 * endpoint cannot ask for anything else. That makes throttling the entire access control.
 *
 * The `contact` policy is the strictest one in rate-limit.ts (3 + 2 burst per hour per
 * client IP) and it is what this route uses, under its own key namespace so a balance
 * lookup and the contact form do not eat each other's allowance. An honest bearer needs
 * one request; a scanner gets five an hour from one address. Combined with the ~9.5e14 live
 * code space that is not a search anybody finishes, and malformed codes are rejected in
 * memory by parseVoucherCode so a scanner never reaches the database at all.
 *
 * The residual side channel is timing: a malformed code answers without a query, a
 * well-formed one costs a lookup. All that leaks is the checksum rule, which at best turns
 * 23^12 guesses into 23^11 — still nine hundred trillion.
 */
const RATE_LIMIT_NAMESPACE = "voucher-balance";

const NO_SUCH_VOUCHER = "No voucher matches this code.";

/**
 * Wrong shape, wrong check character and no such voucher must be one answer. Telling a
 * caller that a code was well formed but unknown confirms the alphabet and the checksum for
 * free, and telling them a code exists but is blocked is already a disclosure about
 * somebody else's card.
 */
const INDISTINGUISHABLE_FAILURES: ReadonlySet<string> = new Set([
  "VOUCHER_CODE_MALFORMED",
  "VOUCHER_CODE_CHECKSUM_FAILED",
  "VOUCHER_NOT_FOUND",
]);

function noSuchVoucher(error: Error): HttpError {
  return new HttpError("NOT_FOUND", {
    message: NO_SUCH_VOUCHER,
    cause: error,
    logMessage: `voucher balance lookup rejected: ${error.message}`,
  });
}

export const GET = apiRoute<unknown, z.infer<typeof querySchema>>(
  {
    route: "/api/vouchers/balance",
    methods: ["GET"],
    policy: "contact",
    rateLimitKey: ({ clientIp }) => `${RATE_LIMIT_NAMESPACE}:${clientIp.key}`,
    query: querySchema,
  },
  async ({ query }) => {
    let balance;
    try {
      balance = await voucherService.balance(query.code);
    } catch (error) {
      if (error instanceof Error && INDISTINGUISHABLE_FAILURES.has(error.message)) {
        throw noSuchVoucher(error);
      }
      throw error;
    }

    // Deliberately not the whole VoucherBalance: `code` and `displayCode` would put the
    // credential back into a response that proxies and browsers may cache, and
    // `initialCents` is what the buyer paid, which is the gift giver's business.
    return NextResponse.json(
      {
        data: {
          remainingCents: balance.remainingCents,
          currency: balance.currency,
          status: balance.status,
          expiresAt: balance.expiresAt,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
);
