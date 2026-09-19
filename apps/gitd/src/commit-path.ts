import { createHash } from "node:crypto";
import {
  isProseFile, normalizePath, newReceiptId,
  type ProvenanceClass, type ProvenanceSpan, type SpanOrigin,
} from "@gitlit/core";
import { countWords, normalize } from "@gitlit/prose";
import {
  carryForwardSpans, classifyCommit, spansDigest, machineShare,
  toJsonl, fromJsonl, formatMessage, DEFAULT_CONFIG,
  issueReceipt, payloadHash, receiptsFromJsonl, receiptsToJsonl,
  type KeyPair, type Receipt,
} from "@gitlit/provenance";
import { commitChanges, readFileAt, type FileChange } from "./repo.js";

const RECEIPT_CHAIN = ".gitlit/receipts/chain.jsonl";
const sidecarPath = (p: string) => `.gitlit/provenance/${normalizePath(p)}.jsonl`;

export interface WriteRequest {
  gitdir: string;
  repoId: string;
  ref: string;
  changes: { path: string; content: string | null }[];
  message: string;
  author: { name: string; email: string; id?: string };
  /** How this text arrived. Decides the origin of genuinely new prose. */
  newTextOrigin: SpanOrigin;
  agentSessionId?: string;
  declaredModel?: string;
  evidence?: string[];
  signingKey: KeyPair;
  timestamp?: number;
}

export interface WriteResult {
  sha: string;
  provenance: ProvenanceClass;
  spansDigest: string;
  receiptId: string;
  wordsAdded: number;
  wordsRemoved: number;
  machineShare: number;
  spansByPath: Record<string, ProvenanceSpan[]>;
}

/**
 * The single place provenance is written (§5).
 *
 * Normalize prose, recompute spans against the parent commit, write the
 * sidecars, derive the commit class from the spans, stamp trailers, commit,
 * then issue a receipt chained to the previous one.
 *
 * Provenance is never taken from the caller: `newTextOrigin` describes how the
 * text arrived, but what survives from the parent is recomputed here (§7.3).
 */
export async function writeCommit(req: WriteRequest): Promise<WriteResult> {
  const cfg = DEFAULT_CONFIG;
  const fileChanges: FileChange[] = [];
  const spansByPath: Record<string, ProvenanceSpan[]> = {};
  const changedSpans: ProvenanceSpan[] = [];
  let wordsAdded = 0;
  let wordsRemoved = 0;

  for (const change of req.changes) {
    const path = normalizePath(change.path);

    if (change.content === null) {
      const before = await readFileAt(req.gitdir, req.ref, path);
      if (before && isProseFile(path)) wordsRemoved += countWords(before);
      fileChanges.push({ path, content: null });
      fileChanges.push({ path: sidecarPath(path), content: null });
      continue;
    }

    const content = isProseFile(path) ? normalize(change.content) : change.content;
    fileChanges.push({ path, content });

    if (!isProseFile(path) && path !== "manuscript_architecture.md") continue;

    const before = (await readFileAt(req.gitdir, req.ref, path)) ?? "";
    const priorSidecar = await readFileAt(req.gitdir, req.ref, sidecarPath(path));
    const priorSpans = priorSidecar ? fromJsonl(priorSidecar) : [];

    const spans = carryForwardSpans(before, content, priorSpans, {
      author: req.author.id,
      session: req.agentSessionId,
      declaredModel: req.declaredModel,
      newTextOrigin: req.newTextOrigin,
      evidence: req.evidence ?? [],
      config: cfg,
      ...(req.timestamp ? { ts: new Date(req.timestamp * 1000).toISOString() } : {}),
    });

    spansByPath[path] = spans;
    fileChanges.push({ path: sidecarPath(path), content: toJsonl(spans) });

    const beforeWords = countWords(before);
    const afterWords = countWords(content);
    if (afterWords > beforeWords) wordsAdded += afterWords - beforeWords;
    else wordsRemoved += beforeWords - afterWords;

    // Only spans that differ from the parent inform the commit class.
    const priorKeys = new Set(priorSpans.map((s) => `${s.start}:${s.end}:${s.origin}`));
    for (const s of spans) if (!priorKeys.has(`${s.start}:${s.end}:${s.origin}`)) changedSpans.push(s);
  }

  const allSpans = Object.values(spansByPath).flat();
  const digest = spansDigest(allSpans);
  const provenance = classifyCommit(changedSpans);
  const receiptId = newReceiptId();

  const message = formatMessage(req.message, {
    provenance,
    agentSession: req.agentSessionId,
    declaredModel: req.declaredModel,
    spansDigest: digest,
    evidence: req.evidence ?? [],
    configVersion: cfg.version,
    receipt: receiptId,
  });

  const chainText = await readFileAt(req.gitdir, req.ref, RECEIPT_CHAIN);
  const chain: Receipt[] = chainText ? receiptsFromJsonl(chainText) : [];
  const prev = chain.length > 0 ? payloadHash(chain[chain.length - 1]!) : null;

  // The commit sha cannot be known before the commit exists, so the receipt
  // binds the content digest and is appended in a follow-up commit.
  const sha = await commitChanges({
    gitdir: req.gitdir, ref: req.ref, changes: fileChanges, message,
    author: { name: req.author.name, email: req.author.email },
    ...(req.timestamp ? { timestamp: req.timestamp } : {}),
  });

  const receipt = issueReceipt({
    id: receiptId,
    repo: req.repoId,
    commit: sha,
    spansDigest: digest,
    configVersion: cfg.version,
    session: req.agentSessionId,
    declaredModel: req.declaredModel,
    issuedAt: new Date((req.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    prev,
  }, req.signingKey);

  await commitChanges({
    gitdir: req.gitdir, ref: req.ref,
    changes: [{ path: RECEIPT_CHAIN, content: receiptsToJsonl([...chain, receipt]) }],
    message: `Record receipt ${receiptId}\n\nGitLit-Provenance: human\nGitLit-Receipt: ${receiptId}\n`,
    author: { name: "GitLit", email: "receipts@gitlit.app" },
    ...(req.timestamp ? { timestamp: req.timestamp + 1 } : {}),
  });

  return {
    sha, provenance, spansDigest: digest, receiptId, wordsAdded, wordsRemoved,
    machineShare: machineShare(allSpans), spansByPath,
  };
}

export const contentHash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
