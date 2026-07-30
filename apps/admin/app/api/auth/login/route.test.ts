import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLoginThrottle } from "../../../../lib/login-throttle";

const login = vi.fn();
const loginWithFirebase = vi.fn();

vi.mock("@hair-simo/core", () => ({
  AuthService: class {
    login = login;
    loginWithFirebase = loginWithFirebase;
  },
}));

const { POST, DELETE } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const PASSWORD = "correct-horse-battery-staple";

const SESSION = {
  userId: "usr_1",
  email: "owner@hairsimo.it",
  role: "owner",
  firstName: "Simo",
  lastName: "Rossi",
};

function loginRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetLoginThrottle();
  login.mockReset();
  loginWithFirebase.mockReset();
  login.mockResolvedValue({ session: SESSION, token: "jwt.session.token" });
  loginWithFirebase.mockResolvedValue({ session: SESSION, idToken: "firebase.id.token" });
});

afterEach(() => {
  resetLoginThrottle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/login", () => {
  it("returns the session and puts the token in an httpOnly cookie, never in the body", async () => {
    const response = await POST(loginRequest({ email: SESSION.email, password: PASSWORD }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ data: { session: SESSION, provider: "local-jwt" } });
    expect(JSON.stringify(body)).not.toContain("jwt.session.token");
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    const cookie = response.cookies.get("admin_token");
    expect(cookie?.value).toBe("jwt.session.token");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });

  it("marks the session cookie secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(loginRequest({ email: SESSION.email, password: PASSWORD }));
    expect(response.cookies.get("admin_token")?.secure).toBe(true);
  });

  it("takes the Identity Platform path when an id token is presented", async () => {
    const response = await POST(loginRequest({ idToken: "firebase.raw.token" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { provider: "identity-platform" } });
    expect(login).not.toHaveBeenCalled();
  });

  it("answers a wrong password with a fixed 401 that says nothing about the account", async () => {
    login.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    const wrongPassword = await POST(loginRequest({ email: SESSION.email, password: "wrong" }));
    expect(wrongPassword.status).toBe(401);
    const wrongPasswordBody = await wrongPassword.json();

    login.mockRejectedValue(new Error("USER_NOT_FOUND"));
    const unknownUser = await POST(
      loginRequest(
        { email: "ghost@example.com", password: "wrong" },
        { "x-forwarded-for": "198.51.100.4, 35.191.10.1" },
      ),
    );
    expect(unknownUser.status).toBe(401);
    expect(await unknownUser.json()).toEqual(wrongPasswordBody);
    expect(wrongPasswordBody).toEqual({ error: "LOGIN_FAILED", message: "INVALID_CREDENTIALS" });
  });

  it("never leaks a configuration failure or a stack frame through the login error", async () => {
    login.mockRejectedValue(
      new Error(
        "ADMIN_JWT_SECRET_MISSING: set it before starting the service " +
          "at /app/packages/core/src/auth-service.ts:71",
      ),
    );
    const response = await POST(loginRequest({ email: SESSION.email, password: PASSWORD }));
    const body = await response.json();
    expect(response.status).toBe(401);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("ADMIN_JWT_SECRET_MISSING");
    expect(encoded).not.toContain("/app/packages");
    expect(response.cookies.get("admin_token")).toBeUndefined();
  });

  it("answers malformed JSON with the same fixed 401", async () => {
    const response = await POST(loginRequest("{ not json"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "LOGIN_FAILED",
      message: "INVALID_CREDENTIALS",
    });
    expect(login).not.toHaveBeenCalled();
  });

  it("throttles repeated failures with 429 and a retry-after header", async () => {
    login.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    const attempt = () => POST(loginRequest({ email: SESSION.email, password: "wrong" }));

    for (let index = 0; index < 4; index += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.json()).toEqual({
      error: "TOO_MANY_ATTEMPTS",
      message: "TOO_MANY_ATTEMPTS",
    });
  });

  it("throttles on the account as well as the address, so rotating the source does not help", async () => {
    login.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    for (let index = 0; index < 4; index += 1) {
      await POST(
        loginRequest(
          { email: SESSION.email, password: "wrong" },
          { "x-forwarded-for": `10.0.0.${index}, 35.191.10.1` },
        ),
      );
    }

    const fromFreshAddress = await POST(
      loginRequest(
        { email: SESSION.email, password: "wrong" },
        { "x-forwarded-for": "10.0.0.200, 35.191.10.1" },
      ),
    );
    expect(fromFreshAddress.status).toBe(429);
  });

  it("clears the counter after a successful login", async () => {
    login.mockRejectedValueOnce(new Error("INVALID_CREDENTIALS"));
    await POST(loginRequest({ email: SESSION.email, password: "wrong" }));
    expect((await POST(loginRequest({ email: SESSION.email, password: PASSWORD }))).status).toBe(
      200,
    );

    login.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    for (let index = 0; index < 4; index += 1) {
      expect((await POST(loginRequest({ email: SESSION.email, password: "wrong" }))).status).toBe(
        401,
      );
    }
  });

  it("cannot be forced onto a fresh bucket by forging the leftmost forwarded-for entry", async () => {
    login.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    for (let index = 0; index < 4; index += 1) {
      await POST(
        loginRequest(
          { password: "wrong" },
          { "x-forwarded-for": `172.16.0.${index}, ${CLOUD_RUN_CHAIN}` },
        ),
      );
    }

    const forged = await POST(
      loginRequest(
        { password: "wrong" },
        { "x-forwarded-for": `172.16.0.250, ${CLOUD_RUN_CHAIN}` },
      ),
    );
    expect(forged.status).toBe(429);
  });
});

describe("DELETE /api/auth/login", () => {
  it("expires the session cookie", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.cookies.get("admin_token");
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.httpOnly).toBe(true);
  });
});
