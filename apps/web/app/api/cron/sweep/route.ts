import {
  RecurringService,
  ReviewRequestService,
  SWEEP_BATCH_SIZE,
  WaitlistService,
  dataRetentionService,
  expireUnverifiedBefore,
  releaseOrphanedUnverified,
} from "@hair-simo/core";
import { forEachActiveTenant } from "@hair-simo/db";
import { z } from "zod";
import { apiRoute, type ApiLogger } from "../../../../lib/api-handler";

const waitlistService = new WaitlistService();
const reviewService = new ReviewRequestService();
const recurringService = new RecurringService();

const CRON_BODY_LIMIT_BYTES = 1_024;

/**
 * `limit` is the only knob a caller gets, and it is capped at the service's own batch size.
 * There is deliberately no `now` or `cutoff` field: a caller-supplied cutoff would let one
 * leaked cron credential cancel every pending booking in the calendar in a single request.
 */
const sweepSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(SWEEP_BATCH_SIZE).default(SWEEP_BATCH_SIZE),
  })
  .strict();

export type SweepJobResult = {
  job: string;
  ok: boolean;
  count: number;
  durationMs: number;
  error?: string;
};

/**
 * One job may not take the sweep down with it: the jobs are independent, and a run that
 * aborts halfway leaves the remaining slots held until the next tick. Failures are reported
 * per job and logged with their real reason; the response carries a fixed code only.
 */
async function runJob(
  job: string,
  work: () => Promise<number>,
  log: ApiLogger,
): Promise<SweepJobResult> {
  const startedAt = Date.now();
  try {
    const count = await work();
    return { job, ok: true, count, durationMs: Date.now() - startedAt };
  } catch (error) {
    log.error("sweep job failed", {
      job,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      job,
      ok: false,
      count: 0,
      durationMs: Date.now() - startedAt,
      error: "JOB_FAILED",
    };
  }
}

async function acrossTenants(work: () => Promise<number>): Promise<number> {
  let total = 0;
  await forEachActiveTenant(async () => {
    total += await work();
  });
  return total;
}

/**
 * The periodic maintenance run. Same shared secret and same fail-closed contract as
 * /api/cron/reminders: apiRoute calls requireSharedSecret at module init, so a production
 * deployment without GCP_CLOUD_TASKS_SECRET / CRON_SECRET fails at boot rather than
 * exposing an open endpoint.
 *
 * Each job runs once per active tenant so multi-salon rows are not skipped.
 *
 * Safe to run concurrently with itself and with a customer acting on the same booking:
 * every release inside booking-verification-service is a conditional UPDATE guarded by
 * `status: "pending"`, so two overlapping runs may both do work but the loser sees
 * `count === 0` and neither writes a duplicate history row nor double-counts a slot. The
 * counts below are therefore "slots this run actually released", not "rows examined".
 *
 * The response is 200 even when a job failed, and `failed` carries the count: Cloud
 * Scheduler retrying a partial failure would re-run the jobs that already succeeded for no
 * gain, and the next scheduled tick picks up whatever was left behind. Alerting keys on
 * `failed > 0` and on the ERROR log line, not on the HTTP status.
 */
export const POST = apiRoute<z.infer<typeof sweepSchema>>(
  {
    route: "/api/cron/sweep",
    methods: ["POST"],
    policy: "internal",
    sharedSecret: "cron",
    bodyLimitBytes: CRON_BODY_LIMIT_BYTES,
    schema: sweepSchema,
  },
  async ({ body, log }) => {
    const ranAt = new Date();
    const limit = body.limit;

    const jobs: SweepJobResult[] = [
      await runJob(
        "expire-unverified",
        () => acrossTenants(() => expireUnverifiedBefore(ranAt, { limit })),
        log,
      ),
      await runJob(
        "release-orphaned-unverified",
        () => acrossTenants(() => releaseOrphanedUnverified(ranAt, { limit })),
        log,
      ),
      await runJob(
        "waitlist-expire",
        () =>
          acrossTenants(async () => {
            const result = await waitlistService.expire(ranAt);
            return (
              result.releasedOffers + result.expiredWindows + result.cancelledForErasedCustomers
            );
          }),
        log,
      ),
      await runJob(
        "review-dispatch",
        () =>
          acrossTenants(async () => {
            const result = await reviewService.dispatchDue({ now: ranAt, limit });
            return result.sent + result.simulated;
          }),
        log,
      ),
      await runJob(
        "data-retention",
        () =>
          acrossTenants(async () => {
            const result = await dataRetentionService.sweep({ now: ranAt, batchSize: limit });
            return result.removed + result.redacted;
          }),
        log,
      ),
      await runJob(
        "recurring-materialise",
        () =>
          acrossTenants(async () => {
            const result = await recurringService.materialiseDue(ranAt);
            return result.booked + result.moved;
          }),
        log,
      ),
    ];

    const failed = jobs.filter((entry) => !entry.ok).length;
    if (failed > 0) {
      log.error("sweep finished with failing jobs", {
        failed,
        failedJobs: jobs.filter((entry) => !entry.ok).map((entry) => entry.job),
      });
    }

    return { data: { ranAt: ranAt.toISOString(), limit, failed, jobs } };
  },
);
