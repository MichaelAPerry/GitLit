import { describe, expect, it } from "vitest";
import { ulid, newRepoId } from "./ids.js";
import { assertAgentWritable, isProseFile, normalizePath } from "./paths.js";
import { GitLitError, toolRejected } from "./errors.js";

describe("ulid", () => {
  it("sorts lexicographically by creation time", () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_800_000_000_000);
    expect(early < late).toBe(true);
  });
  it("is unique within a millisecond", () => {
    const t = Date.now();
    expect(new Set(Array.from({ length: 500 }, () => ulid(t))).size).toBe(500);
  });
  it("prefixes typed ids", () => {
    expect(newRepoId()).toMatch(/^repo_[0-9A-Z]{26}$/);
  });
});

describe("normalizePath", () => {
  it("strips a leading ./", () => {
    expect(normalizePath("./manuscript/a.md")).toBe("manuscript/a.md");
  });
  it("normalizes backslashes", () => {
    expect(normalizePath("manuscript\\chapters\\a.md")).toBe("manuscript/chapters/a.md");
  });
  it("rejects traversal", () => {
    expect(() => normalizePath("../etc/passwd")).toThrow(/Illegal path/);
    expect(() => normalizePath("manuscript/../../etc/passwd")).toThrow(/Illegal path/);
  });
  it("rejects absolute paths", () => {
    expect(() => normalizePath("/etc/passwd")).toThrow(/Illegal path/);
  });
  it("rejects null bytes", () => {
    expect(() => normalizePath("a\0b")).toThrow(/Illegal path/);
  });
});

describe("assertAgentWritable (§8.3)", () => {
  it("allows the architecture document", () => {
    expect(() => assertAgentWritable("manuscript_architecture.md")).not.toThrow();
  });
  it("allows .gitlit paths", () => {
    expect(() => assertAgentWritable(".gitlit/research/ledger.jsonl")).not.toThrow();
  });
  it("refuses manuscript prose — this is how the no-AI-prose rule is enforced", () => {
    expect(() => assertAgentWritable("manuscript/chapters/01.md")).toThrow(/refused/);
  });
  it("refuses a lookalike path outside the allowlist", () => {
    expect(() => assertAgentWritable("manuscript_architecture.md.bak")).toThrow(/refused/);
    expect(() => assertAgentWritable(".gitlit-evil/x")).toThrow(/refused/);
  });
  it("refuses traversal before the allowlist is consulted", () => {
    expect(() => assertAgentWritable("../../etc/passwd")).toThrow(/Illegal path/);
  });
});

describe("isProseFile", () => {
  it("matches manuscript markdown", () => {
    expect(isProseFile("manuscript/chapters/01.md")).toBe(true);
  });
  it("excludes the architecture doc and config", () => {
    expect(isProseFile("manuscript_architecture.md")).toBe(false);
    expect(isProseFile("book.yml")).toBe(false);
  });
});

describe("errors", () => {
  it("serializes as an RFC 9457 problem", () => {
    const problem = new GitLitError("x", 400, "Bad", "why").toProblem();
    expect(problem).toMatchObject({ status: 400, title: "Bad", detail: "why" });
    expect(problem.type).toMatch(/^https:\/\//);
  });
  it("carries a reject reason for tool refusals", () => {
    expect(toolRejected("path_outside_allowlist", "no").toProblem())
      .toMatchObject({ reject_reason: "path_outside_allowlist" });
  });
});
