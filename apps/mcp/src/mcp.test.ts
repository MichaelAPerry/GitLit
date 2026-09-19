import { describe, expect, it, beforeEach } from "vitest";
import { isBlockedAddress, assertFetchable, toPlainText } from "./fetch-guard.js";
import { Ledger, contentHash } from "./ledger.js";
import { scoreNovelty, concepts, noveltyCaveat, SCORER_VERSION } from "./novelty.js";
import { parseArchitecture, validateArchitecture, buildFrontMatter } from "./architecture.js";
import { SessionStore, QUOTAS } from "./session.js";
import type { Work } from "./corpora.js";

// ---------------------------------------------------------------- SSRF guard

describe("isBlockedAddress", () => {
  it("blocks loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.255.255.254")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });
  it("blocks private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it("blocks cloud metadata", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 loopback — the classic bypass", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });
  it("blocks IPv6 unique-local and link-local", () => {
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });
  it("allows ordinary public addresses", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("2606:2800:220:1::1")).toBe(false);
  });
  it("blocks anything that is not an IP", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
  it("does not treat 172.32 as private (boundary)", () => {
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
  });
});

describe("assertFetchable", () => {
  it("refuses non-http schemes", async () => {
    await expect(assertFetchable("file:///etc/passwd")).rejects.toThrow(/http and https/);
    await expect(assertFetchable("gopher://x")).rejects.toThrow(/http and https/);
  });
  it("refuses embedded credentials", async () => {
    await expect(assertFetchable("http://u:p@example.com")).rejects.toThrow(/credentials/);
  });
  it("refuses localhost by name", async () => {
    await expect(assertFetchable("http://localhost:4000/x")).rejects.toThrow(/internal hostname/);
  });
  it("refuses a literal private address", async () => {
    await expect(assertFetchable("http://169.254.169.254/latest/meta-data/"))
      .rejects.toThrow(/private address/);
  });
  it("refuses malformed input", async () => {
    await expect(assertFetchable("not a url")).rejects.toThrow(/Not a URL/);
  });
});

describe("toPlainText", () => {
  it("strips tags, scripts and entities", () => {
    expect(toPlainText("<p>Hello <b>there</b></p><script>evil()</script>&amp; more"))
      .toBe("Hello there & more");
  });
});

// -------------------------------------------------------------------- ledger

describe("Ledger", () => {
  let ledger: Ledger;
  const work = (title: string, synopsis?: string): Work => ({
    source: "openlibrary", externalId: "/works/1", title, authors: ["A"],
    publishedYear: 2020, synopsis,
  });

  beforeEach(() => { ledger = new Ledger(); });

  it("assigns sequential refs", () => {
    const rows = ledger.addSearchResults("q", [work("One"), work("Two")]);
    expect(rows.map((r) => r.ledgerRef)).toEqual(["S-001", "S-002"]);
  });

  it("records the query we actually ran", () => {
    const [row] = ledger.addSearchResults("lighthouse keepers 1920", [work("Keepers")]);
    expect(row!.query).toBe("lighthouse keepers 1920");
    expect(row!.discoveredVia).toBe("search_query");
  });

  it("records a failed fetch rather than dropping it", () => {
    const row = ledger.addFetched({ url: "https://nope.example/x", status: "failed" });
    expect(row.fetchStatus).toBe("failed");
    expect(ledger.has(row.ledgerRef)).toBe(true);
  });

  it("hashes retrieved content", () => {
    const row = ledger.addFetched({ url: "https://x.example", body: "text", status: "ok" });
    expect(row.contentHash).toBe(contentHash("text"));
  });

  it("round-trips through jsonl", () => {
    ledger.addSearchResults("q", [work("One", "about lighthouses")]);
    const parsed = ledger.toJsonl().trim().split("\n").map((l) => JSON.parse(l));
    expect(parsed[0].ledgerRef).toBe("S-001");
  });

  it("renders markdown grouped by domain", () => {
    ledger.addSearchResults("q", [work("Keepers", "blurb")], "Lighthouse keeping");
    expect(ledger.toMarkdown()).toContain("### Domain: Lighthouse keeping");
    expect(ledger.toMarkdown()).toContain("**[S-001]**");
  });

  it("marks failed fetches visibly in markdown", () => {
    ledger.addFetched({ url: "https://nope.example", status: "failed" });
    expect(ledger.toMarkdown()).toContain("**fetch failed**");
  });
});

// ------------------------------------------------------------------ novelty

describe("scoreNovelty", () => {
  const premise = "A lighthouse keeper's daughter returns to the island she swore to leave.";
  const work = (title: string, synopsis: string, year = 2020): Work => ({
    source: "openlibrary", externalId: title, title, authors: [], publishedYear: year, synopsis,
  });

  it("is deterministic — the same inputs give the same scores", () => {
    const works = [work("The Light", "a lighthouse keeper and his daughter on an island")];
    const a = scoreNovelty(premise, works, new Date("2026-01-01"));
    const b = scoreNovelty(premise, works, new Date("2026-01-01"));
    expect(a).toEqual(b);
  });

  it("records the scorer version so a past verdict keeps its meaning", () => {
    expect(scoreNovelty(premise, []).scorerVersion).toBe(SCORER_VERSION);
  });

  it("scores a near-identical premise as derivative", () => {
    const works = [work(
      "A lighthouse keeper's daughter returns",
      "A lighthouse keeper's daughter returns to the island she swore to leave.",
    )];
    expect(scoreNovelty(premise, works).suggestedVerdict).toBe("derivative");
  });

  it("scores unrelated works as sparse prior art", () => {
    const works = [work("Quantum Gardening", "a manual for tending vegetables in orbit")];
    expect(scoreNovelty(premise, works).suggestedVerdict).toBe("sparse_prior_art");
  });

  it("flags a crowded field when many recent works are adjacent", () => {
    const works = Array.from({ length: 6 }, (_, i) =>
      work(`Lighthouse Island ${i}`, "lighthouse keeper daughter island returns home", 2024));
    expect(scoreNovelty(works[0]!.synopsis!, works).suggestedVerdict).not.toBe("sparse_prior_art");
  });

  it("returns nearest works sorted by similarity", () => {
    const works = [
      work("Unrelated", "orbital vegetables"),
      work("Close", "a lighthouse keeper's daughter returns to an island"),
    ];
    const { nearestWorks } = scoreNovelty(premise, works);
    expect(nearestWorks[0]!.title).toBe("Close");
  });

  it("handles an empty corpus without dividing by zero", () => {
    const s = scoreNovelty(premise, []);
    expect(s.corpusSimilarity).toBe(0);
    expect(s.suggestedVerdict).toBe("sparse_prior_art");
  });
});

describe("concepts", () => {
  it("drops stopwords and short tokens", () => {
    expect([...concepts("the keeper of a lighthouse")]).toEqual(["keeper", "lighthouse"]);
  });
});

describe("noveltyCaveat", () => {
  it("always states that absence is not originality", () => {
    expect(noveltyCaveat(["openlibrary"], [])).toMatch(/not originality/);
  });
  it("discloses a partial search", () => {
    expect(noveltyCaveat(["openlibrary"], ["crossref"])).toMatch(/partial/);
  });
});

// ------------------------------------------------------------- architecture

const VALID = `
## 1. Premise (as submitted)
> A keeper's daughter returns.

## 2. Novelty Assessment
**Verdict:** Sparse prior art.

## 3. Research Ledger
See ledger.

## 4. Chapter Outline
### Chapter 1 — The Lighthouse \`[ch1]\`
**Function:** Establish the return.
**Beats:**
- \`b1.1\` Mara drives the headland road. *(sources: S-001)*
- \`b1.2\` The cottage is as she left it. *(sources: S-002)*

### Chapter 2 — Salt and Ash \`[ch2]\`
**Beats:**
- \`b2.1\` The will is read.

## 5. Structural Notes
Three acts.

## 6. Where the AI stopped
No prose in manuscript/ was generated.
`;

describe("parseArchitecture", () => {
  it("extracts chapters and beats", () => {
    const p = parseArchitecture(VALID);
    expect(p.chapters).toHaveLength(2);
    expect(p.chapters[0]!.title).toBe("The Lighthouse");
    expect(p.chapters[0]!.beats.map((b) => b.id)).toEqual(["b1.1", "b1.2"]);
    expect(p.beats).toHaveLength(3);
  });

  it("extracts source citations per beat", () => {
    expect(parseArchitecture(VALID).chapters[0]!.beats[0]!.sources).toEqual(["S-001"]);
  });

  it("collects all cited refs", () => {
    expect(parseArchitecture(VALID).citedRefs).toEqual(["S-001", "S-002"]);
  });

  it("parses front matter", () => {
    const p = parseArchitecture("---\nagent_session: sess_1\n---\n\n# X");
    expect(p.frontMatter["agent_session"]).toBe("sess_1");
  });
});

describe("validateArchitecture", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger();
    ledger.addSearchResults("q", [
      { source: "openlibrary", externalId: "1", title: "One", authors: [] },
      { source: "openlibrary", externalId: "2", title: "Two", authors: [] },
    ]);
  });

  it("accepts a well-formed document whose citations exist", () => {
    expect(() => validateArchitecture(VALID, ledger)).not.toThrow();
  });

  it("REJECTS a fabricated citation", () => {
    const doc = VALID.replace("S-002", "S-999");
    expect(() => validateArchitecture(doc, ledger)).toThrow(/S-999/);
  });

  it("names the available refs so the agent can correct itself", () => {
    expect(() => validateArchitecture(VALID.replace("S-001", "S-404"), ledger))
      .toThrow(/S-001, S-002/);
  });

  it("rejects a document with no chapters", () => {
    const doc = VALID.replace(/### Chapter[\s\S]*?(?=## 5)/, "");
    expect(() => validateArchitecture(doc, ledger)).toThrow(/chapters|beats/i);
  });

  it("rejects a missing required section", () => {
    expect(() => validateArchitecture(VALID.replace("## 6. Where the AI stopped", "## 6. Other"), ledger))
      .toThrow(/Where the AI stopped/);
  });

  it("rejects duplicate beat ids", () => {
    expect(() => validateArchitecture(VALID.replace("b2.1", "b1.1"), ledger))
      .toThrow(/Duplicate beat/);
  });

  it("accepts a document citing nothing", () => {
    const doc = VALID.replace(/ \*\(sources: S-00\d\)\*/g, "");
    expect(() => validateArchitecture(doc, ledger)).not.toThrow();
  });
});

describe("buildFrontMatter", () => {
  it("marks the declared model as an unverified claim", () => {
    const fm = buildFrontMatter({
      sessionId: "sess_1", declaredModel: "claude-opus-5",
      premiseHash: "sha256:abc", verdict: "sparse_prior_art", scorerVersion: "novelty/lexical-v1",
    });
    expect(fm).toContain("agent claim, unverified");
    expect(fm).toContain("agent_session: sess_1");
  });
  it("says so when no model was declared", () => {
    expect(buildFrontMatter({ sessionId: "s", premiseHash: "h", scorerVersion: "v" }))
      .toContain("declared_model: unstated");
  });
});

// ------------------------------------------------------------------ session

describe("SessionStore", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(); });

  const open = () => store.open({ repoId: "repo_1", userId: "u_1", transport: "stdio" });

  it("resumes an active session for the same repo and user", () => {
    const s = open();
    expect(store.forRepo("repo_1", "u_1")?.id).toBe(s.id);
  });

  it("does not resume across users", () => {
    open();
    expect(store.forRepo("repo_1", "u_2")).toBeUndefined();
  });

  it("logs successful tool calls", async () => {
    const s = open();
    await store.record(s, "gitlit_get_premise", { a: 1 }, async () => ({ ok: true }));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]).toMatchObject({ tool: "gitlit_get_premise", status: "ok", seq: 0 });
  });

  it("logs REJECTED calls — a refused call is evidence, not a swallowed error", async () => {
    const s = open();
    const err = Object.assign(new Error("no"), { detail: { reject_reason: "path_outside_allowlist" } });
    await expect(store.record(s, "gitlit_commit_architecture", {}, async () => { throw err; }))
      .rejects.toThrow();
    expect(s.toolCalls[0]).toMatchObject({ status: "rejected", rejectReason: "path_outside_allowlist" });
  });

  it("distinguishes a failure from a rejection", async () => {
    const s = open();
    await expect(store.record(s, "x", {}, async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(s.toolCalls[0]!.status).toBe("failed");
  });

  it("redacts long argument values from the stored echo", async () => {
    const s = open();
    await store.record(s, "x", { markdown: "y".repeat(5000) }, async () => null);
    expect((s.toolCalls[0]!.argsRedacted as Record<string, string>)["markdown"]).toBe("«5000 chars»");
  });

  it("enforces the search quota", () => {
    const s = open();
    for (let i = 0; i < QUOTAS.searches; i++) store.spend(s, "searches");
    expect(() => store.spend(s, "searches")).toThrow(/limit reached/);
  });

  it("allows exactly one architecture commit", () => {
    const s = open();
    store.spend(s, "architectureCommits");
    expect(() => store.spend(s, "architectureCommits")).toThrow(/limit reached/);
  });
});

// A rejected architecture commit must not consume the session's single commit
// allowance: the rejection names the available ledger refs precisely so the
// agent can correct the document and retry.
describe("commit quota accounting", () => {
  it("charges the commit allowance only on success", () => {
    const store = new SessionStore();
    const s = store.open({ repoId: "r", userId: "u", transport: "stdio" });
    const ledger = new Ledger();
    ledger.addSearchResults("q", [
      { source: "openlibrary", externalId: "1", title: "One", authors: [] },
      { source: "openlibrary", externalId: "2", title: "Two", authors: [] },
    ]);

    // A fabricated citation is rejected during validation, before any spend.
    expect(() => validateArchitecture(VALID.replace("S-001", "S-999"), ledger)).toThrow();
    expect(s.architectureCommits).toBe(0);

    // The corrected document then still has its allowance available.
    expect(() => validateArchitecture(VALID, ledger)).not.toThrow();
    expect(() => store.spend(s, "architectureCommits")).not.toThrow();
    expect(s.architectureCommits).toBe(1);
  });
});

describe("session status after a commit", () => {
  it("reports the session that did the work, not a fresh empty one", async () => {
    const store = new SessionStore();
    const s = store.open({ repoId: "r", userId: "u", transport: "stdio" });
    await store.record(s, "gitlit_search_prior_works", {}, async () => null);
    s.status = "committed";

    // forRepo (used by working tools) correctly declines a closed session...
    expect(store.forRepo("r", "u")).toBeUndefined();
    // ...but a status read still finds it, with its recorded activity intact.
    const found = store.latestForRepo("r", "u");
    expect(found?.id).toBe(s.id);
    expect(found?.toolCalls).toHaveLength(1);
    expect(found?.status).toBe("committed");
  });

  it("returns nothing for a repo no agent has touched", () => {
    expect(new SessionStore().latestForRepo("r", "u")).toBeUndefined();
  });
});
