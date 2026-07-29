import { createStaffFeedToken } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { HttpError, adminRoute } from "../../../../lib/admin-api";

/**
 * The subscription lives at apps/web `/api/calendar/[token]`, so the URL is assembled here
 * rather than with `staffFeedUrl()` from @hair-simo/core, which still points at the
 * `/api/calendar/staff/<token>.ics` shape that route does not serve. See openIssues.
 */
const FEED_PATH = "/api/calendar";
const DEFAULT_BASE_URL = "http://localhost:3000";

const feedUrlQuerySchema = z
  .object({
    staffId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "Invalid staff id.")
      .optional(),
  })
  .strict();

type StaffTarget = { id: string; displayName: string; active: boolean };

function feedUrls(staffId: string): { feedUrl: string; webcalUrl: string } {
  const base = (process.env.NEXT_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const feedUrl = `${base}${FEED_PATH}/${createStaffFeedToken(staffId)}.ics`;
  return { feedUrl, webcalUrl: feedUrl.replace(/^https?:/, "webcal:") };
}

async function ownStaffProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.staffProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

async function loadStaffTarget(staffId: string): Promise<StaffTarget | null> {
  const staff = await prisma.staffProfile.findUnique({
    where: { id: staffId },
    select: { id: true, displayName: true, user: { select: { active: true } } },
  });
  if (!staff) return null;
  return { id: staff.id, displayName: staff.displayName, active: staff.user?.active ?? false };
}

/**
 * The feed URL for a staff member, so the back office can show it next to a "subscribe"
 * button. The token in that URL is a long-lived read credential for that stylist's whole
 * calendar and cannot be revoked individually, which is why:
 *
 *   - owner and manager may look up any staff member, because they already see every
 *     appointment in the back office anyway,
 *   - a `staff` session only ever receives its own URL. Passing someone else's id is a 403,
 *     not a silent substitution, so a mis-wired UI is visible instead of leaking,
 *   - the limiter is `adminSensitive`: a compromised session cannot walk the staff table
 *     and collect every subscription token.
 *
 * A GET writes no AuditLog row — `adminRoute` audits mutations only — so the disclosure is
 * recorded in the structured log instead. See openIssues.
 */
export const GET = adminRoute<unknown, z.infer<typeof feedUrlQuerySchema>>(
  {
    roles: ["owner", "manager", "staff"],
    route: "/api/calendar/feed-url",
    policy: "adminSensitive",
    query: feedUrlQuerySchema,
  },
  async ({ query, session, log }) => {
    const requested = query.staffId;
    const restricted = session.role === "staff";

    let staffId = requested;
    if (!staffId || restricted) {
      const own = await ownStaffProfileId(session.userId);
      if (!own) {
        throw new HttpError("NOT_FOUND", {
          message: "This account has no team profile with a calendar feed.",
          logMessage: `user ${session.userId} has no staff profile`,
        });
      }
      if (restricted && requested && requested !== own) {
        throw new HttpError("FORBIDDEN", {
          message: "You can only see your own calendar feed.",
          logMessage: `staff ${own} requested the feed url of ${requested}`,
        });
      }
      staffId = own;
    }

    const staff = await loadStaffTarget(staffId);
    if (!staff || !staff.active) {
      throw new HttpError("NOT_FOUND", {
        message: "The requested team member has no calendar feed.",
        logMessage: `staff ${staffId} is missing or deactivated`,
      });
    }

    log.info("staff calendar feed url issued", { staffId: staff.id, actorRole: session.role });

    return { data: { staffId: staff.id, displayName: staff.displayName, ...feedUrls(staff.id) } };
  },
);
