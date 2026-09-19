/**
 * GitLit schema — see system_architecture.md §11.
 *
 * Postgres indexes metadata and derived analysis. It is NOT the source of
 * truth for content or provenance: that lives in the Git repository (§2.3).
 * Every table here is reproducible by replaying a repo's history, which the
 * `reindex` command does and CI asserts.
 */
import {
  pgTable, text, integer, boolean, timestamp, jsonb, real, bigserial, primaryKey,
  index, uniqueIndex, customType, doublePrecision,
} from "drizzle-orm/pg-core";

const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (v) => `[${v.join(",")}]`,
    fromDriver: (v) => JSON.parse(v) as number[],
  });

/** Local, version-pinned embeddings (§2.7). Dimension is part of the contract. */
const embedding = vector(384);

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------- identity

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  displayName: text("display_name"),
  penName: text("pen_name"),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  plan: text("plan").notNull().default("free"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: updated(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  createdAt: now(),
}, (t) => [uniqueIndex("accounts_provider_uq").on(t.provider, t.providerAccountId)]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("publisher"),
  createdAt: now(),
});

export const organizationMembers = pgTable("organization_members", {
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: now(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);

// ------------------------------------------------------------ repositories

export const repositories = pgTable("repositories", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  form: text("form").notNull(),
  genre: text("genre").array(),
  visibility: text("visibility").notNull().default("private"),
  defaultBranch: text("default_branch").notNull().default("main"),
  storagePath: text("storage_path").notNull(),
  targetWords: integer("target_words"),
  currentWords: integer("current_words").notNull().default(0),
  phase: text("phase").notNull().default("premise"),
  signingKeyId: text("signing_key_id"),
  /** §16 decision 1: pause the run on a derivative verdict. Default on. */
  haltOnDerivative: boolean("halt_on_derivative").notNull().default(true),
  /** §16 decision 5 / §16.3: opt-in, default off, gated on the standard. */
  galleryOptIn: boolean("gallery_opt_in").notNull().default(false),
  /** §16.2 rung 3. Hidden from discovery — never from the author. */
  delistedAt: timestamp("delisted_at", { withTimezone: true }),
  delistedReason: text("delisted_reason"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("repositories_owner_slug").on(t.ownerUserId, t.ownerOrgId, t.slug)]);

export const repositoryCollaborators = pgTable("repository_collaborators", {
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  invitedBy: text("invited_by").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => [primaryKey({ columns: [t.repoId, t.userId] })]);

export const branches = pgTable("branches", {
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  headSha: text("head_sha").notNull(),
  kind: text("kind").notNull().default("draft"),
  updatedAt: updated(),
}, (t) => [primaryKey({ columns: [t.repoId, t.name] })]);

export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  kind: text("kind").notNull(),
  chapterNo: integer("chapter_no"),
  title: text("title"),
  orderIndex: integer("order_index").notNull().default(0),
  status: text("status").notNull().default("planned"),
  wordCount: integer("word_count").notNull().default(0),
  aiWordShare: real("ai_word_share").notNull().default(0),
  headSha: text("head_sha").notNull(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("documents_repo_path").on(t.repoId, t.path)]);

// ---------------------------------------------------------------- history

export const commits = pgTable("commits", {
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  sha: text("sha").notNull(),
  parents: text("parents").array().notNull().default([]),
  authorId: text("author_id").references(() => users.id),
  authorName: text("author_name").notNull(),
  authorEmail: text("author_email").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  message: text("message").notNull(),
  provenance: text("provenance").notNull(),
  agentSessionId: text("agent_session_id"),
  declaredModel: text("declared_model"),
  spansDigest: text("spans_digest"),
  configVersion: text("config_version"),
  wordsAdded: integer("words_added").notNull().default(0),
  wordsRemoved: integer("words_removed").notNull().default(0),
  filesChanged: integer("files_changed").notNull().default(0),
  evidence: text("evidence").array().notNull().default([]),
  phase: text("phase"),
}, (t) => [
  primaryKey({ columns: [t.repoId, t.sha] }),
  index("commits_repo_time").on(t.repoId, t.committedAt),
]);

export const provenanceSpans = pgTable("provenance_spans", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  path: text("path").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  origin: text("origin").notNull(),
  agentSessionId: text("agent_session_id"),
  declaredModel: text("declared_model"),
  retained: real("retained"),
  beatId: text("beat_id"),
  authorId: text("author_id").references(() => users.id),
  evidence: text("evidence").array().notNull().default([]),
}, (t) => [index("spans_lookup").on(t.repoId, t.path, t.commitSha)]);

export const signingKeys = pgTable("signing_keys", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  algo: text("algo").notNull().default("ed25519"),
  publicKey: text("public_key").notNull(),
  privateKeyEnc: text("private_key_enc").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: now(),
});

export const provenanceReceipts = pgTable("provenance_receipts", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  prevReceiptHash: text("prev_receipt_hash"),
  spansDigest: text("spans_digest").notNull(),
  payload: jsonb("payload").notNull(),
  signature: text("signature").notNull(),
  signingKeyId: text("signing_key_id").notNull().references(() => signingKeys.id),
  anchoredAt: timestamp("anchored_at", { withTimezone: true }),
  anchorRef: text("anchor_ref"),
  createdAt: now(),
}, (t) => [uniqueIndex("receipts_repo_commit").on(t.repoId, t.commitSha)]);

export const timelineEvents = pgTable("timeline_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(),
  phase: text("phase"),
  commitSha: text("commit_sha"),
  agentSessionId: text("agent_session_id"),
  actorId: text("actor_id").references(() => users.id),
  payload: jsonb("payload").notNull().default({}),
}, (t) => [index("timeline_scan").on(t.repoId, t.occurredAt)]);

// ------------------------------------------------- input provenance (§7.5)

export const authoringSessions = pgTable("authoring_sessions", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  paths: text("paths").array().notNull().default([]),
  wordsAdded: integer("words_added").notNull().default(0),
  wordsRemoved: integer("words_removed").notNull().default(0),
  /** A count only. We never store what was typed (§7.5.1). */
  keystrokes: integer("keystrokes").notNull().default(0),
  ikiHistogram: integer("iki_histogram").array().notNull().default([]),
  medianWpm: real("median_wpm"),
  burstCount: integer("burst_count"),
  modeWords: jsonb("mode_words").notNull().default({}),
  client: text("client").notNull(),
  commitShas: text("commit_shas").array().notNull().default([]),
}, (t) => [index("sessions_repo").on(t.repoId, t.startedAt)]);

export const inputEvents = pgTable("input_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull().references(() => authoringSessions.id, { onDelete: "cascade" }),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  inputMode: text("input_mode").notNull(),
  charCount: integer("char_count").notNull(),
  wordCount: integer("word_count").notNull(),
  /** Hash only — the pasted text itself is never stored (§7.5.5). */
  contentHash: text("content_hash").notNull(),
  isTrusted: boolean("is_trusted").notNull().default(true),
  matchedSessionId: text("matched_session_id"),
  /** An AUTHOR CLAIM about origin, rendered distinctly from observation. */
  authorNote: text("author_note"),
  authorNotedAt: timestamp("author_noted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("input_events_repo").on(t.repoId, t.occurredAt)]);

// ------------------------------------------ agent sessions & research (§11.4)

export const agentSessions = pgTable("agent_sessions", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  transport: text("transport").notNull(),
  clientName: text("client_name"),
  /** AGENT CLAIM, never verified (§8.4). */
  declaredModel: text("declared_model"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  haltReason: text("halt_reason"),
  premiseId: text("premise_id"),
  outputCommitSha: text("output_commit_sha"),
  toolCalls: integer("tool_calls").notNull().default(0),
  searches: integer("searches").notNull().default(0),
  fetches: integer("fetches").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("agent_sessions_repo").on(t.repoId, t.startedAt)]);

export const agentToolCalls = pgTable("agent_tool_calls", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  tool: text("tool").notNull(),
  argsHash: text("args_hash").notNull(),
  argsRedacted: jsonb("args_redacted"),
  resultHash: text("result_hash"),
  resultRef: text("result_ref"),
  status: text("status").notNull(),
  rejectReason: text("reject_reason"),
  durationMs: integer("duration_ms"),
  calledAt: timestamp("called_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("tool_calls_session_seq").on(t.sessionId, t.seq)]);

export const premises = pgTable("premises", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  text: text("text").notNull(),
  textHash: text("text_hash").notNull(),
  themes: text("themes").array(),
  entities: jsonb("entities"),
  embedding: embedding("embedding"),
  embeddingModel: text("embedding_model").notNull(),
  createdAt: now(),
}, (t) => [uniqueIndex("premises_repo_version").on(t.repoId, t.version)]);

export const researchSources = pgTable("research_sources", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  ledgerRef: text("ledger_ref").notNull(),
  discoveredVia: text("discovered_via").notNull(),
  /** The exact query WE ran — not what the model said it searched (§8.2). */
  query: text("query"),
  sourceType: text("source_type").notNull(),
  url: text("url"),
  title: text("title"),
  authors: text("authors").array(),
  publisher: text("publisher"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  identifier: text("identifier"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  fetchStatus: text("fetch_status").notNull(),
  contentHash: text("content_hash"),
  excerpt: text("excerpt"),
  excerptRef: text("excerpt_ref"),
  domain: text("domain"),
  usedInBeats: text("used_in_beats").array(),
  embedding: embedding("embedding"),
}, (t) => [index("sources_repo").on(t.repoId, t.domain)]);

export const noveltyReports = pgTable("novelty_reports", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  premiseHash: text("premise_hash").notNull(),
  verdict: text("verdict").notNull(),
  /** Computed by us, deterministically and reproducibly (§2.7). */
  corpusSimilarity: real("corpus_similarity"),
  conceptOverlap: real("concept_overlap"),
  marketDensity: integer("market_density"),
  corpora: text("corpora").array().notNull(),
  searchedAt: timestamp("searched_at", { withTimezone: true }).notNull(),
  nearestWorks: jsonb("nearest_works").notNull(),
  /** The agent's prose reasoning — an agent claim, shown as such. */
  rationale: text("rationale").notNull(),
  authorResponse: text("author_response"),
  authorRespondedAt: timestamp("author_responded_at", { withTimezone: true }),
});

export const priorWorks = pgTable("prior_works", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  externalId: text("external_id"),
  title: text("title").notNull(),
  authors: text("authors").array(),
  publishedYear: integer("published_year"),
  isbn: text("isbn"),
  synopsis: text("synopsis"),
  subjects: text("subjects").array(),
  embedding: embedding("embedding"),
  fetchedAt: now(),
}, (t) => [uniqueIndex("prior_works_source_ext").on(t.source, t.externalId)]);

// ------------------------------------------------ diffs, review, platform

export const diffCache = pgTable("diff_cache", {
  key: text("key").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  algoVersion: text("algo_version").notNull(),
  payload: jsonb("payload").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const derivations = pgTable("derivations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  headSha: text("head_sha").notNull(),
  beatId: text("beat_id"),
  path: text("path").notNull(),
  paraIndex: integer("para_index").notNull(),
  relation: text("relation").notNull(),
  similarity: doublePrecision("similarity"),
  method: text("method").notNull(),
}, (t) => [uniqueIndex("derivations_uq").on(t.repoId, t.headSha, t.path, t.paraIndex, t.beatId)]);

export const reviewThreads = pgTable("review_threads", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path"),
  commitSha: text("commit_sha"),
  startOffset: integer("start_offset"),
  endOffset: integer("end_offset"),
  anchorText: text("anchor_text"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: now(),
});

export const reviewComments = pgTable("review_comments", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => reviewThreads.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: now(),
});

export const verificationLinks = pgTable("verification_links", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  scope: text("scope").notNull(),
  ref: text("ref").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  createdAt: now(),
});

export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: now(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: text("actor_id").references(() => users.id),
  repoId: text("repo_id").references(() => repositories.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  metadata: jsonb("metadata").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  repoId: text("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: now(),
});
