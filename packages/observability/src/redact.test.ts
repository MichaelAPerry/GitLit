import { describe, expect, it } from "vitest";
import { createLogScrubber, secretScrubbingStream } from "./redact.js";

const env = {
  DATABASE_URL: "postgresql://gitlit:s3cr3tP@ss@db.internal:5432/gitlit",
  GOOGLE_CLIENT_SECRET: "GOCSPX-abcdefghijklmnop",
  GITHUB_CLIENT_SECRET: "gh0000secret1111value2222",
  SIGNING_MASTER_KEY: "bXktdmVyeS1zZWNyZXQtbWFzdGVyLWtleQ==",
  OPERATOR_TOKEN: "op-operator-token-value",
} as NodeJS.ProcessEnv;

describe("operator secrets never reach the logs", () => {
  const scrub = createLogScrubber(env);

  it("redacts a DATABASE_URL that lands in an error message", () => {
    // The realistic leak: a connection failure whose message carries the DSN.
    const line = `connect ECONNREFUSED for ${env.DATABASE_URL}`;
    const out = scrub(line) as string;
    expect(out).not.toContain("s3cr3tP@ss");
    expect(out).not.toContain(env.DATABASE_URL);
  });

  it("redacts a bare DSN password even if the URL is not a known secret", () => {
    const out = scrub("postgres://admin:hunter2@some-other-host/db") as string;
    expect(out).not.toContain("hunter2");
  });

  it.each([
    ["GOOGLE_CLIENT_SECRET", "GOCSPX-abcdefghijklmnop"],
    ["GITHUB_CLIENT_SECRET", "gh0000secret1111value2222"],
    ["SIGNING_MASTER_KEY", "bXktdmVyeS1zZWNyZXQtbWFzdGVyLWtleQ=="],
    ["OPERATOR_TOKEN", "op-operator-token-value"],
  ])("redacts %s wherever it appears", (_name, value) => {
    expect(scrub(`oops here it is: ${value} <-`) as string).not.toContain(value);
  });

  it("redacts a secret sitting in a serialized log line", () => {
    // The line the stream actually sees: JSON with the secret in a message.
    const line = JSON.stringify({ level: 50, msg: `boom ${env.GOOGLE_CLIENT_SECRET}` });
    expect(scrub(line)).not.toContain("GOCSPX");
  });

  it("leaves ordinary text alone", () => {
    const msg = "request completed in 12ms for /v1/repositories/mara/lighthouse";
    expect(scrub(msg)).toBe(msg);
  });

  it("passes a clean line through unchanged", () => {
    const line = '{"level":30,"msg":"request completed"}';
    expect(scrub(line)).toBe(line);
  });

  it("applies BOTH shape-based and value-based scrubbing to a line", () => {
    const TOKEN = `glt_0123456789abcdef01_${"a".repeat(64)}`;
    const line = `token ${TOKEN} and secret ${env.OPERATOR_TOKEN}`;
    expect(scrub(line)).not.toContain("a".repeat(64));       // shape-based
    expect(scrub(line)).not.toContain("op-operator-token");  // value-based
  });

  it("the stream scrubs a real serialized line before writing", async () => {
    const written: string[] = [];
    const dest = { write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WritableStream;
    const stream = secretScrubbingStream(dest, env);
    await new Promise<void>((r) => stream.write(
      `{"msg":"connect ECONNREFUSED ${env.DATABASE_URL}"}\n`, () => r()));
    expect(written.join("")).not.toContain("s3cr3tP@ss");
  });
});
