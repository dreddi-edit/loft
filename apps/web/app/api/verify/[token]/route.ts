import { VERIFICATION_CANCELLED, VERIFICATION_INVALID, verifyBookingToken } from "@hair-simo/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRoute } from "../../../../lib/api-handler";

type TokenParams = { token: string };

/**
 * What the customer is told, in their own language, by /[locale]/verify/[token].
 *
 * `invalid` deliberately merges "unknown", "expired" and "superseded by a newer link":
 * booking-verification-service raises one error for all three so the endpoint cannot be
 * used as an oracle for "does this booking exist", and splitting them here would put the
 * oracle back. `pending` means we recognised an automated fetch and did NOT redeem.
 */
export type VerifyStatus = "confirmed" | "already_confirmed" | "invalid" | "cancelled" | "pending";

/** Mirrors the token shape issued by createVerificationToken (32 bytes, base64url). */
const tokenSchema = z.string().trim().min(16).max(512);

/**
 * Headers a browser or a mail client sets when it is fetching a link speculatively rather
 * than because a human clicked it. Chrome/Edge send `Sec-Purpose: prefetch;prerender`,
 * Firefox `X-Moz: prefetch`, Safari and older Chrome `X-Purpose: preview` / `Purpose:
 * prefetch`.
 */
const PROBE_PURPOSE_HEADERS = ["sec-purpose", "purpose", "x-purpose", "x-moz"] as const;
const PROBE_PURPOSE_VALUES = ["prefetch", "prerender", "preview"];

/**
 * A redeeming GET is the one thing this endpoint must not do for a machine. Outlook
 * SafeLinks, Proofpoint and Gmail's fetchers all follow every URL in an inbound mail, so a
 * naive implementation confirms the booking before the customer has read the message and
 * the double opt-in proves nothing.
 *
 * Two defences. The declared-intent headers above are the explicit signal. `Sec-Fetch-Dest`
 * is the implicit one: the only caller that legitimately redeems is the verify page's own
 * `fetch()`, which is `empty`; a scanner or an address-bar visit arrives as `document`,
 * `iframe`, `image` and so on. A missing header means an old or stripped-down client and is
 * allowed through, because verifyBookingToken is idempotent — the worst case is the state
 * the customer already reached.
 */
function isAutomatedProbe(headers: Headers): boolean {
  for (const name of PROBE_PURPOSE_HEADERS) {
    const value = headers.get(name)?.toLowerCase();
    if (value && PROBE_PURPOSE_VALUES.some((needle) => value.includes(needle))) return true;
  }
  const destination = headers.get("sec-fetch-dest");
  return destination !== null && destination !== "empty";
}

function verifyResult(status: VerifyStatus): NextResponse {
  return NextResponse.json({ data: { status } }, { headers: { "cache-control": "no-store" } });
}

/**
 * Redeem the double opt-in link.
 *
 * Idempotent by construction: the first redemption answers `confirmed`, every later one
 * `already_confirmed`, and an unknown or expired token `invalid`. Nothing here 400s or
 * 500s on a state the customer can reach on their own, so a reload, a back button or a
 * scanner that got through cannot turn into an error page on top of a confirmed booking.
 */
export const GET = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/verify/[token]",
    methods: ["GET"],
    // `availability` rather than `booking`: the token is 256 bits of CSPRNG output, so the
    // limit is there to bound database work from a scanner or a scripted probe, not to make
    // guessing infeasible. A tighter bucket would lock a customer behind a shared NAT out
    // of their own link for ten minutes after a couple of reloads.
    policy: "availability",
  },
  async ({ req, params, log }) => {
    const parsed = tokenSchema.safeParse(params.token);
    if (!parsed.success) return verifyResult("invalid");

    if (isAutomatedProbe(req.headers)) {
      log.info("verification link fetched by a non-interactive client, token left untouched", {
        secFetchDest: req.headers.get("sec-fetch-dest"),
      });
      return verifyResult("pending");
    }

    try {
      const outcome = await verifyBookingToken(parsed.data);
      return verifyResult(outcome.alreadyVerified ? "already_confirmed" : "confirmed");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === VERIFICATION_INVALID) return verifyResult("invalid");
      if (code === VERIFICATION_CANCELLED) return verifyResult("cancelled");
      throw error;
    }
  },
);

/**
 * Explicit and side-effect free. Without this export the App Router answers HEAD by running
 * GET and dropping the body, which would let any link checker redeem the token.
 */
export const HEAD = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/verify/[token]",
    methods: ["HEAD"],
    policy: "availability",
  },
  () => new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } }),
);
