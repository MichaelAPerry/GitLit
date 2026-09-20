import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTransport } from "@gitlit/mail";

process.env.NODE_ENV = "test";

vi.mock("./gitd-client.js", () => ({
  gitd: {
    createRepo: vi.fn(async () => ({ gitdir: "/tmp/x", publicKey: "pk" })),
  },
}));

const { app, mailer } = await import("./index.js");
await app.ready();

const outbox = mailer.transport as MemoryTransport;

/** The whole point of this file: the token an author receives is the one that works. */
function linkFrom(text: string): URL {
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) throw new Error("no link in the email");
  return new URL(match[0]);
}

beforeEach(() => { outbox.clear(); });

describe("signing in by email", () => {
  it("actually sends a message to the address that asked", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/auth/magic-link",
      payload: { email: "nadia@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.last()!.to).toBe("nadia@example.com");
    expect(outbox.last()!.subject).toContain("sign-in link");
  });

  it("emails a link that completes a real sign-in", async () => {
    await app.inject({
      method: "POST", url: "/v1/auth/magic-link",
      payload: { email: "roper@example.com" },
    });

    const url = linkFrom(outbox.last()!.text);
    expect(url.pathname).toBe("/signin");
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();

    const session = await app.inject({
      method: "POST", url: "/v1/auth/session", payload: { token },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe("roper@example.com");
  });

  it("emails a link that works only once", async () => {
    await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "once@example.com" } });
    const token = linkFrom(outbox.last()!.text).searchParams.get("token");

    expect((await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } })).statusCode).toBe(401);
  });

  it("sends to an unknown address too — the reply must not depend on it", async () => {
    await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "stranger@example.com" } });
    expect(outbox.sent).toHaveLength(1);
  });

  it("reports a send failure instead of claiming a link is on its way", async () => {
    outbox.failNext = new Error("provider down");
    const res = await app.inject({
      method: "POST", url: "/v1/auth/magic-link", payload: { email: "nadia@example.com" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().detail).toMatch(/could not send/i);
    expect(res.json().detail).not.toMatch(/nadia@example.com/);
  });

  it("never puts the token or the address in the response of a failed send", async () => {
    outbox.failNext = new Error("provider down");
    const res = await app.inject({
      method: "POST", url: "/v1/auth/magic-link", payload: { email: "leak@example.com" },
    });
    expect(res.body).not.toContain("glm_");
  });

  it("rejects an address that is not one", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/auth/magic-link", payload: { email: "not-an-address" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(outbox.sent).toHaveLength(0);
  });
});

describe("malformed requests", () => {
  it("is a 400 with the offending field, not a 500", async () => {
    // Found by a deploy rehearsal: a missing field came back as
    // "Internal error", which tells an author nothing and fills an
    // operator's error monitoring with alarms nobody caused.
    const res = await app.inject({
      method: "POST", url: "/v1/auth/magic-link", payload: { email: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe("Invalid request");
    expect(res.json().detail).toContain("email");
  });

  it("names every missing field, not just the first", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/session", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("token");
  });
});
