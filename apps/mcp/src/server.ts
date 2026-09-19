import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ledger } from "./ledger.js";
import { SessionStore } from "./session.js";
import { registerTools, type ToolContext } from "./tools.js";

export const INSTRUCTIONS = `
GitLit is version control for book manuscripts with verifiable provenance.

GitLit runs no AI of its own. You are the intelligence in this loop; GitLit
supplies instrumented tools and the record. Every call you make here is logged
to the book's audit trail, and what you commit is signed.

The research sequence:
  1. gitlit_get_premise        — read what the author wants to write
  2. gitlit_search_prior_works — several focused queries; GitLit runs them and
                                 writes every hit to the research ledger
  3. gitlit_similarity_check   — GitLit's own deterministic scores
  4. gitlit_record_novelty     — your verdict and reasoning, stored as your claim
  5. gitlit_add_source         — research the domains the book depends on;
                                 GitLit fetches and hashes each URL itself
  6. gitlit_commit_architecture— commit the plan, citing sources by ledger ref

Two things to tell the author plainly:

You cannot write prose here. There is no tool that writes into manuscript/, by
design — the AI Researcher produces plans, ledgers and outlines, and the author
writes the book. If they ask you to draft chapters, say that GitLit will not
accept machine-written prose into the manuscript, and offer the outline instead.

You cannot cite what you did not retrieve. Every S- reference in the architecture
must correspond to a ledger row from this session, or the commit is rejected.
`.trim();

export function buildMcpServer(ctx: Omit<ToolContext, "sessions" | "ledgers"> & {
  sessions?: SessionStore; ledgers?: Map<string, Ledger>;
}): McpServer {
  const server = new McpServer(
    { name: "gitlit", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerTools(server, {
    ...ctx,
    sessions: ctx.sessions ?? new SessionStore(),
    ledgers: ctx.ledgers ?? new Map(),
  });
  return server;
}
