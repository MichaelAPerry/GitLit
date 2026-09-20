import { describe, expect, it } from "vitest";
import { initMonitoring } from "./sentry.js";
import { REDACTED, scrubUrl, scrubValue } from "./scrub.js";

const TOKEN = `glm_0123456789abcdef01_${"a".repeat(64)}`;

describe("monitoring is optional", () => {
  it("stays off without a DSN, and says so", () => {
    // Local development and the test suite must not depend on a third party
    // being reachable, and a stack that refuses to run without an error
    // tracker has made the tracker a dependency of the product.
    expect(initMonitoring({ service: "api", env: {} })).toBe(false);
    expect(initMonitoring({ service: "api", env: { SENTRY_DSN: "   " } })).toBe(false);
  });
});

/**
 * The beforeSend pipeline, applied to an event shaped the way the SDK builds
 * them. Testing the scrubber alone would not catch a field the wrapper forgets
 * to run it over.
 */
function scrubEvent(event: Record<string, unknown>): Record<string, unknown> {
  const request = event.request as Record<string, unknown> | undefined;
  if (request?.url) request.url = scrubUrl(String(request.url));
  delete request?.cookies;
  delete request?.data;
  delete event.user;
  return scrubValue(event);
}

describe("what a Sentry event may carry", () => {
  const event = () => ({
    message: `sign-in failed for mara@example.com`,
    request: {
      url: `https://gitlit.app/signin?token=${TOKEN}`,
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "gitlit_session=abc" },
      cookies: { gitlit_session: "abc" },
      data: { content: "The lighthouse had been dark for a year." },
    },
    user: { id: "u_01", email: "mara@example.com", ip_address: "203.0.113.4" },
    extra: { content: "a whole chapter", repoId: "repo_01ABC" },
  });

  it("carries no credential anywhere in the event", () => {
    expect(JSON.stringify(scrubEvent(event()))).not.toContain("a".repeat(64));
  });

  it("carries no email address anywhere in the event", () => {
    expect(JSON.stringify(scrubEvent(event()))).not.toContain("mara@example.com");
  });

  it("carries no manuscript prose", () => {
    const out = JSON.stringify(scrubEvent(event()));
    expect(out).not.toContain("The lighthouse had been dark");
    expect(out).not.toContain("a whole chapter");
  });

  it("drops the user block rather than trusting it to be scrubbed", () => {
    expect(scrubEvent(event()).user).toBeUndefined();
  });

  it("drops cookies and the request body outright", () => {
    const req = scrubEvent(event()).request as Record<string, unknown>;
    expect(req.cookies).toBeUndefined();
    expect(req.data).toBeUndefined();
  });

  it("redacts the Authorization header", () => {
    const req = scrubEvent(event()).request as Record<string, unknown>;
    expect((req.headers as Record<string, string>).authorization).toBe(REDACTED);
  });

  it("keeps what makes the error diagnosable", () => {
    // Scrubbing everything would be safe and useless. The repo id is an
    // opaque identifier, and it is how an operator finds the failure.
    const out = scrubEvent(event()).extra as Record<string, unknown>;
    expect(out.repoId).toBe("repo_01ABC");
  });

  it("leaves the path readable after redacting the query", () => {
    const req = scrubEvent(event()).request as Record<string, unknown>;
    expect(String(req.url)).toContain("gitlit.app/signin");
    expect(String(req.url)).not.toContain("a".repeat(64));
  });
});
