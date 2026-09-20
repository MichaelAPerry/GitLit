import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADDRESS_MAX, AUTH_MAX, KeyedLimiter, resetRateLimits } from "./rate-limit.js";

process.env.NODE_ENV = "test";

vi.mock("./gitd-client.js", () => ({
  gitd: {
    createRepo: vi.fn(async () => ({ gitdir: "/tmp/x", publicKey: "pk" })),
    readBlob: vi.fn(async (_r: string, path: string) => ({ path, content: "A sentence." })),
  },
}));

const { app } = await import("./index.js");
await app.ready();

const post = (url: string, payload: Record<string, unknown>, ip = "203.0.113.9") =>
  app.inject({ method: "POST", url, payload, headers: { "x-forwarded-for": ip } });

/**
 * Both limits are live at once, and `inject` gives every request the same
 * source address, so without this the per-IP limit fires partway through a
 * per-address test and masks what is being checked.
 */
const resetLimits = () => resetRateLimits();

describe("the per-IP limit", () => {
  beforeEach(resetLimits);

  it("refuses a script hammering the sign-in route from one place", async () => {
    const codes: number[] = [];
    for (let i = 0; i < AUTH_MAX + 2; i++) {
      codes.push((await post("/v1/auth/session", { token: "glm_bad" })).statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).not.toBe(429);
  });
});

describe("the per-address limit", () => {
  beforeEach(resetLimits);

  it("stops a flood of links aimed at one inbox", async () => {
    // The attack an IP limit cannot see: every request from a different host,
    // all of them asking GitLit to mail the same victim.
    const codes: number[] = [];
    for (let i = 0; i < ADDRESS_MAX + 2; i++) {
      const res = await post("/v1/auth/magic-link", { email: "victim@example.com" }, `198.51.100.${i}`);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, ADDRESS_MAX).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("tells the caller when to come back", async () => {
    for (let i = 0; i < ADDRESS_MAX; i++) {
      await post("/v1/auth/magic-link", { email: "retry@example.com" }, `198.51.100.${i}`);
    }
    const res = await post("/v1/auth/magic-link", { email: "retry@example.com" }, "198.51.100.99");
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not punish a different address", async () => {
    for (let i = 0; i < ADDRESS_MAX + 1; i++) {
      await post("/v1/auth/magic-link", { email: "noisy@example.com" }, `198.51.100.${i}`);
    }
    const other = await post("/v1/auth/magic-link", { email: "quiet@example.com" }, "198.51.100.50");
    expect(other.statusCode).toBe(200);
  });

  it("treats Mara@Example.com and mara@example.com as one address", async () => {
    for (let i = 0; i < ADDRESS_MAX; i++) {
      await post("/v1/auth/magic-link", { email: "Mara@Example.com" }, `198.51.100.${i}`);
    }
    const res = await post("/v1/auth/magic-link", { email: "mara@example.com" }, "198.51.100.77");
    expect(res.statusCode).toBe(429);
  });

  it("stays useless for enumeration: same 429 for a known and an unknown address", async () => {
    const codes: number[] = [];
    for (const email of ["known@example.com", "known@example.com", "known@example.com", "known@example.com"]) {
      codes.push((await post("/v1/auth/magic-link", { email })).statusCode);
    }
    const known = codes.at(-1);
    for (let i = 0; i < ADDRESS_MAX + 1; i++) {
      await post("/v1/auth/magic-link", { email: "stranger@example.com" });
    }
    const unknown = (await post("/v1/auth/magic-link", { email: "stranger@example.com" })).statusCode;
    expect(known).toBe(unknown);
  });
});

describe("what must never be rate limited", () => {
  beforeEach(resetLimits);

  it("lets the platform poll /health without limit", async () => {
    // Fly checks this every 15s across every machine. Limiting it takes the
    // service out of rotation, which is the opposite of what a health check
    // is for.
    for (let i = 0; i < 400; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      if (res.statusCode !== 200) throw new Error(`health limited after ${i}`);
    }
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("does not limit the Git authorization callback", async () => {
    // gitd calls this once per Git transport request, all from one internal
    // address. A limit here does not slow an attacker — it breaks `git clone`
    // for every author at once.
    let limited = 0;
    for (let i = 0; i < 400; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/internal/git-access",
        payload: { owner: "x", slug: "y", capability: "repo:read" },
        headers: { "x-forwarded-for": "172.16.0.2" },
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBe(0);
  });
});

describe("the keyed limiter itself", () => {
  it("allows exactly max within a window, then refuses", () => {
    const l = new KeyedLimiter(3, 1000, () => 0);
    expect([l.take("k"), l.take("k"), l.take("k"), l.take("k")]).toEqual([true, true, true, false]);
  });

  it("lets the key through again once the window passes", () => {
    let now = 0;
    const l = new KeyedLimiter(1, 1000, () => now);
    expect(l.take("k")).toBe(true);
    expect(l.take("k")).toBe(false);
    now = 1001;
    expect(l.take("k")).toBe(true);
  });

  it("does not grow without bound as keys expire", () => {
    // An in-memory limiter that leaks is a denial of service wearing the
    // costume of a defence.
    let now = 0;
    const l = new KeyedLimiter(1, 1000, () => now);
    for (let i = 0; i < 5000; i++) { l.take(`addr${i}@example.com`); now += 1; }
    now += 2000;
    l.take("one-more@example.com");
    expect(l.size).toBeLessThan(10);
  });

  it("keeps separate keys separate", () => {
    const l = new KeyedLimiter(1, 1000, () => 0);
    expect(l.take("a")).toBe(true);
    expect(l.take("b")).toBe(true);
    expect(l.take("a")).toBe(false);
  });
});

describe("the auth limit exists", () => {
  it("is tighter than the global one", () => {
    expect(AUTH_MAX).toBeLessThan(300);
  });
});
