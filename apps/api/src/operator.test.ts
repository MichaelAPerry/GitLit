import { beforeEach, describe, expect, it, vi } from "vitest";
import { operatorState } from "./operator.js";

process.env.NODE_ENV = "test";

vi.mock("./gitd-client.js", () => ({ gitd: { createRepo: vi.fn() } }));

const { resetRateLimits } = await import("./rate-limit.js");
const { app } = await import("./index.js");
await app.ready();

beforeEach(() => { resetRateLimits(); delete process.env.OPERATOR_TOKEN; });

const get = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/v1/operator/state", headers });

describe("who may read the operator surface", () => {
  it("is unavailable when no operator token is configured", async () => {
    // Unset means off, not open. A surface that defaults to reachable is
    // worse than one that does not exist.
    expect((await get({ authorization: "Bearer anything" })).statusCode).toBe(403);
  });

  it("refuses a request with no credential", async () => {
    process.env.OPERATOR_TOKEN = "op_secret";
    expect((await get()).statusCode).toBe(403);
  });

  it("refuses a wrong credential", async () => {
    process.env.OPERATOR_TOKEN = "op_secret";
    expect((await get({ authorization: "Bearer op_wrong" })).statusCode).toBe(403);
  });

  it("refuses an author's ordinary session — this is not for whoever is signed in", async () => {
    process.env.OPERATOR_TOKEN = "op_secret";
    const { auth } = await import("./auth-plugin.js");
    const { sessionToken } = (await auth.consumeMagicLink(
      (await auth.issueMagicLink("someone@example.com")).token,
    ))!;
    expect((await get({ authorization: `Bearer ${sessionToken}` })).statusCode).toBe(403);
  });

  it("allows the operator token", async () => {
    process.env.OPERATOR_TOKEN = "op_secret";
    expect((await get({ authorization: "Bearer op_secret" })).statusCode).toBe(200);
  });
});

describe("what the operator surface may say", () => {
  const env = {
    NODE_ENV: "production",
    RESEND_API_KEY: "re_live_SECRETVALUE",
    MAIL_FROM: "GitLit <hello@gitlit.app>",
    PUBLIC_WEB_URL: "https://gitlit.app",
    GITD_SERVICE_TOKEN: "SUPERSECRETSERVICETOKEN",
  } as NodeJS.ProcessEnv;

  const state = () => operatorState({
    corsOrigins: ["https://gitlit.app"], monitoring: true, migrationsApplied: true, env,
  });

  it("reports THAT mail is configured, never the key", () => {
    const body = JSON.stringify(state());
    expect(state().mail.configured).toBe(true);
    expect(body).not.toContain("re_live_SECRETVALUE");
  });

  it("reports whether the service token is the example one, never the token", () => {
    const body = JSON.stringify(state());
    expect(state().serviceTokenIsDefault).toBe(false);
    expect(body).not.toContain("SUPERSECRETSERVICETOKEN");
  });

  it("recognises the published example token", () => {
    const s = operatorState({
      corsOrigins: [], monitoring: false, migrationsApplied: true,
      env: { ...env, GITD_SERVICE_TOKEN: "dev-service-token-change-me" },
    });
    expect(s.serviceTokenIsDefault).toBe(true);
  });

  it("carries no secret-shaped value at all", async () => {
    process.env.OPERATOR_TOKEN = "op_secret";
    const body = (await get({ authorization: "Bearer op_secret" })).body;
    expect(body).not.toMatch(/re_[A-Za-z0-9]{8}/);
    expect(body).not.toContain("op_secret");
    expect(body).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("pulls the sending domain out of a display-name address", () => {
    expect(state().mail.fromDomain).toBe("gitlit.app");
  });
});
