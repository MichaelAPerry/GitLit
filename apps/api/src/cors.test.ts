import { describe, expect, it } from "vitest";
import { allowedOrigins, originDecision } from "./cors.js";

const prod = (over: Record<string, string> = {}) => ({
  NODE_ENV: "production", PUBLIC_WEB_URL: "https://gitlit.app", ...over,
});

describe("which origins may call the API as the signed-in author", () => {
  it("allows the web app", () => {
    expect(originDecision(prod())("https://gitlit.app")).toBe(true);
  });

  it("REFUSES any other site", () => {
    // With credentials allowed, reflecting whatever Origin asked would let any
    // page an author visits call this API as them, with their cookie.
    const allow = originDecision(prod());
    expect(allow("https://evil.example")).toBe(false);
    expect(allow("http://gitlit.app")).toBe(false);          // wrong scheme
    expect(allow("https://gitlit.app.evil.example")).toBe(false); // suffix trick
    expect(allow("https://notgitlit.app")).toBe(false);
  });

  it("ignores a trailing slash and casing, which are the same origin", () => {
    const allow = originDecision(prod({ PUBLIC_WEB_URL: "https://GitLit.app/" }));
    expect(allow("https://gitlit.app")).toBe(true);
  });

  it("allows extra origins when they are configured deliberately", () => {
    const allow = originDecision(prod({ EXTRA_CORS_ORIGINS: "https://staging.gitlit.app" }));
    expect(allow("https://staging.gitlit.app")).toBe(true);
    expect(allow("https://other.example")).toBe(false);
  });

  it("allows a request with no Origin at all", () => {
    // curl, a server-to-server call, gitd's authorization callback. There is
    // no browser to protect, and authorization still applies as ever.
    expect(originDecision(prod())(undefined)).toBe(true);
  });

  it("allows anything in development", () => {
    // A developer runs the web app on whatever port is free, and there is no
    // real session to steal.
    expect(originDecision({ NODE_ENV: "development" })("http://localhost:5173")).toBe(true);
  });

  it("has no allowed origins when PUBLIC_WEB_URL is unset", () => {
    // Which is why the API refuses to start that way in production: the
    // dashboard could not load, and the cause would look like anything.
    expect(allowedOrigins({ NODE_ENV: "production" })).toEqual([]);
  });
});
