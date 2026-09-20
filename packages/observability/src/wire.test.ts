import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flushMonitoring, initMonitoring, reportError } from "./sentry.js";

/**
 * What actually goes over the wire.
 *
 * The other tests in this package check the scrubber against events built by
 * hand, which cannot catch a field the SDK adds that nobody modelled — and one
 * did. Sentry attaches the deployed SOURCE around every stack frame
 * (`pre_context` / `context_line` / `post_context`), so text near a throw left
 * the process regardless of what the scrubber knew about. A rehearsal against
 * a real ingest endpoint found it; this test is here so it stays found.
 */

const TOKEN = `glm_0123456789abcdef01_${"a".repeat(64)}`;
const CHAPTER = "The lighthouse had been dark for a year.";
const ADDRESS = "mara@example.com";

let server: Server;
let received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push(body); res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const started = initMonitoring({
    service: "api",
    env: { SENTRY_DSN: `http://publickey@127.0.0.1:${port}/1`, NODE_ENV: "production", GIT_SHA: "abc123" },
  });
  expect(started).toBe(true);

  reportError(new Error(`sign-in failed for ${ADDRESS} using ${TOKEN}`));
  reportError(new Error("commit failed"), {
    content: CHAPTER, repoId: "repo_01ABC", path: "manuscript/chapters/01.md",
  });
  const framed = new Error("fetch failed");
  framed.stack = `Error: fetch failed\n    at f (https://gitlit.app/signin?token=${TOKEN})`;
  reportError(framed);

  await flushMonitoring(4000);
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => { server?.close(); });

const wire = () => received.join("\n");

describe("a real Sentry event, read off the wire", () => {
  it("sends something at all", () => {
    expect(received.length).toBeGreaterThan(0);
  });

  it("carries no credential", () => {
    expect(wire()).not.toContain("a".repeat(64));
  });

  it("carries no email address", () => {
    expect(wire()).not.toContain(ADDRESS);
  });

  it("carries no manuscript prose", () => {
    expect(wire()).not.toContain(CHAPTER);
  });

  it("carries no source context from the deployed files", () => {
    // The field that leaked. Its absence is the fix.
    expect(wire()).not.toContain("pre_context");
    expect(wire()).not.toContain("post_context");
  });

  it("attaches no IP address", () => {
    expect(wire()).not.toContain("ip_address");
  });

  it("still carries what makes an error diagnosable", () => {
    expect(wire()).toContain("repo_01ABC");
    expect(wire()).toContain("manuscript/chapters/01.md");
    expect(wire()).toContain("abc123");
    expect(wire()).toContain("service");
  });
});
