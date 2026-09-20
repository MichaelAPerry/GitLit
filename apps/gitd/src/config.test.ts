import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Guards that only fail on a deployed machine.
 *
 * Both of these were found by a deploy rehearsal rather than by a test, and
 * both share a failure shape worth naming: the service comes up, answers its
 * health check, and is broken for every real request. A health check that
 * cannot see the fault is worse than no health check, so the fault is moved
 * to startup where a deploy will catch it.
 */
const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("gitd's API url", () => {
  it("refuses to start in production without GITLIT_API_URL", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.GITLIT_API_URL;

    await expect(import("./git-routes.js")).rejects.toThrow(/GITLIT_API_URL must be set/);
  });

  it("explains what breaks, not just what is missing", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.GITLIT_API_URL;

    // The old default resolved to gitd itself, so every clone 500'd while
    // /health stayed green. The message has to say that, or the next person
    // sets it to localhost again.
    await expect(import("./git-routes.js")).rejects.toThrow(/gitd itself/);
  });

  it("accepts the value when it is set", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.GITLIT_API_URL = "http://gitlit-api.internal:4000";

    await expect(import("./git-routes.js")).resolves.toBeDefined();
  });

  it("still defaults to localhost in development", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "development";
    delete process.env.GITLIT_API_URL;

    await expect(import("./git-routes.js")).resolves.toBeDefined();
  });
});
