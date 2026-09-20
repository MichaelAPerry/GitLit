import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pktLine, FLUSH, serviceAdvertisement, parseReceivePackCommands, ZERO_OID, isCreate, isDelete } from "./pkt-line.js";
import { parseRepoPath, parseBasicAuth, isService, SERVICES } from "./smart-http.js";
import { initRepo } from "./repo.js";

describe("pkt-line", () => {
  it("prefixes payloads with their total length in hex", () => {
    expect(pktLine("a")).toBe("0005a");
    expect(pktLine("hello\n")).toBe("000ahello\n");
  });

  it("counts bytes, not characters", () => {
    // A 3-byte UTF-8 character must not be framed as length 1.
    expect(pktLine("—")).toBe("0007—");
  });

  it("refuses an over-long payload rather than truncating the length", () => {
    expect(() => pktLine("x".repeat(0x10000))).toThrow(/too long/);
  });

  it("builds the service advertisement banner git expects", () => {
    const banner = serviceAdvertisement("git-upload-pack").toString("utf8");
    expect(banner).toBe("001e# service=git-upload-pack\n" + FLUSH);
  });
});

describe("parseReceivePackCommands", () => {
  const cmd = (old: string, next: string, ref: string, caps = "") =>
    pktLine(`${old} ${next} ${ref}${caps ? `\0${caps}` : ""}\n`);

  it("reads a single ref update", () => {
    const body = Buffer.from(
      cmd("a".repeat(40), "b".repeat(40), "refs/heads/main", "report-status") + FLUSH,
      "utf8",
    );
    expect(parseReceivePackCommands(body)).toEqual([
      { oldOid: "a".repeat(40), newOid: "b".repeat(40), ref: "refs/heads/main" },
    ]);
  });

  it("reads several updates", () => {
    const body = Buffer.from(
      cmd("a".repeat(40), "b".repeat(40), "refs/heads/main") +
      cmd("c".repeat(40), "d".repeat(40), "refs/heads/draft") + FLUSH,
      "utf8",
    );
    expect(parseReceivePackCommands(body)).toHaveLength(2);
  });

  it("stops at the flush packet and ignores the packfile that follows", () => {
    const body = Buffer.concat([
      Buffer.from(cmd("a".repeat(40), "b".repeat(40), "refs/heads/main") + FLUSH, "utf8"),
      Buffer.from("PACK\u0000\u0000\u0000\u0002binary junk"),
    ]);
    expect(parseReceivePackCommands(body)).toHaveLength(1);
  });

  it("recognises branch creation and deletion", () => {
    const create = { oldOid: ZERO_OID, newOid: "b".repeat(40), ref: "refs/heads/new" };
    const remove = { oldOid: "a".repeat(40), newOid: ZERO_OID, ref: "refs/heads/old" };
    expect(isCreate(create)).toBe(true);
    expect(isDelete(remove)).toBe(true);
    expect(isDelete(create)).toBe(false);
  });

  it("returns nothing for junk rather than throwing", () => {
    expect(parseReceivePackCommands(Buffer.from("not a pkt-line"))).toEqual([]);
    expect(parseReceivePackCommands(Buffer.alloc(0))).toEqual([]);
  });
});

describe("parseRepoPath", () => {
  it("parses a fetch advertisement URL, query string and all", () => {
    expect(parseRepoPath("/mara/saltmarsh.git/info/refs?service=git-upload-pack"))
      .toEqual({ owner: "mara", slug: "saltmarsh" });
  });

  it("parses the RPC endpoints", () => {
    expect(parseRepoPath("/mara/saltmarsh.git/git-upload-pack")).toEqual({ owner: "mara", slug: "saltmarsh" });
    expect(parseRepoPath("/mara/saltmarsh.git/git-receive-pack")).toEqual({ owner: "mara", slug: "saltmarsh" });
  });

  it("accepts a URL without the .git suffix", () => {
    expect(parseRepoPath("/mara/saltmarsh/info/refs?service=git-upload-pack"))
      .toEqual({ owner: "mara", slug: "saltmarsh" });
  });

  it("lower-cases owner and slug", () => {
    expect(parseRepoPath("/Mara/Saltmarsh.git/git-upload-pack")).toEqual({ owner: "mara", slug: "saltmarsh" });
  });

  it("refuses path traversal and nonsense", () => {
    for (const bad of [
      "/../../etc/passwd/info/refs",
      "/mara/../../etc/git-upload-pack",
      "/mara/saltmarsh.git/../../../info/refs",
      "/info/refs",
      "/one/two/three/info/refs",
      "/mara/saltmarsh.git/hooks/pre-receive",
    ]) {
      expect(parseRepoPath(bad), bad).toBeNull();
    }
  });
});

describe("parseBasicAuth", () => {
  it("decodes a credential", () => {
    const header = `Basic ${Buffer.from("x:glt_abc").toString("base64")}`;
    expect(parseBasicAuth(header)).toEqual({ username: "x", password: "glt_abc" });
  });

  it("keeps colons inside the password", () => {
    const header = `Basic ${Buffer.from("user:pass:with:colons").toString("base64")}`;
    expect(parseBasicAuth(header)?.password).toBe("pass:with:colons");
  });

  it("returns null for anything else", () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth("Bearer glt_abc")).toBeNull();
    expect(parseBasicAuth("Basic bm9jb2xvbg==")).toBeNull();
  });
});

describe("service capabilities", () => {
  it("maps fetch to read and push to write", () => {
    expect(SERVICES["git-upload-pack"].capability).toBe("repo:read");
    expect(SERVICES["git-receive-pack"].capability).toBe("repo:write");
  });

  it("recognises only the two real services", () => {
    expect(isService("git-upload-pack")).toBe(true);
    expect(isService("git-receive-pack")).toBe(true);
    expect(isService("git-evil-pack")).toBe(false);
    expect(isService(undefined)).toBe(false);
  });
});

describe("repository initialisation", () => {
  let gitdir: string;
  beforeAll(async () => {
    gitdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-hooks-"));
    await initRepo(gitdir);
  });
  afterAll(async () => { await fs.promises.rm(gitdir, { recursive: true, force: true }); });

  it("writes an executable pre-receive hook", () => {
    const hook = path.join(gitdir, "hooks", "pre-receive");
    expect(fs.existsSync(hook)).toBe(true);
    expect(fs.statSync(hook).mode & 0o111).toBeGreaterThan(0);
  });

  it("produces a config git can actually parse", () => {
    // Regression: appending a dotted key into [core] made every repository
    // unreadable, and the failure only surfaced through git itself.
    const output = execFileSync("git", ["--git-dir", gitdir, "config", "--list"], { encoding: "utf8" });
    expect(output).toContain("core.bare=true");
    expect(output).not.toMatch(/fatal/);
  });

  it("is a bare repository git recognises", () => {
    const out = execFileSync("git", ["--git-dir", gitdir, "rev-parse", "--is-bare-repository"], { encoding: "utf8" });
    expect(out.trim()).toBe("true");
  });

  it("can serve a ref advertisement", () => {
    const out = execFileSync("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", gitdir], { encoding: "utf8" });
    expect(out).not.toContain("fatal");
  });
});

describe("pre-receive hook", () => {
  let gitdir: string;
  let work: string;
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
  const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

  beforeAll(async () => {
    gitdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-bare-"));
    work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gitlit-work-"));
    await initRepo(gitdir);
    run(["init", "-q", "-b", "main", "."], work);
    run(["config", "user.email", "t@x"], work);
    run(["config", "user.name", "T"], work);
    run(["remote", "add", "origin", gitdir], work);
  });
  afterAll(async () => {
    await fs.promises.rm(gitdir, { recursive: true, force: true });
    await fs.promises.rm(work, { recursive: true, force: true });
  });

  it("accepts a push with no GitLit trailers", () => {
    fs.writeFileSync(path.join(work, "chapter.md"), "A sentence.\n");
    run(["add", "-A"], work);
    run(["commit", "-q", "-m", "Honest work"], work);
    expect(() => run(["push", "-q", "origin", "main"], work)).not.toThrow();
  });

  it("REFUSES a push whose commit asserts its own provenance", () => {
    fs.writeFileSync(path.join(work, "chapter.md"), "A sentence. Another.\n");
    run(["add", "-A"], work);
    run(["commit", "-q", "-m", "Forged\n\nGitLit-Provenance: human\n"], work);

    let message = "";
    try {
      run(["push", "origin", "main"], work);
    } catch (err) {
      message = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(message).toMatch(/GitLit refused this push/);
    expect(message).toMatch(/provenance trailers/);
    // The message explains rather than accuses, and says what happens instead.
    expect(message).toMatch(/unknown' origin/);
  });

  it("leaves the ref unmoved after a refused push", () => {
    const remote = run(["rev-parse", "main"], gitdir).trim();
    const local = run(["rev-parse", "main"], work).trim();
    expect(remote).not.toBe(local);
  });
});
