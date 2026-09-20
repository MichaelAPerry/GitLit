import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
// Enable a provider so the begin/callback routes are live.
process.env.GITHUB_CLIENT_ID = "gh-client";
process.env.GITHUB_CLIENT_SECRET = "gh-secret";

const { app } = await import("./index.js");
await app.ready();

const cookieFrom = (setCookie: string | string[] | undefined, name: string): string | null => {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = arr.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(";")[0]! : null;
};

describe("OAuth is bound to the browser that started it (login-CSRF)", () => {
  it("begin sets a one-time state cookie and redirects to the provider", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/oauth/github" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/github\.com/);
    const bound = cookieFrom(res.headers["set-cookie"], "gitlit_oauth");
    expect(bound).toBeTruthy();
    // The cookie value is the state echoed in the provider URL.
    expect(decodeURIComponent(res.headers.location as string)).toContain(decodeURIComponent(bound!));
  });

  it("REFUSES a callback opened in a browser that has no state cookie", async () => {
    // The attack: attacker completes their own flow, hands the victim the
    // resulting callback URL. The victim's browser carries no matching cookie.
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/oauth/github/callback?code=attacker_code&state=attacker_state",
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/could not be verified for this browser/);
  });

  it("REFUSES a callback whose state does not match the browser's cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/oauth/github/callback?code=c&state=one",
      headers: { cookie: "gitlit_oauth=a-different-state" },
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/could not be verified for this browser/);
  });

  it("clears the state cookie on the callback, so it cannot be replayed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/oauth/github/callback?code=c&state=x",
      headers: { cookie: "gitlit_oauth=y" },
    });
    const cleared = (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]])
      .find((c) => String(c).startsWith("gitlit_oauth="));
    expect(String(cleared)).toMatch(/Max-Age=0/);
  });

  it("a matching cookie passes the CSRF gate (and then fails later, on the fake code)", async () => {
    // Proves the gate is what rejects the mismatched cases above — a matching
    // state gets past it and fails deeper, with a different error.
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/oauth/github/callback?code=c&state=matching",
      headers: { cookie: "gitlit_oauth=matching" },
    });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).not.toMatch(/could not be verified for this browser/);
  });
});
