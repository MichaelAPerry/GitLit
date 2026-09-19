import { createHash } from "node:crypto";
import type { Work } from "./corpora.js";

/**
 * The research ledger (§8.2).
 *
 * Every row here is written by GitLit's own search and fetch tools, BEFORE
 * results are handed to the agent. The model cannot claim to have searched
 * what it did not search, omit a source it found inconvenient, or cite a page
 * it never read — because it never touches a corpus or a URL directly.
 *
 * Honesty is a consequence of the tool surface, not of the model's cooperation.
 */

export interface LedgerRow {
  ledgerRef: string;
  discoveredVia: "search_query" | "direct_fetch" | "user_supplied";
  /** The exact query WE ran. */
  query?: string;
  sourceType: "web" | "book" | "paper" | "dataset";
  url?: string;
  title?: string;
  authors?: string[];
  publishedYear?: number;
  identifier?: string;
  retrievedAt: string;
  fetchStatus: "ok" | "failed" | "not_fetched";
  /** Hash of what WE retrieved, not what the model reported. */
  contentHash?: string;
  /** The excerpt WE extracted. */
  excerpt?: string;
  domain?: string;
  usedInBeats?: string[];
}

export const contentHash = (s: string) =>
  `sha256:${createHash("sha256").update(s).digest("hex")}`;

export class Ledger {
  private rows: LedgerRow[] = [];
  private counter = 0;

  private nextRef(): string {
    this.counter += 1;
    return `S-${String(this.counter).padStart(3, "0")}`;
  }

  /** Called with results from a query we ran ourselves. */
  addSearchResults(query: string, works: Work[], domain?: string): LedgerRow[] {
    const now = new Date().toISOString();
    const added = works.map((w) => {
      const row: LedgerRow = {
        ledgerRef: this.nextRef(),
        discoveredVia: "search_query",
        query,
        sourceType: w.source === "crossref" || w.source === "semanticscholar" ? "paper" : "book",
        url: w.url,
        title: w.title,
        authors: w.authors,
        publishedYear: w.publishedYear,
        identifier: w.identifier,
        retrievedAt: now,
        fetchStatus: "ok",
        excerpt: w.synopsis?.slice(0, 1200),
        contentHash: w.synopsis ? contentHash(w.synopsis) : undefined,
        domain,
      };
      this.rows.push(row);
      return row;
    });
    return added;
  }

  /**
   * Record a fetched URL. A failed fetch is still a row — a hallucinated
   * citation should appear in the ledger as a failure, not vanish.
   */
  addFetched(input: {
    url: string; title?: string; excerpt?: string; body?: string;
    status: "ok" | "failed"; domain?: string;
  }): LedgerRow {
    const row: LedgerRow = {
      ledgerRef: this.nextRef(),
      discoveredVia: "direct_fetch",
      sourceType: "web",
      url: input.url,
      title: input.title,
      retrievedAt: new Date().toISOString(),
      fetchStatus: input.status,
      contentHash: input.body ? contentHash(input.body) : undefined,
      excerpt: input.excerpt?.slice(0, 1200),
      domain: input.domain,
    };
    this.rows.push(row);
    return row;
  }

  has(ref: string): boolean { return this.rows.some((r) => r.ledgerRef === ref); }
  all(): LedgerRow[] { return [...this.rows]; }
  refs(): string[] { return this.rows.map((r) => r.ledgerRef); }

  /** `.gitlit/research/ledger.jsonl` — append-only, committed with the book. */
  toJsonl(): string { return this.rows.map((r) => JSON.stringify(r)).join("\n") + "\n"; }

  /** Human-readable section for `manuscript_architecture.md` §3. */
  toMarkdown(): string {
    if (this.rows.length === 0) return "_No sources recorded._\n";
    const byDomain = new Map<string, LedgerRow[]>();
    for (const r of this.rows) {
      const key = r.domain ?? "General";
      byDomain.set(key, [...(byDomain.get(key) ?? []), r]);
    }
    let out = "";
    for (const [domain, rows] of byDomain) {
      out += `\n### Domain: ${domain}\n`;
      for (const r of rows) {
        const who = r.authors?.length ? ` — ${r.authors.slice(0, 3).join(", ")}` : "";
        const year = r.publishedYear ? ` (${r.publishedYear})` : "";
        out += `- **[${r.ledgerRef}]** *${r.title ?? r.url}*${who}${year}` +
               ` — retrieved ${r.retrievedAt.slice(0, 10)}`;
        out += r.fetchStatus === "failed" ? ` — **fetch failed**\n` : `\n`;
        if (r.url) out += `  ${r.url}\n`;
        if (r.excerpt) out += `  > ${r.excerpt.slice(0, 280)}\n`;
      }
    }
    return out;
  }
}
