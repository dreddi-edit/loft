import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { core } = vi.hoisted(() => ({
  core: {
    expireUnverifiedBefore: vi.fn(),
    releaseOrphanedUnverified: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  SWEEP_BATCH_SIZE: 200,
  expireUnverifiedBefore: core.expireUnverifiedBefore,
  releaseOrphanedUnverified: core.releaseOrphanedUnverified,
}));

import { resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../lib/api-handler";
import { resetRateLimitStore } from "../../../../lib/rate-limit";
import { resetSharedSecretWarnings } from "../../../../lib/shared-secret";
import { POST, type SweepJobResult } from "./route";

const SECRET = "b3f0d0e0c9a84a1fb2c1e5d9a7f4c2b6d8e0f1a3";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

type SweepBody = {
  data?: { ranAt: string; limit: number; failed: number; jobs: SweepJobResult[] };
  error?: string;
  message?: string;
};

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  resetSharedSecretWarnings();
  core.expireUnverifiedBefore.mockReset().mockResolvedValue(0);
  core.releaseOrphanedUnverified.mockReset().mockResolvedValue(0);
  vi.stubEnv("GCP_CLOUD_TASKS_SECRET", SECRET);
  vi.stubEnv("CRON_SECRET", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(body: unknown = {}, init: { secret?: string | null } = {}): NextRequest {
  const secret = init.secret === undefined ? SECRET : init.secret;
  return new NextRequest("https://hairsimo.it/api/cron/sweep", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
    },
    body: JSON.stringify(body),
  });
}

function jobsOf(body: SweepBody): Record<string, SweepJobResult> {
  return Object.fromEntries((body.data?.jobs ?? []).map((job) => [job.job, job]));
}

describe("POST /api/cron/sweep auth boundary", () => {
  it("rejects a request without the shared secret", async () => {
    const response = await POST(request({}, { secret: null }));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(core.expireUnverifiedBefore).not.toHaveBeenCalled();
    expect(core.releaseOrphanedUnverified).not.toHaveBeenCalled();
  });

  it("rejects a wrong shared secret", async () => {
    const response = await POST(request({}, { secret: `${SECRET}x` }));

    expect(response.status).toBe(401);
    expect(core.expireUnverifiedBefore).not.toHaveBeenCalled();
  });

  it("accepts the same secret /api/cron/reminders uses", async () => {
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "");
    vi.stubEnv("CRON_SECRET", SECRET);

    expect((await POST(request())).status).toBe(200);
  });

  it("refuses any method other than POST", async () => {
    const response = await POST(
      new NextRequest("https://hairsimo.it/api/cron/sweep", {
        method: "GET",
        headers: { "x-forwarded-for": CLOUD_RUN_CHAIN, authorization: `Bearer ${SECRET}` },
      }),
    );

    expect(response.status).toBe(405);
    expect(core.expireUnverifiedBefore).not.toHaveBeenCalled();
  });

  it("refuses to boot in production without a configured secret", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GCP_CLOUD_TASKS_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");

    await expect(import("./route")).rejects.toThrow(/SHARED_SECRET_MISSING:cron/);
  });
});

describe("POST /api/cron/sweep jobs", () => {
  it("runs both verification jobs and reports per-job counts", async () => {
    core.expireUnverifiedBefore.mockResolvedValue(4);
    core.releaseOrphanedUnverified.mockResolvedValue(1);

    const response = await POST(request());
    const body = (await response.json()) as SweepBody;
    const jobs = jobsOf(body);

    expect(response.status).toBe(200);
    expect(body.data?.failed).toBe(0);
    expect(jobs["expire-unverified"]).toMatchObject({ ok: true, count: 4 });
    expect(jobs["release-orphaned-unverified"]).toMatchObject({ ok: true, count: 1 });
    expect(typeof jobs["expire-unverified"].durationMs).toBe("number");
  });

  it("passes its own clock and the batch cap down to the services", async () => {
    const before = Date.now();
    await POST(request());
    const after = Date.now();

    const [cutoff, options] = core.expireUnverifiedBefore.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    expect((cutoff as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((cutoff as Date).getTime()).toBeLessThanOrEqual(after);
    expect(options).toEqual({ limit: 200 });
    expect(core.releaseOrphanedUnverified.mock.calls[0][0]).toBe(cutoff);
  });

  it("refuses a caller supplied cutoff", async () => {
    const response = await POST(request({ now: "1970-01-01T00:00:00.000Z" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(core.expireUnverifiedBefore).not.toHaveBeenCalled();
  });

  it("bounds the batch size a caller may ask for", async () => {
    expect((await POST(request({ limit: 9_999 }))).status).toBe(400);
    expect((await POST(request({ limit: 0 }))).status).toBe(400);

    const response = await POST(request({ limit: 25 }));
    expect(response.status).toBe(200);
    expect(core.expireUnverifiedBefore).toHaveBeenCalledWith(expect.any(Date), { limit: 25 });
  });

  it("keeps running the remaining jobs when one fails and never returns its message", async () => {
    core.expireUnverifiedBefore.mockRejectedValue(
      new Error("P1001 can't reach db at postgres://simo:hunter2@10.0.0.4:5432"),
    );
    core.releaseOrphanedUnverified.mockResolvedValue(2);

    const response = await POST(request());
    const body = (await response.json()) as SweepBody;
    const jobs = jobsOf(body);

    expect(response.status).toBe(200);
    expect(body.data?.failed).toBe(1);
    expect(jobs["expire-unverified"]).toMatchObject({ ok: false, count: 0, error: "JOB_FAILED" });
    expect(jobs["release-orphaned-unverified"]).toMatchObject({ ok: true, count: 2 });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(
      logs.some((entry) => entry.severity === "ERROR" && entry.job === "expire-unverified"),
    ).toBe(true);
  });

  it("is safe to run concurrently with itself", async () => {
    core.expireUnverifiedBefore.mockResolvedValue(3);
    core.releaseOrphanedUnverified.mockResolvedValue(0);

    const responses = await Promise.all([POST(request()), POST(request())]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(core.expireUnverifiedBefore).toHaveBeenCalledTimes(2);
    expect(core.releaseOrphanedUnverified).toHaveBeenCalledTimes(2);

    const bodies = (await Promise.all(responses.map((response) => response.json()))) as SweepBody[];
    for (const body of bodies) {
      expect(body.data?.failed).toBe(0);
      expect(jobsOf(body)["expire-unverified"].count).toBe(3);
    }
  });
});
