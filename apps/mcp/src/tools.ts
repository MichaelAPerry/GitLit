import { z } from "zod";
import { createHash } from "node:crypto";
import { assertAgentWritable, toolRejected } from "@gitlit/core";
import { countWords } from "@gitlit/prose";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchAll, type CorpusName } from "./corpora.js";
import { Ledger } from "./ledger.js";
import { fetchSource, toPlainText } from "./fetch-guard.js";
import { noveltyCaveat, scoreNovelty, SCORER_VERSION } from "./novelty.js";
import { buildFrontMatter, validateArchitecture } from "./architecture.js";
import { gitlit } from "./gitlit-client.js";
import type { AgentSession, SessionStore } from "./session.js";

const ALL_CORPORA: CorpusName[] = ["openlibrary", "googlebooks", "crossref", "semanticscholar"];

export interface ToolContext {
  sessions: SessionStore;
  ledgers: Map<string, Ledger>;
  transport: "stdio" | "http";
  userId: string;
  clientName?: string;
  declaredModel?: string;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

function ledgerFor(ctx: ToolContext, session: AgentSession): Ledger {
  let l = ctx.ledgers.get(session.id);
  if (!l) { l = new Ledger(); ctx.ledgers.set(session.id, l); }
  return l;
}

async function resolveRepo(owner: string, slug: string) {
  const { repositories } = await gitlit.listRepositories();
  const repo = repositories.find((r) => r.owner === owner && r.slug === slug);
  if (!repo) throw toolRejected("unknown_repository", `No repository ${owner}/${slug}`);
  return repo;
}

function sessionFor(ctx: ToolContext, repoId: string): AgentSession {
  return (
    ctx.sessions.forRepo(repoId, ctx.userId) ??
    ctx.sessions.open({
      repoId, userId: ctx.userId, transport: ctx.transport,
      clientName: ctx.clientName, declaredModel: ctx.declaredModel,
    })
  );
}

/**
 * Registers the GitLit tool surface (§12.8).
 *
 * There is deliberately NO gitlit_write_document. An earlier draft had one; a
 * general prose-write tool is precisely the hole through which "the AI never
 * writes prose" leaks, and the convenience is not worth it. Agents that want
 * to draft can do so in the author's own files, and §7.5 records the paste
 * honestly when it arrives.
 *
 * Tool descriptions state provenance consequences plainly, so a well-behaved
 * agent can tell the author what will be recorded before it acts.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("gitlit_list_repositories", {
    title: "List the author's books",
    description:
      "List GitLit repositories (books) this credential can reach. Start here to find the " +
      "repo slug for the other tools. Read-only; nothing is recorded to the book's history.",
    inputSchema: {},
  }, async () => {
    const { repositories } = await gitlit.listRepositories();
    return json(repositories.map((r) => ({
      owner: r.owner, slug: r.slug, title: r.title, form: r.form, phase: r.phase,
    })));
  });

  server.registerTool("gitlit_get_premise", {
    title: "Read the book's premise",
    description:
      "Read the author's premise and repo configuration — the starting point for research. " +
      "Opens an agent session for this book if one is not already open. Read-only.",
    inputSchema: { owner: z.string(), slug: z.string() },
  }, async ({ owner, slug }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_get_premise", { owner, slug }, async () => {
      const { content } = await gitlit.readBlob(repo.id, ".gitlit/premise.md");
      return json({
        sessionId: session.id,
        repo: { owner, slug, title: repo.title, form: repo.form, phase: repo.phase },
        premise: content ?? null,
        note: content
          ? undefined
          : "No premise recorded yet. Ask the author to add one in GitLit before researching.",
      });
    });
  });

  server.registerTool("gitlit_search_prior_works", {
    title: "Search published works and papers",
    description:
      "Search book and paper catalogues for prior art. GitLit runs the query itself and writes " +
      "every result into this book's research ledger BEFORE returning them, so the ledger is a " +
      "record of what was actually searched. Use several focused queries rather than one broad " +
      "one. Limited to 40 searches per session.",
    inputSchema: {
      owner: z.string(),
      slug: z.string(),
      query: z.string().min(3).describe("A focused search query."),
      corpora: z.array(z.enum(["openlibrary", "googlebooks", "crossref", "semanticscholar"]))
        .optional().describe("Defaults to all four."),
      domain: z.string().optional()
        .describe("Research domain this query belongs to; groups the ledger."),
      limit: z.number().int().min(1).max(25).default(10),
    },
  }, async ({ owner, slug, query, corpora, domain, limit }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_search_prior_works", { query, domain }, async () => {
      ctx.sessions.spend(session, "searches");
      const chosen = (corpora as CorpusName[] | undefined) ?? ALL_CORPORA;
      const { works, searched, failed } = await searchAll(query, chosen, limit);
      const rows = ledgerFor(ctx, session).addSearchResults(query, works, domain);
      return json({
        query,
        corporaSearched: searched,
        corporaUnavailable: failed,
        recordedToLedger: rows.length,
        searchesRemaining: 40 - session.searches,
        results: rows.map((r) => ({
          ledgerRef: r.ledgerRef, title: r.title, authors: r.authors,
          year: r.publishedYear, url: r.url, excerpt: r.excerpt?.slice(0, 400),
        })),
        note: failed.length
          ? `${failed.join(", ")} did not respond; this search was partial and the ledger says so.`
          : undefined,
      });
    });
  });

  server.registerTool("gitlit_similarity_check", {
    title: "Score the premise against found prior art",
    description:
      "Score the premise against works already in this session's ledger. The scores are computed " +
      "by GitLit deterministically so anyone with a clone can reproduce them offline — they are " +
      "not your judgement and not adjustable. Returns a SUGGESTED verdict; you decide the actual " +
      "verdict and supply the reasoning in gitlit_record_novelty.",
    inputSchema: { owner: z.string(), slug: z.string() },
  }, async ({ owner, slug }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_similarity_check", { owner, slug }, async () => {
      const { content: premise } = await gitlit.readBlob(repo.id, ".gitlit/premise.md");
      if (!premise) throw toolRejected("no_premise", "This book has no premise recorded yet.");

      const rows = ledgerFor(ctx, session).all();
      if (rows.length === 0) {
        throw toolRejected("empty_ledger", "Search for prior works first — the ledger is empty.");
      }
      const works = rows.map((r) => ({
        source: "openlibrary" as const, externalId: r.ledgerRef, title: r.title ?? "",
        authors: r.authors ?? [], publishedYear: r.publishedYear, synopsis: r.excerpt,
        url: r.url,
      }));
      const scores = scoreNovelty(premise, works);
      return json({
        ...scores,
        comparedAgainst: rows.length,
        caveat: "Scores are lexical and deterministic. They measure textual overlap with the " +
                "blurbs we retrieved, not literary similarity, and low overlap is not originality.",
      });
    });
  });

  server.registerTool("gitlit_record_novelty", {
    title: "Record the novelty verdict",
    description:
      "Record your novelty verdict and reasoning. Your rationale is stored and displayed as YOUR " +
      "claim, clearly separated from GitLit's computed scores. If you record 'derivative' and the " +
      "author has the halt setting on, research pauses here until they decide — do not work " +
      "around that by recording a softer verdict than the evidence supports.",
    inputSchema: {
      owner: z.string(),
      slug: z.string(),
      verdict: z.enum(["sparse_prior_art", "crowded_field", "derivative"]),
      rationale: z.string().min(40).describe("Why, citing the nearest works by ledger ref."),
    },
  }, async ({ owner, slug, verdict, rationale }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_record_novelty", { verdict }, async () => {
      session.noveltyVerdict = verdict;
      const ledger = ledgerFor(ctx, session);

      if (verdict === "derivative") {
        session.status = "halted";
        session.haltReason = "derivative_premise";
        return json({
          recorded: true,
          verdict,
          halted: true,
          message:
            "Recorded as derivative, so research has paused. Tell the author what you found, " +
            "name the nearest works, and let them choose: revise the premise, or proceed anyway " +
            "with this verdict recorded in the architecture document. They respond in GitLit.",
        });
      }
      session.noveltyAnswered = true;
      return json({
        recorded: true,
        verdict,
        caveat: noveltyCaveat(["openlibrary", "googlebooks", "crossref", "semanticscholar"], []),
        ledgerRefs: ledger.refs(),
        nextStep: "Research the domains this book depends on, then commit the architecture.",
      });
    });
  });

  server.registerTool("gitlit_add_source", {
    title: "Add a source to the research ledger",
    description:
      "Add a URL to this book's research ledger. GitLit fetches and hashes the page itself and " +
      "stores the excerpt IT retrieved — not text you supply — so a URL that does not exist or " +
      "does not say what you expect is recorded as a failed fetch. Limited to 100 per session.",
    inputSchema: {
      owner: z.string(),
      slug: z.string(),
      url: z.string().url(),
      domain: z.string().optional().describe("Research domain, for grouping the ledger."),
      title: z.string().optional(),
    },
  }, async ({ owner, slug, url, domain, title }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_add_source", { url, domain }, async () => {
      ctx.sessions.spend(session, "fetches");
      const ledger = ledgerFor(ctx, session);
      try {
        const fetched = await fetchSource(url);
        const plain = toPlainText(fetched.text);
        const row = ledger.addFetched({
          url: fetched.url, title, excerpt: plain.slice(0, 1200), body: plain,
          status: fetched.status < 400 ? "ok" : "failed", domain,
        });
        return json({
          ledgerRef: row.ledgerRef,
          status: row.fetchStatus,
          httpStatus: fetched.status,
          contentHash: row.contentHash,
          excerpt: row.excerpt,
          fetchesRemaining: 100 - session.fetches,
          note: "This excerpt is what GitLit retrieved. Cite it by its ledgerRef.",
        });
      } catch (err) {
        const row = ledger.addFetched({ url, title, status: "failed", domain });
        const message = err instanceof Error ? err.message : String(err);
        return json({
          ledgerRef: row.ledgerRef,
          status: "failed",
          error: message,
          note: "Recorded as a failed fetch. You may not cite this source in the architecture.",
        });
      }
    });
  });

  server.registerTool("gitlit_commit_architecture", {
    title: "Commit the manuscript architecture",
    description:
      "Commit manuscript_architecture.md to the book. GitLit validates the structure, checks that " +
      "every S- citation exists in this session's ledger, stamps provenance as machine-authored, " +
      "signs it and issues a receipt. This tool CANNOT write to manuscript/ — the AI Researcher " +
      "produces plans, never prose. One commit per session.",
    inputSchema: {
      owner: z.string(),
      slug: z.string(),
      markdown: z.string().min(200).describe(
        "The full document. Required sections: 1. Premise, 2. Novelty Assessment, " +
        "3. Research Ledger, 4. Chapter Outline, 6. Where the AI stopped. " +
        "Chapters as '### Chapter N — Title `[chN]`', beats as '- `bN.N` text *(sources: S-001)*'. " +
        "Omit front matter; GitLit writes it.",
      ),
      message: z.string().default("Add manuscript architecture"),
    },
  }, async ({ owner, slug, markdown, message }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_commit_architecture", { message }, async () => {
      if (session.status === "halted" && !session.noveltyAnswered) {
        throw toolRejected(
          "novelty_halt",
          "Research is paused on a derivative verdict. The author must respond in GitLit " +
          "before an architecture can be committed.",
        );
      }
      if (!session.noveltyVerdict) {
        throw toolRejected(
          "no_novelty_verdict",
          "Record a novelty verdict with gitlit_record_novelty before committing.",
        );
      }
      // Belt and braces: the allowlist is also checked in gitd's commit path.
      assertAgentWritable("manuscript_architecture.md");

      const ledger = ledgerFor(ctx, session);
      // Validate BEFORE spending the quota. A rejection here is meant to be
      // correctable — the error names the available ledger refs so the agent
      // can fix the document and retry — so charging the single commit
      // allowance for a failed attempt would lock it out over a typo.
      const parsed = validateArchitecture(markdown, ledger);
      ctx.sessions.spend(session, "architectureCommits");

      const { content: premise } = await gitlit.readBlob(repo.id, ".gitlit/premise.md");
      const frontMatter = buildFrontMatter({
        sessionId: session.id,
        declaredModel: session.declaredModel,
        clientName: session.clientName,
        premiseHash: `sha256:${createHash("sha256").update(premise ?? "").digest("hex").slice(0, 16)}`,
        verdict: session.noveltyVerdict,
        scorerVersion: SCORER_VERSION,
      });

      const body = markdown.replace(/^---\n[\s\S]*?\n---\n*/, "");
      const document = `${frontMatter}\n\n${body.trim()}\n`;

      const result = await gitlit.commit(repo.id, {
        ref: "refs/heads/main",
        message,
        author: {
          name: session.clientName ? `${session.clientName} via MCP` : "Agent via MCP",
          email: "agent@gitlit.app",
        },
        newTextOrigin: "ai_generated",
        agentSessionId: session.id,
        declaredModel: session.declaredModel,
        evidence: [`mcp:${session.transport}`, `tool_calls:${session.toolCalls.length}`],
        changes: [
          { path: "manuscript_architecture.md", content: document },
          { path: ".gitlit/research/ledger.jsonl", content: ledger.toJsonl() },
          { path: `.gitlit/sessions/${session.id}.json`, content: JSON.stringify({
              id: session.id, transport: session.transport, clientName: session.clientName,
              declaredModel: session.declaredModel, startedAt: session.startedAt,
              noveltyVerdict: session.noveltyVerdict, toolCalls: session.toolCalls,
            }, null, 2) + "\n" },
        ],
      });

      session.status = "committed";
      return json({
        committed: true,
        sha: result.sha,
        provenance: result.provenance,
        receiptId: result.receiptId,
        chapters: parsed.chapters.length,
        beats: parsed.beats.length,
        citedSources: parsed.citedRefs.length,
        words: countWords(document),
        note:
          "Committed as machine-authored and signed. The author's own chapters remain untouched — " +
          "this document is the full extent of machine authorship for this session.",
      });
    });
  });

  server.registerTool("gitlit_read_document", {
    title: "Read a manuscript file with provenance",
    description:
      "Read a file from the book with its provenance annotations. Read-only — this server has no " +
      "tool that writes prose into manuscript/.",
    inputSchema: {
      owner: z.string(), slug: z.string(),
      path: z.string().describe("e.g. manuscript/chapters/01-the-lighthouse.md"),
    },
  }, async ({ owner, slug, path }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_read_document", { path }, async () => {
      const [{ content }, sidecar] = await Promise.all([
        gitlit.readBlob(repo.id, path),
        gitlit.readBlob(repo.id, `.gitlit/provenance/${path}.jsonl`),
      ]);
      if (content === null) throw toolRejected("not_found", `No such file: ${path}`);
      const spans = (sidecar.content ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return json({ path, wordCount: countWords(content), content, spans });
    });
  });

  server.registerTool("gitlit_provenance_summary", {
    title: "Summarise who wrote what",
    description:
      "Current human/machine share for the book, from the committed provenance record. " +
      "Read-only. Note that this records what happened inside GitLit; it cannot prove text " +
      "marked as human-written was not composed elsewhere.",
    inputSchema: { owner: z.string(), slug: z.string() },
  }, async ({ owner, slug }) => {
    const repo = await resolveRepo(owner, slug);
    const session = sessionFor(ctx, repo.id);
    return ctx.sessions.record(session, "gitlit_provenance_summary", { owner, slug }, async () => {
      const summary = await gitlit.provenance(owner, slug);
      const total = Object.values(summary.charsByOrigin).reduce((a, b) => a + b, 0);
      return json({
        ...summary,
        shares: Object.fromEntries(
          Object.entries(summary.charsByOrigin).map(([k, v]) => [k, total ? v / total : 0]),
        ),
        caveat: "Evidence, not proof. See the trust model in system_architecture.md §3.",
      });
    });
  });

  server.registerTool("gitlit_session_status", {
    title: "Show this session's recorded activity",
    description:
      "What GitLit has observed in this agent session: tool calls, quota use, ledger size and " +
      "novelty state. Useful for telling the author what will be recorded before you commit.",
    inputSchema: { owner: z.string(), slug: z.string() },
  }, async ({ owner, slug }) => {
    const repo = await resolveRepo(owner, slug);
    // A status read must not create a session, and must report the one that
    // did the work even after it has been committed and closed.
    const session = ctx.sessions.latestForRepo(repo.id, ctx.userId);
    if (!session) {
      return json({
        sessionId: null,
        status: "none",
        note: "No agent session has run against this book yet.",
      });
    }
    const ledger = ledgerFor(ctx, session);
    return json({
      sessionId: session.id,
      status: session.status,
      haltReason: session.haltReason,
      declaredModel: session.declaredModel ?? "unstated",
      declaredModelNote: "Recorded as your claim. GitLit does not verify which model is running.",
      toolCalls: session.toolCalls.length,
      searchesUsed: session.searches,
      fetchesUsed: session.fetches,
      ledgerRows: ledger.all().length,
      noveltyVerdict: session.noveltyVerdict ?? null,
    });
  });
}
