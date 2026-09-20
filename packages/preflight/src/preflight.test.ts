import { describe, expect, it, vi } from "vitest";
import { gitdChecks, internalChecks, type GitdState, type OperatorState } from "./checks.js";
import { runPreflight } from "./runner.js";
import { renderHtml, renderText } from "./render.js";
import { tally, type CheckResult } from "./types.js";

const okHealth = () =>
  new Response(JSON.stringify({ ok: true, service: "api" }), { status: 200 });

/** A fetch that answers /health and lets a test override anything else. */
function stubFetch(routes: Record<string, () => Response> = {}, headers: Record<string, string> = {}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    for (const [match, make] of Object.entries(routes)) {
      if (u.includes(match)) return make();
    }
    if (u.endsWith("/health")) {
      const origin = (init?.headers as Record<string, string> | undefined)?.origin;
      return new Response(JSON.stringify({ ok: true, service: "api" }), {
        status: 200,
        headers: origin ? headers : {},
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const base = { apiUrl: "https://api.gitlit.app", webUrl: "https://gitlit.app" };
const find = (results: CheckResult[], id: string) => results.find((r) => r.id === id)!;

describe("when the API is not there", () => {
  it("says so and stops, rather than reporting nine confusing failures", async () => {
    const report = await runPreflight({
      ...base,
      fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe("fail");
    expect(report.results[0]!.detail).toMatch(/Could not reach/);
  });
});

describe("the CORS checks — the bug that broke the dashboard", () => {
  it("FAILS when the API tells a stranger origin it is allowed", async () => {
    const report = await runPreflight({
      ...base,
      fetch: stubFetch({}, {
        "access-control-allow-origin": "https://preflight-probe.invalid",
        "access-control-allow-credentials": "true",
      }),
    });
    expect(find(report.results, "cors-strangers").status).toBe("fail");
  });

  it("FAILS when the dashboard is allowed but credentials are not", async () => {
    // This is exactly the state the deployment was in: the site would load and
    // then do nothing, because the browser discards every reply.
    const report = await runPreflight({
      ...base,
      fetch: stubFetch({}, { "access-control-allow-origin": "https://gitlit.app" }),
    });
    const r = find(report.results, "cors-dashboard");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/discards every reply/);
  });

  it("passes when the dashboard is allowed with credentials", async () => {
    const report = await runPreflight({
      ...base,
      fetch: stubFetch({}, {
        "access-control-allow-origin": "https://gitlit.app",
        "access-control-allow-credentials": "true",
      }),
    });
    expect(find(report.results, "cors-dashboard").status).toBe("pass");
  });
});

describe("the open-door check", () => {
  it("FAILS loudly when the API hands back a sign-in token", async () => {
    const report = await runPreflight({
      ...base,
      email: "me@example.com",
      fetch: stubFetch({
        "/v1/auth/magic-link": () =>
          new Response(JSON.stringify({ sent: true, devToken: "glm_abc" }), { status: 200 }),
      }),
    });
    const r = find(report.results, "dev-token-leak");
    expect(r.status).toBe("fail");
    expect(r.remedy).toMatch(/NODE_ENV/);
  });

  it("reports a failed send distinctly from a leaked token", async () => {
    const report = await runPreflight({
      ...base,
      email: "me@example.com",
      fetch: stubFetch({ "/v1/auth/magic-link": () => new Response("{}", { status: 502 }) }),
    });
    expect(find(report.results, "dev-token-leak").remedy).toMatch(/Verified at Resend/);
  });

  it("skips rather than guessing when no address is given", async () => {
    const report = await runPreflight({ ...base, fetch: stubFetch() });
    expect(find(report.results, "dev-token-leak").status).toBe("skip");
  });
});

describe("the check that cannot be automated", () => {
  it("asks the human to look instead of reporting a pass", async () => {
    // A tool that claimed the email arrived would be exactly the kind of green
    // light this whole thing exists to distrust.
    const report = await runPreflight({ ...base, email: "me@example.com", fetch: stubFetch() });
    const r = find(report.results, "email-arrives");
    expect(r.status).toBe("warn");
    expect(r.needsHuman).toBe(true);
  });
});

describe("rate limiting", () => {
  it("FAILS when nothing is refused", async () => {
    const report = await runPreflight({
      ...base,
      fetch: stubFetch({ "/v1/auth/session": () => new Response("{}", { status: 401 }) }),
    });
    expect(find(report.results, "rate-limit").status).toBe("fail");
  });

  it("passes as soon as the API starts refusing", async () => {
    let n = 0;
    const report = await runPreflight({
      ...base,
      fetch: stubFetch({ "/v1/auth/session": () => new Response("{}", { status: ++n > 3 ? 429 : 401 }) }),
    });
    expect(find(report.results, "rate-limit").status).toBe("pass");
  });
});

describe("two gitd machines — the one that silently splits the manuscripts", () => {
  it("FAILS when more than one machine answers", async () => {
    let n = 0;
    const report = await runPreflight({
      ...base,
      gitdUrl: "http://gitd:4001",
      fetch: stubFetch({
        "gitd:4001": () => new Response(JSON.stringify({ machine: `m${++n % 2}` }), { status: 200 }),
      }),
    });
    const r = find(report.results, "gitd-one-machine");
    expect(r.status).toBe("fail");
    expect(r.remedy).toMatch(/fly scale count 1/);
  });

  it("passes when one machine answers every probe", async () => {
    const report = await runPreflight({
      ...base,
      gitdUrl: "http://gitd:4001",
      fetch: stubFetch({
        "gitd:4001": () => new Response(JSON.stringify({ machine: "m1" }), { status: 200 }),
      }),
    });
    expect(find(report.results, "gitd-one-machine").status).toBe("pass");
  });
});

describe("the settings checks", () => {
  const good: OperatorState = {
    nodeEnv: "production",
    mail: { configured: true, from: "GitLit <hi@gitlit.app>", fromDomain: "gitlit.app" },
    webUrl: "https://gitlit.app",
    corsOrigins: ["https://gitlit.app"],
    monitoring: true,
    serviceTokenIsDefault: false,
    migrationsApplied: true,
  };

  it("passes a correctly configured deployment", () => {
    expect(tally(internalChecks(good)).fail).toBe(0);
  });

  it("FAILS the example service token, which is published in the repo", () => {
    const r = find(internalChecks({ ...good, serviceTokenIsDefault: true }), "service-token");
    expect(r.status).toBe("fail");
    expect(r.remedy).toMatch(/openssl rand/);
  });

  it("FAILS a non-production NODE_ENV", () => {
    expect(find(internalChecks({ ...good, nodeEnv: "development" }), "node-env").status).toBe("fail");
  });

  it("FAILS when no website origin is configured", () => {
    expect(find(internalChecks({ ...good, corsOrigins: [] }), "cors-configured").status).toBe("fail");
  });

  it("warns when mail is sent from a domain unrelated to the site", () => {
    const r = find(internalChecks({
      ...good, mail: { configured: true, from: "x@gmail.com", fromDomain: "gmail.com" },
    }), "mail-configured");
    expect(r.status).toBe("warn");
    expect(r.remedy).toMatch(/spam/);
  });
});

describe("the gitd checks", () => {
  const good: GitdState = {
    machine: "m1", keysOnDisk: 3, unwrappedKeys: 0, masterKeySet: true, repositories: 3,
    backups: { count: 3, newestAgeHours: 2, newestVerifies: true, directory: "/data/backups" },
  };

  it("FAILS when no master key is set", () => {
    const r = find(gitdChecks({ ...good, masterKeySet: false, unwrappedKeys: 3 }), "signing-keys");
    expect(r.status).toBe("fail");
    expect(r.remedy).toMatch(/password manager/);
  });

  it("FAILS keys written BEFORE the master key was set", () => {
    // Setting it later protects new keys and silently leaves the old ones
    // readable, which is the version of this that actually happens.
    const r = find(gitdChecks({ ...good, unwrappedKeys: 2 }), "signing-keys");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/2 of 3/);
  });

  it("does NOT cry wolf on a fresh deployment with no keys yet", () => {
    // A checker that reports a problem on every new install is one nobody reads.
    const r = find(gitdChecks({ ...good, keysOnDisk: 0, unwrappedKeys: 0, repositories: 0 }), "signing-keys");
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/No keys written yet/);
  });

  it("FAILS when backups exist but the newest is corrupt", () => {
    const r = find(gitdChecks({
      ...good, backups: { ...good.backups, newestVerifies: false },
    }), "backups-restore");
    expect(r.status).toBe("fail");
  });

  it("FAILS when the backup schedule has stopped", () => {
    const r = find(gitdChecks({
      ...good, backups: { ...good.backups, newestAgeHours: 200 },
    }), "backups-exist");
    expect(r.status).toBe("fail");
  });

  it("FAILS when there are books but no backups at all", () => {
    expect(find(gitdChecks({
      ...good, backups: { ...good.backups, count: 0, newestAgeHours: null, newestVerifies: null },
    }), "backups-exist").status).toBe("fail");
  });

  it("does not nag about backups before there is anything to back up", () => {
    expect(find(gitdChecks({
      ...good, repositories: 0,
      backups: { ...good.backups, count: 0, newestAgeHours: null, newestVerifies: null },
    }), "backups-exist").status).toBe("skip");
  });

  it("always says offsite copies cannot be confirmed from here", () => {
    const r = find(gitdChecks(good), "backups-offsite");
    expect(r.needsHuman).toBe(true);
    expect(r.status).toBe("warn");
  });
});

describe("the report itself", () => {
  const report = {
    startedAt: "2026-09-20T00:00:00Z",
    target: "https://api.gitlit.app",
    results: [
      { id: "a", title: "Passing", why: "w", status: "pass" as const, detail: "fine" },
      { id: "b", title: "Broken", why: "w", status: "fail" as const, detail: "bad", remedy: "fix it" },
    ],
  };

  it("puts failures before passes, so the important line is not scrolled past", () => {
    const text = renderText(report);
    expect(text.indexOf("Broken")).toBeLessThan(text.indexOf("Passing"));
  });

  it("says plainly not to open the site when something failed", () => {
    expect(renderText(report)).toMatch(/Do not open this to anyone else/);
  });

  it("renders a self-contained page with no network dependency", () => {
    const html = renderHtml(report);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/<script|src="http/);
  });

  it("escapes what it renders", () => {
    const html = renderHtml({
      ...report,
      results: [{ id: "x", title: "<script>alert(1)</script>", why: "w", status: "fail", detail: "d", remedy: "r" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
