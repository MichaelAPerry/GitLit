import { describe, expect, it } from "vitest";
import { REDACTED, scrubString, scrubUrl, scrubValue } from "./scrub.js";

const TOKEN = (p: string) => `${p}_0123456789abcdef01_${"a".repeat(64)}`;

describe("credentials never leave the process", () => {
  it.each(["glm", "gls", "glt", "glo"])("redacts a %s token in free text", (prefix) => {
    const out = scrubString(`failed for ${TOKEN(prefix)} at line 4`);
    expect(out).not.toContain("a".repeat(64));
    expect(out).toContain(`${prefix}_${REDACTED}`);
  });

  it("redacts a token buried in a stack trace", () => {
    const stack = `Error: nope\n  at fetch (http://api/v1/x?token=${TOKEN("glm")})\n  at run`;
    expect(scrubValue({ stack }).stack).not.toContain("a".repeat(64));
  });

  it("redacts an Authorization header value whatever its shape", () => {
    expect(scrubString("Bearer sk-live-not-our-format")).toBe(`Bearer ${REDACTED}`);
    expect(scrubString("basic eyJhbGciOi")).toBe(`basic ${REDACTED}`);
  });

  it("drops the value of a denied key entirely", () => {
    const out = scrubValue({ authorization: "Bearer x", cookie: "a=b", sessionToken: "gls_x" });
    expect(out).toEqual({ authorization: REDACTED, cookie: REDACTED, sessionToken: REDACTED });
  });

  it("matches denied keys regardless of case", () => {
    expect(scrubValue({ Authorization: "x", SET_COOKIE: "y" }))
      .toEqual({ Authorization: REDACTED, SET_COOKIE: REDACTED });
  });
});

describe("manuscripts never leave the process", () => {
  it("drops prose carried on an exception", () => {
    // The commit path can throw with a whole chapter attached. A chapter in a
    // third-party error tracker is the thing GitLit exists to prevent.
    const event = {
      message: "commit failed",
      extra: { content: "The lighthouse had been dark for a year.", path: "manuscript/chapters/01.md" },
    };
    const out = scrubValue(event);
    expect(out.extra.content).toBe(REDACTED);
    // The path is diagnostic and carries no prose, so it survives.
    expect(out.extra.path).toBe("manuscript/chapters/01.md");
  });

  it("drops a diff, a patch and computed spans", () => {
    const out = scrubValue({ diff: "- old\n+ new", patch: "@@", spans: [{ origin: "human" }] });
    expect(out).toEqual({ diff: REDACTED, patch: REDACTED, spans: REDACTED });
  });

  it("redacts nested values, not just top-level ones", () => {
    const out = scrubValue({ a: { b: { c: { token: "x", note: `see ${TOKEN("glt")}` } } } });
    expect(out.a.b.c.token).toBe(REDACTED);
    expect(out.a.b.c.note).not.toContain("a".repeat(64));
  });

  it("redacts inside arrays", () => {
    const out = scrubValue({ items: [{ email: "a@b.co" } as Record<string, string>, "reach me at c@d.co"] });
    expect((out.items[0] as Record<string, string>).email).toBe(REDACTED);
    expect(out.items[1] as string).not.toContain("c@d.co");
  });
});

describe("addresses", () => {
  it("redacts an email in a message", () => {
    expect(scrubString("no account for mara@example.com")).toBe(`no account for ${REDACTED}`);
  });

  it("redacts an email inside a longer sentence without eating the sentence", () => {
    const out = scrubString("sending to mara@example.com failed");
    expect(out).toBe(`sending to ${REDACTED} failed`);
  });
});

describe("urls", () => {
  it("redacts the magic-link token, which IS the credential", () => {
    const out = scrubUrl(`https://gitlit.app/signin?token=${TOKEN("glm")}&next=/`);
    expect(out).not.toContain("a".repeat(64));
    expect(out).toContain("next=%2F");
  });

  it("leaves a url with nothing sensitive readable", () => {
    expect(scrubUrl("https://gitlit.app/v1/repositories/mara/lighthouse"))
      .toBe("https://gitlit.app/v1/repositories/mara/lighthouse");
  });

  it("redacts basic-auth credentials in a git clone url", () => {
    const out = scrubUrl(`http://x:${TOKEN("glt")}@gitd:4001/mara/book.git`);
    expect(out).not.toContain("a".repeat(64));
  });
});

describe("the scrubber cannot break the error path", () => {
  it("tolerates a cycle instead of throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => scrubValue(a)).not.toThrow();
    expect(scrubValue(a).self).toBe(REDACTED);
  });

  it("truncates a very deep structure rather than walking forever", () => {
    let deep: Record<string, unknown> = { token: "x" };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(() => scrubValue(deep)).not.toThrow();
  });

  it("passes through numbers, booleans, null and undefined unchanged", () => {
    expect(scrubValue({ n: 1, b: true, z: null, u: undefined }))
      .toEqual({ n: 1, b: true, z: null, u: undefined });
  });

  it("does not mangle ordinary diagnostic text", () => {
    const msg = "gitd 500: repository repo_01ABC not found on /data/repos";
    expect(scrubString(msg)).toBe(msg);
  });
});

describe("key spellings a deny list usually misses", () => {
  // Found by a failing test: the same field arrives as `set-cookie`,
  // `SET_COOKIE` or `setCookie` depending on whether it came from a header
  // map, an env var or a JS object. Matching one spelling leaks the others.
  it.each([
    "set-cookie", "SET_COOKIE", "setCookie", "Set-Cookie",
    "x-api-key", "X_API_KEY", "xApiKey",
    "session_token", "sessionToken", "SESSION-TOKEN",
    "reply_to", "replyTo", "REPLY-TO",
  ])("redacts %s", (key) => {
    expect(scrubValue({ [key]: "secret" })[key]).toBe(REDACTED);
  });

  it("does not redact a key that merely contains a denied word", () => {
    // `tokenCount` is a number worth seeing; `token` is not.
    const out = scrubValue({ tokenCount: 4, contentType: "text/markdown" });
    expect(out).toEqual({ tokenCount: 4, contentType: "text/markdown" });
  });
});
