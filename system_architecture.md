# GitLit — System Architecture

**Version:** 0.1 (proposal, pending approval)
**Date:** 2026-09-19
**Status:** Step 1 deliverable. No code scaffolded yet.

---

## 0. What we are building

A version-control platform for book-length prose, where the *provenance* of every
sentence is a first-class, verifiable artifact rather than an afterthought.

The wedge: AI is now inside every author's workflow, and the publishing industry has
no credible way to answer "how much of this did a machine write, and at which stage?"
GitLit answers that by making the machine's work a **recorded, signed, replayable
part of the manuscript's history** instead of an invisible upstream step. The AI
research phase is not hidden — it is committed, attributed, and diffable against
what the human ultimately wrote.

Four features define v1:

| # | Feature | One-line definition |
|---|---------|---------------------|
| 1 | **Author Repositories** | Version-controlled book projects whose unit of change is the sentence, not the line of code. |
| 2 | **Automated AI Researcher** | A pipeline that takes a premise, checks whether it is novel, researches it, and commits `manuscript_architecture.md`. |
| 3 | **Provenance Diff Viewer** | A three-track comparison showing where AI planning ended and human authorship began. |
| 4 | **Prose Timeline** | The manuscript's life story, from premise to final draft, rendered as phases rather than a commit list. |

---

## 1. Glossary (these terms are used precisely throughout)

- **Repository** — one book. Contains manuscript files, architecture doc, research ledger, provenance sidecars.
- **Premise** — the author's initial idea, 1–3 paragraphs. The seed input to the AI Researcher.
- **Novelty check** — a search+similarity sweep answering "has this book already been written?" Produces a `novelty_report`. It is *evidence*, not a legal or originality ruling (see §3).
- **Research run** — one execution of the AI Researcher pipeline. Has an id, a full step log, token/cost accounting, and produces at most one commit.
- **Research ledger** — append-only record of every source the AI consulted, with URL, retrieval timestamp, content hash, and the excerpt actually used.
- **`manuscript_architecture.md`** — the machine-authored planning document: research ledger + chapter outline + open questions. Format specified in §6.3.
- **Provenance class** — commit-level origin: `ai`, `human`, or `hybrid`.
- **Provenance span** — character-range-level origin within a file. The fine-grained truth.
- **Divergence** — how far the finished prose has moved from the AI's plan. The number publishers will actually care about.
- **Receipt** — a signed, hash-chained attestation binding a commit to its provenance record.

---

## 2. Key design decisions

Each decision states the choice, the reason, and what we gave up.

### 2.1 Do we fork GitHub?

**No.** Recommendation: build on plain Git plumbing, own the layer above it.

Three facts drive this:

1. **GitHub is not open source.** There is nothing to fork. The forkable GitHub-shaped
   products are Forgejo/Gitea (Go) and GitLab CE (Ruby). "Fork GitHub" in practice means
   "fork Gitea."
2. **A Gitea fork gives us the 80% we don't need and fights us on the 20% we do.** Issues,
   CI, packages, releases, org permissions — all excellent, all irrelevant to a novelist.
   Meanwhile the parts we must own — sentence-level diffing, span provenance, a three-track
   comparison view, an AI pipeline that commits on the author's behalf — all live in the
   diff/storage layer that a fork would make us surgically replace while carrying merge
   debt from upstream forever.
3. **The valuable thing is not the Git server.** It is the provenance model. Git is a
   content-addressed store we get for free; that is all we need from it.

**So:** every GitLit repository *is a real bare Git repository*. Authors can `git clone`
it. Claude Code can work in it natively. We add a thin service over libgit2 and our own
semantics on top. If we later want federation or self-hosting, Forgejo can be adopted as
a *backend* without rewriting our provenance layer.

**Trade-off accepted:** we write our own auth, permissions, web Git UI, and smart-HTTP
transport. That is roughly 4–6 weeks of work we would otherwise inherit. Worth it.

### 2.2 Storage format: Markdown with semantic line breaks

Git's diff is line-oriented. Prose is not. A novelist who fixes one word in a 400-word
paragraph produces a diff that says "this entire paragraph changed" — useless.

**Decision:** the canonical on-disk format is Markdown, normalized on every write to
**one sentence per line** (semantic line breaks). A prose normalizer runs in the commit
path using `Intl.Segmenter` for sentence boundaries, with an abbreviation guard for
prose-specific cases (`Mr.`, `Dr.`, `Ms.`, `St.`, ellipses, dialogue punctuation, quoted
sentences ending mid-line).

This single choice makes native Git diffs meaningful for prose, makes `git blame`
work at sentence granularity, and makes our provenance spans stable under editing.
Editors never see the line breaks — the web editor and export render them as flowing
paragraphs (blank line = paragraph break, single newline = sentence break).

**Trade-off accepted:** files on disk look unusual if opened raw in Word. Export
handles this. Import de-normalizes then re-normalizes.

### 2.3 Provenance lives in Git, Postgres is an index

The source of truth for provenance is inside the repository: commit trailers, a
`.gitlit/provenance/` sidecar, and signed receipts. Postgres holds a queryable
mirror.

Reason: a provenance claim that only exists in our database is worthless to a publisher
the day we go out of business, and unverifiable by anyone who clones the repo. If the
attestation travels with the repository, it survives us. We can rebuild the entire
Postgres provenance index by replaying a repo's history — and we will have a command
that does exactly that, run in CI, as a guarantee that the DB never becomes the truth.

**Trade-off accepted:** double-write complexity in the commit path, and repo size grows
with sidecar data (~2–5% of manuscript size; acceptable).

### 2.4 Provenance is *evidence*, not proof

Stated plainly here because it determines what we're allowed to claim in the UI, and
is addressed at length in §3.

### 2.5 The AI Researcher is a durable state machine, not a request handler

A research run makes 20–60 model and search calls over 3–15 minutes. It must survive
deploys, be resumable, be cancellable, and produce a complete audit log even when it
fails halfway. That is a queued job with persisted per-step state, not an HTTP request.

**Choice:** BullMQ on Redis, with each step's input/output hashed and persisted to
`ai_run_steps` before the next step starts. Progress streams to the browser over SSE.

### 2.6 Claude Code is a first-class client

Since every repo is a real Git remote, Claude Code already works. We go further and ship
a **GitLit MCP server** so Claude Code can read the architecture doc, query provenance,
open a draft branch, and commit with correct provenance trailers — meaning AI assistance
*outside* our web app still lands inside the provenance system instead of arriving as
an unattributed paste.

This is strategically the most important integration we build. Unattributed pastes are
the single largest hole in the trust model; making the honest path also the easiest path
is the only real mitigation.

---

## 3. Trust model and honest limitations

This section exists so the product never over-claims. Publishers will test us on exactly
these points, and a single overstated claim destroys the platform's credibility.

**What GitLit can prove:**

- That a specific commit was made by an authenticated account at a specific time.
- That a specific AI run happened, with which model, which prompt version, which sources,
  producing which exact output — replayable from the step log.
- That the text in commit *N* differs from the AI's committed plan in commit *M* by a
  measurable amount, computed deterministically.
- That the history has not been rewritten since it was signed (hash chain + receipts).

**What GitLit cannot prove:**

- **That a "human-written" chapter was written by a human.** An author can generate prose
  in another tool and paste it in. We will record it as human-authored because we have no
  way to know otherwise. Mitigations (typing-cadence signals, paste-size flagging, session
  continuity) raise the cost of faking but never reach proof, and every one of them is
  adversarially defeatable.
- **That a premise is original.** Novelty checks search published and indexed works. They
  cannot see unpublished manuscripts, they index English-language sources far better than
  others, and *ideas are not protectable anyway*. A "novel" verdict means "we did not find
  close prior art in these corpora on this date," and the UI must say exactly that.
- **That the AI's research is correct.** We record what the model read and wrote. We do
  not vouch for it. Every claim in the ledger carries its source so a human can check it.

**Therefore the UI language is calibrated:** "recorded as," "attested," "no close prior
art found in <corpora> on <date>." Never "verified human," never "certified original."
A "Provenance Confidence" indicator exposes *which* signals are present (in-platform
authorship, paste events, typing telemetry, signed receipts, external anchor) rather than
collapsing to a single trust score, because a single score invites exactly the
over-interpretation we must avoid.

---

## 4. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript 5.7 end-to-end | One type vocabulary across web, API, worker, and MCP server; shared Zod schemas. |
| Monorepo | pnpm workspaces + Turborepo | Fast, simple, good caching. |
| Web | Next.js 15 (App Router), React 19 | RSC for heavy diff/timeline reads; streaming for the research view. |
| Styling | Tailwind CSS 4 + shadcn/ui + Radix | Fast to build, accessible primitives, easy to make *quiet* — this product must feel like a writing tool, not a dev tool. |
| Editor | TipTap (ProseMirror) | Prose-first, supports decorations for provenance shading, custom nodes for scene/beat markers. |
| API | Fastify 5 + tRPC | tRPC for the first-party web app (type-safe, fast to iterate); REST/OpenAPI façade over the same handlers for third parties and the CLI. |
| Git layer | `nodegit` (libgit2) in a dedicated service; `isomorphic-git` for tests | Direct object access, no shell-out per request; fine-grained control of the commit path. |
| Prose diff | `jsdiff` + custom sentence aligner + `fast-myers-diff` for long files | See §9. |
| Jobs | BullMQ on Redis 7 | Durable, resumable, observable; supports flows for the multi-stage pipeline. |
| DB | PostgreSQL 16 + `pgvector` | Relational core + embedding similarity in one place. |
| ORM | Drizzle ORM | SQL-first, transparent migrations, no hidden query generation for the recursive/vector queries we need. |
| AI | Anthropic API — `claude-opus-5` (architecture + outline), `claude-sonnet-5` (research synthesis, diff explanation), `claude-haiku-4-5-20251001` (classification, dedup, cheap filtering) | Tiered by cost/quality per step; see §8.4. |
| Embeddings | Voyage `voyage-3` (1024-dim) into pgvector | Premise↔prior-work similarity and outline↔chapter derivation scoring. |
| Search/corpora | Anthropic web search + Open Library + Google Books + Crossref + Semantic Scholar | Novelty evidence breadth; each hit recorded in the ledger. |
| Auth | Auth.js v5 — GitHub OAuth, Google, email magic link; DB sessions | Authors are not all developers; email must work. |
| Signing | Ed25519 per-repo keys (libsodium); optional Sigstore/gitsign for orgs | Receipts in §7.4. |
| Object storage | S3-compatible (Cloudflare R2) | Repo bundles, exports, cover art, imported source docs. |
| Realtime | SSE (research progress, timeline updates) | Simpler than WebSockets; unidirectional is all we need. |
| Email | Resend + React Email | Invites, run-complete, publisher verification links. |
| Observability | OpenTelemetry → Grafana Tempo/Loki; Sentry | AI runs are distributed traces; we need per-step spans. |
| Testing | Vitest, Playwright, Testcontainers (PG+Redis) | Real DB in integration tests; the Git path cannot be meaningfully mocked. |

### 4.1 Deployment topology

- **Web** (Next.js) → Vercel.
- **API + Worker + Git service** → Fly.io. The Git service needs a **persistent volume**;
  this is the constraint that rules out an all-serverless design.
- **Postgres** → Neon (branching is genuinely useful for migration testing).
- **Redis** → Upstash.
- **Blobs** → Cloudflare R2.

Repos live on the Git service's volume, with nightly `git bundle` snapshots to R2 for
backup and for "download your book's full history" — an export promise that materially
reduces lock-in anxiety for authors, which matters for adoption.

---

## 5. Service topology

```
                      ┌────────────────────────────┐
   Browser ──────────▶│  web (Next.js 15)          │
   Claude Code ──┐    │  RSC + TipTap + SSE client │
   GitLit CLI ───┤    └──────────┬─────────────────┘
   git client ───┤               │ tRPC / REST
                 │    ┌──────────▼─────────────────┐
                 ├───▶│  api (Fastify + tRPC)      │
                 │    │  authz, CRUD, diff reads   │
                 │    └───┬───────────┬────────────┘
                 │        │           │ enqueue
                 │        │      ┌────▼──────────────┐
                 │        │      │ worker (BullMQ)   │
                 │        │      │ AI Researcher     │──▶ Anthropic / Voyage
                 │        │      │ indexer, diffcalc │──▶ Book & paper corpora
                 │        │      └────┬──────────────┘
                 │   ┌────▼───────────▼────────────┐
                 └──▶│  gitd (libgit2 + smart HTTP)│──▶ volume: /repos/**.git
                     └────┬────────────────────────┘
                          │
              ┌───────────▼───────────┐   ┌──────────┐   ┌─────┐
              │ Postgres 16 + pgvector│   │ Redis 7  │   │ R2  │
              └───────────────────────┘   └──────────┘   └─────┘
```

`gitd` is the only process that touches the volume. Everything else asks it. This
keeps the commit path — where provenance is written — in exactly one place, which is
the property that makes the trust model auditable.

---

## 6. Repository format

### 6.1 On-disk layout of an author repository

```
my-novel/
├── manuscript_architecture.md      # AI-authored plan (feature 2)
├── book.yml                        # title, author, form, genre, target length
├── manuscript/
│   ├── front-matter.md
│   ├── chapters/
│   │   ├── 01-the-lighthouse.md
│   │   ├── 02-salt-and-ash.md
│   │   └── ...
│   └── back-matter.md
├── notes/                          # author's own notes, never AI-written
│   └── character-bible.md
└── .gitlit/
    ├── config.yml                  # normalizer settings, provenance policy
    ├── provenance/
    │   └── manuscript/chapters/01-the-lighthouse.md.jsonl
    ├── research/
    │   ├── ledger.jsonl            # append-only source record
    │   └── novelty-report.json
    ├── runs/
    │   └── run_01J9F3.json         # full step log for one AI run
    └── receipts/
        └── chain.jsonl             # signed, hash-chained commit receipts
```

Everything in `.gitlit/` is committed. That is the point — the evidence travels with
the book.

### 6.2 Chapter file format

```markdown
---
chapter: 1
title: The Lighthouse
status: revised          # planned | drafting | drafted | revised | final
pov: Mara
beats: [b1.1, b1.2, b1.3]   # links back to manuscript_architecture.md
---

The lighthouse had been dark for eleven years.
Mara counted them on the drive up, one for each winter she had not come home.

The road gave out at the headland.
```

One sentence per line; blank line between paragraphs. `beats` is what makes the
Provenance Diff Viewer able to say *which part of the AI's plan* this chapter descends
from, rather than guessing purely from text similarity.

### 6.3 `manuscript_architecture.md` specification

Machine-generated, human-editable. Deterministic structure so the diff viewer can parse
it. Committed by the AI Researcher as a single commit with provenance class `ai`.

```markdown
---
gitlit_version: 1
run_id: run_01J9F3XK2M
generated_at: 2026-09-19T14:02:11Z
model: claude-opus-5
prompt_version: researcher/v1.3
premise_hash: sha256:9f2c...
novelty_verdict: sparse_prior_art
novelty_score: 0.71
---

# Manuscript Architecture — <Working Title>

## 1. Premise (as submitted)
> <verbatim author premise>

## 2. Novelty Assessment
**Verdict:** Sparse prior art found.
**Searched:** Open Library, Google Books, Crossref, Semantic Scholar, open web — 2026-09-19.
**Caveat:** Absence of found prior art is not originality. Unpublished and
non-English works are poorly represented in these corpora.

| Nearest work | Author | Year | Similarity | How this differs |
|---|---|---|---|---|
| The Light Between Oceans | M. L. Stedman | 2012 | 0.61 | Shared lighthouse-isolation frame; differs in ... |

## 3. Research Ledger
Every source the model consulted. Full records in `.gitlit/research/ledger.jsonl`.

### 3.1 Domain: Lighthouse keeping, 1900–1975
- **[S-014]** *Coast Guard Keeper Logs, Vol. III* — retrieved 2026-09-19,
  `sha256:4b1e...` — used for: watch rotation detail in beat 1.2.
  > "Keepers stood four-hour watches, relieved at midnight..."

## 4. Chapter Outline
### Chapter 1 — The Lighthouse  `[ch1]`
**Function:** Establish Mara's return and the debt she owes the island.
**Beats:**
- `b1.1` Mara drives the headland road, counting winters. *(sources: S-014)*
- `b1.2` The keeper's cottage is exactly as left. *(sources: S-014, S-021)*
**Open questions for the author:** Does Mara know about the will before arriving?

## 5. Structural Notes
## 6. Where the AI stopped
This document is the complete extent of machine authorship as of `run_01J9F3XK2M`.
No prose in `manuscript/` was generated by this run.
```

That final section is not decoration — it is the assertion the whole product is
organized around, and it is signed.

### 6.4 Provenance sidecar (`.gitlit/provenance/<path>.jsonl`)

One JSON object per span, per file, rewritten on each commit that touches the file:

```json
{"start":0,"end":412,"origin":"human_written","commit":"a1b2c3d","author":"u_7k2","ts":"2026-09-21T10:14:02Z","evidence":["in_platform_typing"]}
{"start":412,"end":688,"origin":"human_edited_ai","commit":"e4f5a6b","run":"run_01J9F3XK2M","model":"claude-opus-5","retained":0.34,"evidence":["derived_from_beat:b1.2"]}
```

`origin` ∈ `ai_generated | ai_assisted | human_edited_ai | human_written | imported | unknown`.
`imported` and `unknown` are honest states and appear in the UI as such — a manuscript
imported from Word on day one is mostly `unknown`, and pretending otherwise would be the
exact over-claim §3 forbids.

---

## 7. Provenance model

### 7.1 Commit trailers

Every GitLit commit carries machine-readable trailers:

```
Add chapter 3 draft

Rewrote the harbor scene; kept the AI's beat order.

GitLit-Provenance: hybrid
GitLit-Run-Id: run_01J9F3XK2M
GitLit-Model: claude-opus-5
GitLit-Prompt-Version: researcher/v1.3
GitLit-Spans-Digest: sha256:7c4a...
GitLit-Evidence: in_platform_typing,paste:2
GitLit-Receipt: rcpt_01J9G88Q4P
```

These survive `git clone` and are readable by anyone with `git log`, with no GitLit
account and no network access. That is deliberate.

### 7.2 Provenance classes

- `ai` — machine authored, human did not touch it in this commit (research runs).
- `hybrid` — human edited machine-originated text, or mixed the two.
- `human` — no machine-originated text in the diff.

Computed from spans, never self-declared by the client.

### 7.3 Span tracking across edits

When a file is committed, `gitd`:

1. Normalizes prose (§2.2).
2. Diffs against the parent at sentence granularity.
3. Carries forward spans for unchanged sentences.
4. For changed sentences, computes retention against the prior span's text
   (token-level similarity). Retention ≥ 0.85 with prior origin `ai_generated`
   → `human_edited_ai` with `retained` recorded; < 0.35 → `human_written`.
5. Writes the sidecar, computes `GitLit-Spans-Digest`, creates the commit, emits a receipt.

Thresholds are config, versioned in `.gitlit/config.yml`, and recorded per commit so a
later threshold change never silently rewrites history's meaning.

### 7.4 Receipts and the hash chain

```json
{"id":"rcpt_01J9G88Q4P","prev":"sha256:...","commit":"e4f5a6b","spans_digest":"sha256:7c4a...",
 "run":"run_01J9F3XK2M","issued_at":"2026-09-21T10:14:03Z","key":"key_repo_9f2","sig":"ed25519:..."}
```

Chained to the previous receipt, so removing or reordering history breaks verification.
`gitlit verify` (CLI, and a public web verifier) re-walks the chain against the repo and
reports exactly which commits verify — offline, without trusting our servers.

Optional for publisher-tier repos: periodic anchoring of the chain head to an external
timestamp authority (RFC 3161), which converts "we say this existed on the 21st" into
"a third party attested this existed on the 21st."

---

## 8. Automated AI Researcher

### 8.1 Pipeline

```
premise_submitted
   → normalize_premise        (haiku: extract genre, themes, entities, claims)
   → embed_premise            (voyage-3)
   → novelty_search           (books + papers + web, fan-out ~8 queries)
   → novelty_similarity       (pgvector against prior_works; top-k rerank)
   → novelty_verdict          (opus: synthesize verdict + caveats)
   ├── verdict = derivative → HALT, report to author, no commit    ← author decides
   └── otherwise ↓
   → research_plan            (opus: what must be true for this book to work?)
   → research_execute         (sonnet × N domains, parallel, 3–10 sources each)
   → ledger_build             (dedupe, hash, excerpt, attribute)
   → outline_generate         (opus: chapters + beats, beats cite ledger ids)
   → assemble_architecture_md
   → commit                   (provenance: ai, signed, receipt emitted)
   → index                    (spans, timeline event, notify author)
```

**A `derivative` verdict halts the run and never commits.** Delivering a chapter outline
for a book that already exists wastes the author's time and money, and quietly proceeding
would make the novelty check theater. The author sees the nearest works and chooses:
revise the premise, or proceed anyway with the verdict recorded in the architecture doc.

### 8.2 Step durability

Each step writes `ai_run_steps` (input hash, output hash, output blob ref, tokens, cost,
duration, status) **before** the next step is enqueued. A worker crash resumes at the last
completed step. Every step is individually replayable, which is what makes the audit
credible — "replayable in principle" is not the same as a replay command that exists, so
`gitlit run replay <run_id>` ships in v1.

### 8.3 Novelty scoring

Not a single number pretending to be truth. Three components, reported separately:

- **Corpus similarity** — max and mean cosine similarity of premise embedding vs. top-50
  retrieved prior works.
- **Concept overlap** — Jaccard over extracted themes/tropes/setting/structure.
- **Market density** — count of close-adjacent titles published in the last 5 years.

Verdicts: `sparse_prior_art` | `crowded_field` | `derivative`. Each with the specific
works that drove it, so the author can disagree with a reason rather than with a number.

### 8.4 Model routing and cost

| Step | Model | Rationale |
|------|-------|-----------|
| normalize, dedupe, classify | `claude-haiku-4-5-20251001` | High volume, low judgment. |
| research synthesis per domain | `claude-sonnet-5` | Bulk reading; parallel fan-out. |
| novelty verdict, outline, architecture | `claude-opus-5` | The output the author actually reads. |
| diff explanation ("what changed and why") | `claude-sonnet-5` | On-demand, user-facing. |

Prompt caching on the premise + ledger prefix across research steps. Estimated cost per
full run: **$1.80–$4.50**, dominated by the outline step. Hard per-run token ceiling,
per-user daily cap, and a pre-run estimate shown to the author before they spend.

### 8.5 Prompt versioning

Prompts are files in `packages/prompts/`, semver'd, hashed, and the version is recorded
on every run and in the architecture doc's front matter. Changing a prompt cannot
retroactively change what a past run claims to have done.

---

## 9. Provenance Diff Viewer

The specialized comparison tool. Three modes:

### 9.1 Mode A — Plan vs. Prose (the flagship view)

Left: `manuscript_architecture.md` beats at the run commit. Right: current chapter prose.
Between them: derivation ribbons linking beat → paragraph.

Derivation is computed, not declared:

1. **Declared link** — chapter front matter `beats:` (strongest signal).
2. **Lexical** — character n-gram containment for near-verbatim carryover.
3. **Semantic** — cosine similarity of beat embedding vs. paragraph embedding, Hungarian
   assignment for one-to-one beat↔paragraph matching with a similarity floor.
4. **Classification** — `faithful` (≥0.80) | `developed` (0.55–0.80) | `departed` (<0.55)
   | `unplanned` (paragraph matches no beat) | `abandoned` (beat matches no paragraph).

`unplanned` and `abandoned` are the interesting cells: they are precisely where the human
author asserted themselves against the plan, and the view should draw the eye to them.

**Headline metric — Divergence:** share of final prose classified `departed` or
`unplanned`, weighted by word count. Displayed with its own caveat inline, never as a
bare percentage.

### 9.2 Mode B — Provenance heat view

The chapter as continuous prose, each sentence shaded by span origin. Hover → origin,
commit, run, model, retention. Toggle: "show only machine-originated text."

### 9.3 Mode C — Classic revision diff

Commit-to-commit, sentence-level, with word-level highlighting inside changed sentences.
Moved-paragraph detection (hash-and-match before diffing) — critical for prose, where
restructuring is most of revision and a naive diff renders it as total rewrite.

### 9.4 Performance

Diffs are computed in the worker and cached in `diff_cache` keyed by
`(base_sha, head_sha, path, mode, algo_version)`. A 120k-word manuscript must render its
first screen in <400ms; full-book computation is async with progressive fill.

---

## 10. Prose Timeline

Not a commit list. A **phase-banded spine** of the manuscript's life:

```
PREMISE ──▶ NOVELTY ──▶ RESEARCH ──▶ ARCHITECTURE ──▶ DRAFTING ──▶ REVISION ──▶ FINAL
  ●           ●           ●●●●          ●              ●●●●●●●●●     ●●●●●●       ●
  │                                     │              │
  └─ human                              └─ AI commit   └─ 47 commits, 82k words
```

Per commit node: word delta (green/red bar), provenance class (color), and an AI badge.
Overlays: cumulative word count, session density heatmap, and a **provenance ribbon**
showing the machine-originated share of the manuscript shrinking over time — which is,
visually, the entire thesis of the product in one line.

Phases are derived, not user-set: from run kinds, commit trailers, chapter `status`
fields, and tag events. Author can override; overrides are recorded as such.

Data source: `timeline_events`, a denormalized append-only projection built by the
indexer, so the view is a single indexed range scan rather than a graph walk.

---

## 11. Database schema

PostgreSQL 16 + `pgvector`. Drizzle migrations. Abridged to the meaningful columns;
`created_at`/`updated_at` on every table, omitted below for readability.

### 11.1 Identity and ownership

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,              -- ULID
  handle          CITEXT UNIQUE NOT NULL,
  email           CITEXT UNIQUE NOT NULL,
  email_verified  TIMESTAMPTZ,
  display_name    TEXT,
  pen_name        TEXT,
  bio             TEXT,
  avatar_url      TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',  -- free | author | publisher
  ai_monthly_cents INT NOT NULL DEFAULT 0,       -- rolling spend guard
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE accounts (       -- Auth.js OAuth links
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  provider TEXT NOT NULL, provider_account_id TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT, expires_at BIGINT,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL, expires TIMESTAMPTZ NOT NULL
);

CREATE TABLE organizations (  -- publishers, imprints, writing groups
  id TEXT PRIMARY KEY, slug CITEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'publisher', billing_customer_id TEXT
);

CREATE TABLE organization_members (
  org_id TEXT NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  role TEXT NOT NULL,                            -- owner | admin | editor | member
  PRIMARY KEY (org_id, user_id)
);
```

### 11.2 Repositories

```sql
CREATE TABLE repositories (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT REFERENCES users ON DELETE CASCADE,
  owner_org_id    TEXT REFERENCES organizations ON DELETE CASCADE,
  slug            CITEXT NOT NULL,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  form            TEXT NOT NULL,                 -- novel | nonfiction | memoir | collection
  genre           TEXT[],
  visibility      TEXT NOT NULL DEFAULT 'private', -- private | unlisted | public
  default_branch  TEXT NOT NULL DEFAULT 'main',
  storage_path    TEXT NOT NULL,                 -- /repos/ab/cd/<id>.git
  target_words    INT,
  current_words   INT NOT NULL DEFAULT 0,
  phase           TEXT NOT NULL DEFAULT 'premise',
  signing_key_id  TEXT,
  archived_at     TIMESTAMPTZ,
  CHECK ((owner_user_id IS NULL) <> (owner_org_id IS NULL))
);
CREATE UNIQUE INDEX repositories_owner_slug ON repositories
  (COALESCE(owner_user_id, owner_org_id), slug);

CREATE TABLE repository_collaborators (
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  role    TEXT NOT NULL,   -- owner | co_author | editor | beta_reader | verifier
  invited_by TEXT REFERENCES users, accepted_at TIMESTAMPTZ,
  PRIMARY KEY (repo_id, user_id)
);

CREATE TABLE branches (      -- cached ref heads; gitd is source of truth
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  name TEXT NOT NULL, head_sha CHAR(40) NOT NULL,
  kind TEXT NOT NULL DEFAULT 'draft',  -- draft | revision | experiment | submission
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE documents (     -- manuscript files, indexed for fast listing
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  path TEXT NOT NULL, kind TEXT NOT NULL,   -- chapter | outline | architecture | research | note
  chapter_no INT, title TEXT, order_index INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  word_count INT NOT NULL DEFAULT 0,
  ai_word_share REAL NOT NULL DEFAULT 0,    -- denormalized from spans
  head_sha CHAR(40) NOT NULL,
  UNIQUE (repo_id, path)
);
```

### 11.3 History

```sql
CREATE TABLE commits (
  repo_id     TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  sha         CHAR(40) NOT NULL,
  parents     CHAR(40)[] NOT NULL DEFAULT '{}',
  author_id   TEXT REFERENCES users,
  author_name TEXT NOT NULL, author_email TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  message     TEXT NOT NULL,
  provenance  TEXT NOT NULL,                  -- ai | hybrid | human
  ai_run_id   TEXT REFERENCES ai_runs,
  model       TEXT, prompt_version TEXT,
  spans_digest TEXT,
  words_added INT NOT NULL DEFAULT 0, words_removed INT NOT NULL DEFAULT 0,
  files_changed INT NOT NULL DEFAULT 0,
  evidence    TEXT[] NOT NULL DEFAULT '{}',
  phase       TEXT,
  PRIMARY KEY (repo_id, sha)
);
CREATE INDEX commits_repo_time ON commits (repo_id, committed_at DESC);

CREATE TABLE provenance_spans (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  commit_sha CHAR(40) NOT NULL, path TEXT NOT NULL,
  start_offset INT NOT NULL, end_offset INT NOT NULL,
  origin TEXT NOT NULL,       -- ai_generated | ai_assisted | human_edited_ai
                              -- | human_written | imported | unknown
  ai_run_id TEXT REFERENCES ai_runs, model TEXT,
  retained REAL, beat_id TEXT, author_id TEXT REFERENCES users,
  evidence TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX spans_lookup ON provenance_spans (repo_id, path, commit_sha);

CREATE TABLE provenance_receipts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  commit_sha CHAR(40) NOT NULL, prev_receipt_hash TEXT,
  spans_digest TEXT NOT NULL, payload JSONB NOT NULL,
  signature TEXT NOT NULL, signing_key_id TEXT NOT NULL REFERENCES signing_keys,
  anchored_at TIMESTAMPTZ, anchor_ref TEXT,
  UNIQUE (repo_id, commit_sha)
);

CREATE TABLE signing_keys (
  id TEXT PRIMARY KEY, repo_id TEXT REFERENCES repositories ON DELETE CASCADE,
  algo TEXT NOT NULL DEFAULT 'ed25519',
  public_key TEXT NOT NULL, private_key_enc BYTEA NOT NULL,  -- KMS-wrapped
  revoked_at TIMESTAMPTZ
);

CREATE TABLE timeline_events (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,       -- commit | run_started | run_completed | run_halted
                            -- | phase_change | tag | collaborator_added | verification
  phase TEXT, commit_sha CHAR(40), ai_run_id TEXT, actor_id TEXT REFERENCES users,
  payload JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX timeline_scan ON timeline_events (repo_id, occurred_at);
```

### 11.4 AI logs

```sql
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users,
  kind TEXT NOT NULL,        -- researcher | novelty_only | outline_refresh | diff_explain
  status TEXT NOT NULL,      -- queued | running | halted | succeeded | failed | cancelled
  halt_reason TEXT,          -- derivative_premise | budget | user_cancelled | error
  premise_id TEXT REFERENCES premises,
  prompt_version TEXT NOT NULL, model_primary TEXT NOT NULL,
  output_commit_sha CHAR(40),
  input_tokens INT NOT NULL DEFAULT 0, output_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT NOT NULL DEFAULT 0, cost_cents INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  error JSONB
);
CREATE INDEX ai_runs_repo ON ai_runs (repo_id, started_at DESC);

CREATE TABLE ai_run_steps (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs ON DELETE CASCADE,
  step_index INT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, model TEXT, tool TEXT,
  input_hash TEXT NOT NULL, output_hash TEXT,
  input_ref TEXT, output_ref TEXT,          -- R2 keys for full payloads
  input_tokens INT, output_tokens INT, cost_cents INT,
  duration_ms INT, attempt INT NOT NULL DEFAULT 1, error JSONB,
  UNIQUE (run_id, step_index, attempt)
);

CREATE TABLE premises (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  text TEXT NOT NULL, text_hash TEXT NOT NULL,
  themes TEXT[], entities JSONB,
  embedding VECTOR(1024),
  UNIQUE (repo_id, version)
);

CREATE TABLE research_sources (      -- the ledger, indexed
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  ledger_ref TEXT NOT NULL,          -- "S-014"
  source_type TEXT NOT NULL,         -- web | book | paper | dataset | user_supplied
  url TEXT, title TEXT, authors TEXT[], publisher TEXT, published_at DATE,
  identifier TEXT,                   -- ISBN / DOI
  retrieved_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL, excerpt TEXT, excerpt_ref TEXT,
  domain TEXT, used_in_beats TEXT[], relevance REAL,
  embedding VECTOR(1024)
);
CREATE INDEX sources_repo ON research_sources (repo_id, domain);

CREATE TABLE novelty_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  premise_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,             -- sparse_prior_art | crowded_field | derivative
  corpus_similarity REAL, concept_overlap REAL, market_density INT,
  corpora TEXT[] NOT NULL, searched_at TIMESTAMPTZ NOT NULL,
  nearest_works JSONB NOT NULL,      -- [{work_id,title,author,year,similarity,differs}]
  rationale TEXT NOT NULL,
  author_response TEXT,              -- revised | proceeded_anyway | abandoned
  author_responded_at TIMESTAMPTZ
);

CREATE TABLE prior_works (           -- corpus for similarity search
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- openlibrary | googlebooks | crossref | manual
  external_id TEXT, title TEXT NOT NULL, authors TEXT[],
  published_year INT, isbn TEXT, synopsis TEXT, subjects TEXT[],
  embedding VECTOR(1024),
  UNIQUE (source, external_id)
);
CREATE INDEX prior_works_ann ON prior_works
  USING hnsw (embedding vector_cosine_ops);
```

### 11.5 Diffs, review, platform

```sql
CREATE TABLE diff_cache (
  key TEXT PRIMARY KEY,              -- hash(base,head,path,mode,algo_version)
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  mode TEXT NOT NULL, algo_version TEXT NOT NULL,
  payload JSONB NOT NULL, computed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE derivations (           -- beat -> paragraph links (Mode A)
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  head_sha CHAR(40) NOT NULL, beat_id TEXT, path TEXT NOT NULL,
  para_index INT NOT NULL,
  relation TEXT NOT NULL,            -- faithful | developed | departed | unplanned | abandoned
  similarity REAL, method TEXT NOT NULL,  -- declared | lexical | semantic
  UNIQUE (repo_id, head_sha, path, para_index, beat_id)
);

CREATE TABLE review_threads (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  path TEXT, commit_sha CHAR(40), start_offset INT, end_offset INT,
  anchor_text TEXT,                  -- for re-anchoring after edits
  resolved_at TIMESTAMPTZ, created_by TEXT NOT NULL REFERENCES users
);

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES review_threads ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users, body TEXT NOT NULL
);

CREATE TABLE verification_links (    -- share provenance with a publisher
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL,               -- provenance_only | provenance_and_prose
  ref TEXT NOT NULL,                 -- branch or tag being attested
  created_by TEXT NOT NULL REFERENCES users,
  expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  view_count INT NOT NULL DEFAULT 0, last_viewed_at TIMESTAMPTZ
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  scopes TEXT[] NOT NULL, last_used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES users, repo_id TEXT REFERENCES repositories ON DELETE SET NULL,
  action TEXT NOT NULL, target TEXT, ip INET, user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}', occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  kind TEXT NOT NULL, repo_id TEXT REFERENCES repositories ON DELETE CASCADE,
  payload JSONB NOT NULL, read_at TIMESTAMPTZ
);
```

**Deliberate non-goal:** we do not mirror Git trees or blobs into Postgres. Postgres
indexes *metadata and derived analysis*. Content comes from `gitd`. Any table above can
be rebuilt by `gitlit reindex <repo>`, and CI asserts that a reindex of a fixture repo
reproduces the index byte-for-byte.

---

## 12. API surface

Base: `https://api.gitlit.app/v1`. Auth: session cookie (web) or `Authorization: Bearer
<api_token>`. All list endpoints cursor-paginate. Errors are RFC 9457 problem details.

### 12.1 Identity

```
GET    /me
PATCH  /me
GET    /users/:handle
GET    /users/:handle/repositories
POST   /tokens                      DELETE /tokens/:id
```

### 12.2 Repositories

```
POST   /repositories                       { title, form, genre, visibility, premise? }
GET    /repositories/:owner/:slug
PATCH  /repositories/:owner/:slug
DELETE /repositories/:owner/:slug
POST   /repositories/:owner/:slug/import   multipart: .docx | .md | .scriv
GET    /repositories/:owner/:slug/export   ?format=docx|epub|md|bundle
GET    /repositories/:owner/:slug/collaborators
POST   /repositories/:owner/:slug/collaborators
DELETE /repositories/:owner/:slug/collaborators/:userId
GET    /repositories/:owner/:slug/branches
POST   /repositories/:owner/:slug/branches { name, from, kind }
```

### 12.3 Manuscript content

```
GET    /repositories/:owner/:slug/tree?ref=main
GET    /repositories/:owner/:slug/documents
GET    /repositories/:owner/:slug/documents/*path?ref=main
PUT    /repositories/:owner/:slug/documents/*path   { content, message, evidence[] }
DELETE /repositories/:owner/:slug/documents/*path
POST   /repositories/:owner/:slug/commits           { message, changes[], evidence[] }
GET    /repositories/:owner/:slug/commits?ref=&path=&provenance=&cursor=
GET    /repositories/:owner/:slug/commits/:sha
GET    /repositories/:owner/:slug/blame/*path?ref=   → sentence-level, with provenance
```

`PUT .../documents/*path` is the hot path: it normalizes, diffs, recomputes spans,
commits, signs, emits a receipt, and returns the new sha plus updated provenance summary
in one round trip.

### 12.4 AI Researcher

```
POST   /repositories/:owner/:slug/premise            { text }           → premise version
POST   /repositories/:owner/:slug/research           { premise_version, budget_cents,
                                                       depth: quick|standard|deep }
                                                     → 202 { run_id }
GET    /repositories/:owner/:slug/research/estimate?depth=    → cost + time estimate
GET    /runs/:run_id                                 → status, step summary, cost
GET    /runs/:run_id/events                          → text/event-stream (live progress)
POST   /runs/:run_id/cancel
POST   /runs/:run_id/replay                          → deterministic re-execution
GET    /runs/:run_id/steps                           → full audit log
GET    /runs/:run_id/novelty                         → novelty_report
POST   /runs/:run_id/novelty/respond                 { response: revised|proceed|abandon }
GET    /repositories/:owner/:slug/research/ledger?cursor=
GET    /repositories/:owner/:slug/architecture?ref=  → parsed manuscript_architecture.md
```

`POST /research` returns `202` immediately with a `run_id`; the client subscribes to
`/runs/:id/events`. A run halted at `derivative` waits on `novelty/respond` — the author
is in the loop before any money is spent on the outline step.

### 12.5 Provenance and diffs

```
GET  /repositories/:owner/:slug/provenance?ref=              → whole-book summary
GET  /repositories/:owner/:slug/provenance/*path?ref=        → spans for one file
GET  /repositories/:owner/:slug/diff?base=&head=&path=&mode=revision
GET  /repositories/:owner/:slug/diff/plan?run=&head=&path=   → Mode A, plan vs prose
GET  /repositories/:owner/:slug/divergence?run=&ref=         → headline metric + breakdown
POST /repositories/:owner/:slug/diff/explain                 { base, head, path }
GET  /repositories/:owner/:slug/receipts?ref=
POST /repositories/:owner/:slug/verify                       { ref } → chain verification
GET  /verify/:receipt_id                                     → PUBLIC, unauthenticated
```

`GET /verify/:receipt_id` is public by design: a publisher must be able to check a
receipt without a GitLit account.

### 12.6 Timeline, review, sharing

```
GET  /repositories/:owner/:slug/timeline?from=&to=&kinds=
GET  /repositories/:owner/:slug/timeline/stream          → SSE
GET  /repositories/:owner/:slug/stats                    → words/day, sessions, ai share
GET  /repositories/:owner/:slug/threads?path=&resolved=
POST /repositories/:owner/:slug/threads
POST /threads/:id/comments        POST /threads/:id/resolve
POST /repositories/:owner/:slug/verification-links       { scope, ref, expires_at }
GET  /shared/:token                                      → publisher-facing view
DELETE /verification-links/:id
```

### 12.7 Git smart HTTP (served by `gitd`)

```
GET  /:owner/:slug.git/info/refs?service=git-upload-pack
POST /:owner/:slug.git/git-upload-pack
POST /:owner/:slug.git/git-receive-pack
```

Authenticated by API token as HTTP basic password, or SSH on port 22 for key auth.
A pre-receive hook enforces provenance policy: pushes must carry valid trailers, or
spans are recomputed server-side and the commit is marked `unknown` origin rather than
being silently trusted. **The client never gets to assert its own provenance class.**

### 12.8 MCP server (for Claude Code)

`packages/mcp-server`, connectable from Claude Code:

| Tool | Purpose |
|------|---------|
| `gitlit_list_repositories` | Find the author's books. |
| `gitlit_read_architecture` | Fetch parsed beats/outline for context. |
| `gitlit_read_document` | Read a chapter with provenance annotations. |
| `gitlit_write_document` | Write with correct, honest provenance attribution. |
| `gitlit_commit` | Commit with `ai_assisted` spans and run linkage. |
| `gitlit_provenance_summary` | Current AI/human share. |
| `gitlit_diff_plan` | Plan-vs-prose divergence for a chapter. |
| `gitlit_start_research` | Kick off a research run. |

Writes through this server are attributed `ai_assisted` by default, and the tool
description says so. The honest path must be the easy path.

### 12.9 Webhooks

Events: `run.completed`, `run.halted`, `commit.created`, `phase.changed`,
`divergence.threshold_crossed`, `verification_link.viewed`. HMAC-SHA256 signed,
exponential-backoff retries, deliveries logged.

---

## 13. Monorepo layout

```
gitlit/
├── apps/
│   ├── web/              Next.js 15 — dashboard, editor, diff viewer, timeline
│   ├── api/              Fastify + tRPC + REST façade
│   ├── worker/           BullMQ processors: researcher, indexer, diffcalc, corpus
│   └── gitd/             libgit2 service + smart HTTP + pre-receive hooks
├── packages/
│   ├── db/               Drizzle schema, migrations, seed
│   ├── core/             domain types, Zod schemas, ULIDs, shared errors
│   ├── prose/            normalizer, sentence segmenter, word count, docx/epub io
│   ├── diff/             sentence diff, move detection, derivation matcher
│   ├── provenance/       spans, trailers, receipts, signing, verifier
│   ├── researcher/       pipeline steps, corpora clients, novelty scoring
│   ├── prompts/          versioned prompt files + hashes
│   ├── mcp-server/       Claude Code integration
│   ├── ui/               shadcn-based component library
│   └── cli/              `gitlit` — clone, verify, replay, reindex, export
├── docs/
├── infra/                Fly configs, migrations runner, IaC
└── system_architecture.md
```

`packages/provenance` and `packages/diff` are pure and dependency-light on purpose:
they are the parts a skeptical publisher or auditor may want to read, and they must be
readable without understanding the rest of the system.

---

## 14. Security and privacy

- **Manuscripts are private by default.** An unpublished book is the most sensitive thing
  a writer owns; the default must never be public.
- **Encryption at rest** for repo volumes and R2; TLS everywhere; signing keys wrapped by KMS.
- **The AI Researcher receives the premise, not the manuscript**, unless the author
  explicitly invokes a manuscript-aware tool. Stated in the UI at the point of use.
- **No training on user content**, contractually and in the privacy policy. Say it plainly
  on the marketing site — for this audience it is a purchase criterion.
- **Rate limits:** per-user AI spend cap (daily + monthly), per-repo concurrent run limit
  of 1, global corpus-API budget with graceful degradation to fewer corpora (and the
  ledger records which corpora were actually searched, so a degraded run is never
  presented as a full one).
- **Deletion:** account deletion purges repos, blobs, and AI logs within 30 days;
  verification links die immediately.
- **Abuse:** the novelty checker is a plagiarism-adjacent tool. Rate limit it, log it,
  and never let it return long verbatim excerpts of copyrighted works.

---

## 15. Build order

| Phase | Scope | Est. |
|-------|-------|------|
| **0** | Monorepo, DB, auth, CI, deploy skeleton | 1 wk |
| **1** | `gitd` + repo create/read/write + prose normalizer + commit path | 2 wks |
| **2** | **Dashboard UI** + manuscript editor + chapter CRUD | 2 wks |
| **3** | Provenance spans, trailers, receipts, `gitlit verify` | 2 wks |
| **4** | AI Researcher pipeline + SSE progress + architecture commit | 3 wks |
| **5** | Provenance Diff Viewer (Modes A/B/C) + derivation matcher | 3 wks |
| **6** | Prose Timeline + stats | 1.5 wks |
| **7** | Publisher verification links + public verifier + MCP server | 2 wks |
| **8** | Import/export (docx, epub), CLI, webhooks | 2 wks |

Phase 2 is what gets scaffolded on approval, per your Step 2.

---

## 16. Open questions — I need your call on these

1. **Novelty halt.** I have the pipeline *stop* on a `derivative` verdict and ask the
   author before spending on an outline. More honest, but it is friction in the magic
   moment. Keep the halt?
2. **Who is the paying customer?** Author subscription, or publisher seats for
   verification? This changes whether the publisher-facing verification view is a v1
   feature or a v2 one. I have it at Phase 7 — meaning we build the trust layer before
   we know who buys it.
3. **Does the AI ever write prose?** Current design: it writes *plans only*, never
   manuscript text. That is a much cleaner story for the provenance product, and it is
   also a real constraint on the product's usefulness to some authors. Hold the line?
4. **Import provenance.** Imported manuscripts start as `unknown`. Acceptable, or do we
   need an "attest this was human-written" flow (author signs a declaration) on import?
5. **Public by default for finished books?** A public gallery of provenance-verified
   books would be strong marketing, but it inverts §14's default. Opt-in only, I assume.

---

*Awaiting approval before scaffolding (Step 2).*
