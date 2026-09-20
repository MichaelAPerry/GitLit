import { createHash } from "node:crypto";
import { newAgentSessionId, toolRejected } from "@gitlit/core";

/**
 * Agent session state (§11.4, §2.5).
 *
 * Records what an EXTERNAL agent did at our boundary. We observe tool calls,
 * arguments, ordering and timing. We do not observe the model, the prompt, the
 * reasoning or the token spend — all of that is inside the author's own Claude
 * session, and we must never imply otherwise.
 */

export interface ToolCall {
  seq: number;
  tool: string;
  argsHash: string;
  argsRedacted: unknown;
  resultHash?: string;
  status: "ok" | "rejected" | "failed";
  rejectReason?: string;
  durationMs: number;
  calledAt: string;
}

/** §8.6 — we meter what costs us money or goodwill, never tokens. */
export const QUOTAS = { searches: 40, fetches: 100, architectureCommits: 1 } as const;

export interface AgentSession {
  id: string;
  repoId: string;
  userId: string;
  transport: "stdio" | "http";
  clientName?: string;
  /** AGENT CLAIM. Never verified, and rendered as a claim (§8.4). */
  declaredModel?: string;
  status: "active" | "halted" | "committed" | "abandoned";
  haltReason?: string;
  toolCalls: ToolCall[];
  searches: number;
  fetches: number;
  architectureCommits: number;
  noveltyVerdict?: "sparse_prior_art" | "crowded_field" | "derivative";
  /** Which scorer produced that verdict — lexical only, or lexical + semantic. */
  noveltyScorer?: string;
  noveltyAnswered: boolean;
  startedAt: string;
  lastSeenAt: string;
}

const hash = (v: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 32)}`;

export class SessionStore {
  private sessions = new Map<string, AgentSession>();

  open(input: {
    repoId: string; userId: string; transport: "stdio" | "http";
    clientName?: string; declaredModel?: string;
  }): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: newAgentSessionId(),
      ...input,
      status: "active",
      toolCalls: [],
      searches: 0,
      fetches: 0,
      architectureCommits: 0,
      noveltyAnswered: false,
      startedAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AgentSession {
    const s = this.sessions.get(id);
    if (!s) throw toolRejected("unknown_session", `No such agent session: ${id}`);
    return s;
  }

  /** Per repo+user, so a dropped MCP connection resumes rather than restarts. */
  forRepo(repoId: string, userId: string): AgentSession | undefined {
    return [...this.sessions.values()].find(
      (s) => s.repoId === repoId && s.userId === userId && s.status === "active",
    );
  }

  /**
   * Most recent session for this repo and user whatever its status. Read-only
   * callers use this: after a commit the session is no longer `active`, and
   * reporting a fresh empty one would tell the author nothing was recorded
   * moments after their architecture was committed.
   */
  latestForRepo(repoId: string, userId: string): AgentSession | undefined {
    return [...this.sessions.values()]
      .filter((s) => s.repoId === repoId && s.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  /**
   * Log a call and return its result. Rejections are recorded too — a refused
   * call is evidence of what the agent attempted, and dropping it would leave
   * the most interesting entries out of the audit trail.
   */
  async record<T>(
    session: AgentSession, tool: string, args: unknown, run: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const seq = session.toolCalls.length;
    const entry: ToolCall = {
      seq, tool, argsHash: hash(args), argsRedacted: redact(args),
      status: "ok", durationMs: 0, calledAt: new Date().toISOString(),
    };
    try {
      const result = await run();
      entry.resultHash = hash(result);
      return result;
    } catch (err) {
      const problem = err as { detail?: { reject_reason?: string }; message?: string };
      entry.status = problem.detail?.reject_reason ? "rejected" : "failed";
      entry.rejectReason = problem.detail?.reject_reason ?? problem.message;
      throw err;
    } finally {
      entry.durationMs = Date.now() - started;
      session.toolCalls.push(entry);
      session.lastSeenAt = new Date().toISOString();
      this.onToolCall?.(session, entry);
    }
  }

  onToolCall?: (session: AgentSession, call: ToolCall) => void;

  spend(session: AgentSession, kind: "searches" | "fetches" | "architectureCommits"): void {
    const limit = kind === "architectureCommits" ? QUOTAS.architectureCommits : QUOTAS[kind];
    if (session[kind] >= limit) {
      throw toolRejected("quota_exceeded", `Session limit reached for ${kind} (${limit}).`);
    }
    session[kind] += 1;
  }

  all(): AgentSession[] { return [...this.sessions.values()]; }
}

/** Drop anything long or free-text from the stored argument echo. */
function redact(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > 200 ? `«${v.length} chars»` : v;
  }
  return out;
}
