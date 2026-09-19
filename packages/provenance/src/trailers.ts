import type { ProvenanceClass } from "@gitlit/core";

export interface Trailers {
  provenance: ProvenanceClass;
  agentSession?: string;
  /** What the agent said it was. Never verified (§8.4). */
  declaredModel?: string;
  spansDigest?: string;
  evidence?: string[];
  receipt?: string;
  configVersion?: string;
}

const KEYS = {
  provenance: "GitLit-Provenance",
  agentSession: "GitLit-Agent-Session",
  declaredModel: "GitLit-Declared-Model",
  spansDigest: "GitLit-Spans-Digest",
  evidence: "GitLit-Evidence",
  receipt: "GitLit-Receipt",
  configVersion: "GitLit-Config-Version",
} as const;

/**
 * Render trailers onto a commit message. These survive `git clone` and are
 * readable with plain `git log`, with no GitLit account and no network (§7.1).
 */
export function formatMessage(subject: string, t: Trailers): string {
  const lines = [`${KEYS.provenance}: ${t.provenance}`];
  if (t.agentSession) lines.push(`${KEYS.agentSession}: ${t.agentSession}`);
  if (t.declaredModel) lines.push(`${KEYS.declaredModel}: ${t.declaredModel} (agent claim, unverified)`);
  if (t.spansDigest) lines.push(`${KEYS.spansDigest}: ${t.spansDigest}`);
  if (t.evidence?.length) lines.push(`${KEYS.evidence}: ${t.evidence.join(",")}`);
  if (t.configVersion) lines.push(`${KEYS.configVersion}: ${t.configVersion}`);
  if (t.receipt) lines.push(`${KEYS.receipt}: ${t.receipt}`);
  return `${subject.trimEnd()}\n\n${lines.join("\n")}\n`;
}

export function parseMessage(message: string): Partial<Trailers> & { subject: string } {
  const lines = message.split("\n");
  const out: Partial<Trailers> & { subject: string } = { subject: lines[0] ?? "" };
  for (const line of lines) {
    const m = /^(GitLit-[A-Za-z-]+):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue!.replace(/\s*\(agent claim, unverified\)\s*$/, "");
    switch (key) {
      case KEYS.provenance: out.provenance = value as ProvenanceClass; break;
      case KEYS.agentSession: out.agentSession = value; break;
      case KEYS.declaredModel: out.declaredModel = value; break;
      case KEYS.spansDigest: out.spansDigest = value; break;
      case KEYS.evidence: out.evidence = value.split(",").filter(Boolean); break;
      case KEYS.receipt: out.receipt = value; break;
      case KEYS.configVersion: out.configVersion = value; break;
    }
  }
  return out;
}
