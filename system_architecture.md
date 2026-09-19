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
- **Agent session** — one external agent (the author's Claude) working against a repo through our MCP server. Has an id and an observed tool-call log, and produces at most one architecture commit. GitLit does not run it and cannot see inside it.
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

### 2.5 Agent sessions are long-lived and resumable

A research session is 20–60 tool calls over 5–20 minutes of the author's Claude session.
Our side must tolerate an agent that pauses mid-research, loses connection, or resumes
tomorrow — so `agent_sessions` persists across MCP connections, keyed to the repo and
user rather than to a socket, with a 24h idle expiry.

Redis/BullMQ stays, but for *our* work only: diff computation, indexing, corpus sync,
exports. There is no inference pipeline for it to orchestrate any more.

### 2.6 GitLit does not run the AI — it instruments it

**GitLit holds no Anthropic API key, pays no inference bill, and resells no model.**
The author already pays for Claude. They connect to GitLit *from* Claude — via our MCP
server — and the work lands in the repository.

This inverts the usual shape of an "AI feature," and every consequence runs in our favor:

- **We become a notary rather than an interested party.** "Our AI did this, and we
  certify it" is self-attestation. "An external agent did this, and we recorded what
  crossed our boundary" is a neutral record. For a product whose entire value is
  trustworthiness, the second is a materially stronger position.
- **The AI Researcher is instrumentation, not inference** (§8). We supply search tools
  and a commit path; Claude supplies the judgment.
- **The ledger becomes a byproduct of tool use, not a self-report.** A model *asked* to
  record its sources honestly may not. A model that can only search through our
  instrumented tool produces a truthful ledger whether it intends to or not. Same
  principle as §12.7: the client never gets to assert its own provenance.
- **No manuscript ever goes to an AI vendor by us.** For authors — justifiably paranoid
  about unpublished work — this is a purchase criterion, and we can state it absolutely
  rather than as a policy promise.
- **We are not in the model business.** No model routing, no token accounting, no
  re-benchmarking the pipeline every time a new model ships, no cost caps, no margin on
  someone else's inference.
- **It generalizes.** The MCP contract is agent-agnostic. Claude Code today; whatever
  exists in three years connects the same way.

**The cost:** feature 2 now depends on the author having Claude. See §8.5 — the remote
MCP server means "install a CLI" is not the only on-ramp, which matters enormously when
the user is a novelist.

**The other cost, stated honestly:** the no-prose-from-AI rule (§16.2) is now enforceable
only on the honest path. Our MCP write tools refuse to touch `manuscript/`. An agent that
bypasses MCP and pushes over plain Git cannot be stopped — only observed and labeled.
That is the same trade as §3 everywhere else, and the answer is the same: make the honest
path the easy path, and record the rest truthfully.

### 2.7 Every number we publish must be reproducible offline

A receipt that says "34% divergence" is worthless if the number came from a hosted API
that will answer differently next year. Anyone holding a clone must be able to recompute
our published metrics and get the same answer, forever, with no network.

So the diff, derivation, and divergence math (§9) uses **only** deterministic local
computation: declared beat links, lexical n-gram matching, and a version-pinned local
embedding model whose weights hash is recorded in the receipt. No hosted embedding API,
even though a hosted one would score better.

This was a latent flaw in the first draft of this document — it routed divergence scoring
through Voyage, which would have made our headline metric unreproducible and our receipts
decorative. Moving inference out of the platform forced the fix.

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
| AI | **None in-platform.** No API key, no inference spend. Intelligence arrives via MCP from the author's own Claude (§2.6). | We instrument; we do not infer. |
| Agent interface | MCP server — stdio for Claude Code, streamable HTTP + OAuth for Claude desktop/web | This *is* feature 2's execution path, not an add-on. |
| Embeddings | Local ONNX — `bge-small-en-v1.5` (384-dim) via `fastembed`, into pgvector | Runs on CPU in the worker. Must be local: see §2.7. |
| Search/corpora | Open Library + Google Books + Crossref + Semantic Scholar (all free/keyed, non-AI) | Served *as MCP tools* so every query is logged to the ledger. |
| Auth | Auth.js v5 — GitHub OAuth, Google, email magic link; DB sessions | Authors are not all developers; email must work. |
| Signing | Ed25519 per-repo keys (libsodium); optional Sigstore/gitsign for orgs | Receipts in §7.4. |
| Object storage | S3-compatible (Cloudflare R2) | Repo bundles, exports, cover art, imported source docs. |
| Input capture | `beforeinput` / `paste` / `composition` events + aggregated cadence | GitLit Write instrumentation (§7.5). Aggregates only — never a keylog. |
| Realtime | SSE (agent session progress, timeline updates) | Simpler than WebSockets; unidirectional is all we need. |
| Email | Resend + React Email | Invites, session-complete, publisher verification links. |
| Observability | OpenTelemetry → Grafana Tempo/Loki; Sentry | Agent sessions are traces; we need per-tool-call spans. |
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
  AUTHOR'S CLAUDE   (their subscription, their tokens — outside our boundary)
   Claude desktop/web ──┐        Claude Code ──┐
                        │ HTTP+OAuth           │ stdio
                        ▼                      ▼
                   ┌──────────────────────────────┐
                   │  mcp (GitLit MCP server)     │──▶ Book & paper corpora
                   │  instrumented tools; every   │    (we run the query,
                   │  call → agent_tool_calls     │     we write the ledger)
                   └─────────────┬────────────────┘
   Browser ───────────▶┌─────────▼──────────────────┐
   (GitLit Write)      │  web (Next.js 15)          │
   GitLit CLI ───┐     │  RSC + TipTap + SSE client │
   git client ───┤     └──────────┬─────────────────┘
                 │                │ tRPC / REST
                 │     ┌──────────▼─────────────────┐
                 ├────▶│  api (Fastify + tRPC)      │
                 │     └───┬───────────┬────────────┘
                 │         │           │ enqueue
                 │         │      ┌────▼──────────────────┐
                 │         │      │ worker (BullMQ)       │
                 │         │      │ indexer, diffcalc,    │
                 │         │      │ local embeddings, sync│
                 │         │      └────┬──────────────────┘
                 │    ┌────▼───────────▼────────────┐
                 └───▶│  gitd (libgit2 + smart HTTP)│──▶ volume: /repos/**.git
                      └────┬────────────────────────┘
              ┌────────────▼──────────┐   ┌──────────┐   ┌─────┐
              │ Postgres 16 + pgvector│   │ Redis 7  │   │ R2  │
              └───────────────────────┘   └──────────┘   └─────┘

  Note what is absent: any arrow from a GitLit process to a model API.
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
    ├── sessions/
    │   └── sess_01J9F3.json        # observed tool-call log, one agent session
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
agent_session: sess_01J9F3XK2M
generated_at: 2026-09-19T14:02:11Z
declared_model: claude-opus-5   # agent claim, unverified (§8.4)
mcp_client: claude-desktop
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
Every source the model consulted. Full records in `.gitlit/research/ledger.jsonl`; every row was written by GitLit's own
search and fetch tools, not reported by the model (§8.2).

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
This document is the complete extent of machine authorship as of `sess_01J9F3XK2M`.
No prose in `manuscript/` was generated by this run.
```

That final section is not decoration — it is the assertion the whole product is
organized around, and it is signed.

### 6.4 Provenance sidecar (`.gitlit/provenance/<path>.jsonl`)

One JSON object per span, per file, rewritten on each commit that touches the file:

```json
{"start":0,"end":412,"origin":"human_written","commit":"a1b2c3d","author":"u_7k2","ts":"2026-09-21T10:14:02Z","evidence":["in_platform_typing"]}
{"start":412,"end":688,"origin":"human_edited_ai","commit":"e4f5a6b","session":"sess_01J9F3XK2M","declared_model":"claude-opus-5","retained":0.34,"evidence":["derived_from_beat:b1.2"]}
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
GitLit-Agent-Session: sess_01J9F3XK2M
GitLit-Declared-Model: claude-opus-5   (agent claim, unverified)
GitLit-Spans-Digest: sha256:7c4a...
GitLit-Evidence: in_platform_typing,paste:2
GitLit-Receipt: rcpt_01J9G88Q4P
```

These survive `git clone` and are readable by anyone with `git log`, with no GitLit
account and no network access. That is deliberate.

### 7.2 Provenance classes

- `ai` — machine authored, human did not touch it in this commit (architecture commits).
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
 "session":"sess_01J9F3XK2M","issued_at":"2026-09-21T10:14:03Z","key":"key_repo_9f2","sig":"ed25519:..."}
```

Chained to the previous receipt, so removing or reordering history breaks verification.
`gitlit verify` (CLI, and a public web verifier) re-walks the chain against the repo and
reports exactly which commits verify — offline, without trusting our servers.

Optional for publisher-tier repos: periodic anchoring of the chain head to an external
timestamp authority (RFC 3161), which converts "we say this existed on the 21st" into
"a third party attested this existed on the 21st."

### 7.5 Input provenance — GitLit Write

The Git remote and the MCP server cover text that arrives from outside. **GitLit Write**
covers text that is composed inside — a clean, distraction-free authoring surface (one
column, no chrome, the book and nothing else) that happens to be instrumented.

It is not a separate site. The entire value of the instrumentation is that it writes into
the same provenance chain as everything else; split it onto its own domain and it becomes
a nice text box with no memory. Market it under its own name later if that helps
acquisition, but it ships as the default writing surface of a GitLit repository.

#### 7.5.1 What the browser actually gives us

| Signal | Source | What it tells us |
|---|---|---|
| Paste | `paste` event + `beforeinput` `insertFromPaste` | Size, and the content itself. Catches Ctrl+V, context menu, middle-click. |
| Drop | `drop` + `insertFromDrop` | Dragged-in text. |
| Composition | `compositionstart/end` | IME and swipe-keyboard input — a distinct mode, never "paste". |
| Dictation | `insertReplacementText` + no keydown | Speech-to-text. |
| Synthetic input | `event.isTrusted === false` | Script-driven insertion. |
| Keystroke cadence | `keydown` intervals, aggregated | Burst shape, session rhythm, words-per-minute distribution. |
| Non-keyed growth | text delta with no preceding keydown | Text that appeared without being typed, by any route. |

Only aggregates leave the browser — inter-keystroke interval histograms, burst
boundaries, counts. **We never transmit or store a keylog.** Storing what an author typed,
keystroke by keystroke, would be a surveillance product and a breach liability, and it
buys us nothing the aggregates don't.

#### 7.5.2 What defeats it, stated plainly

- **Retyping.** Read AI output off a second screen, type it in by hand. Undetectable by
  us or by anyone. What we do is impose a real cost: retyping a 100k-word novel is weeks
  of labor. That is the honest claim — cost, not prevention.
- **Browser automation** (Playwright/CDP) produces genuinely trusted events and can model
  human cadence. Small population, real gap.
- **The Git remote.** Authors can push from any tool. Server-side spans mark those commits
  by what we can observe, not by what the client asserts (§12.7).

§3 governs: these are evidence signals, never proof.

#### 7.5.3 Design rule — record, do not accuse

Authors paste constantly and legitimately: from Scrivener, from their own notes, from a
scene cut three months ago. **Paste is not evidence of AI**, and a UI that implies it is
will insult its users on first contact.

Equally: dictation, switch access, IME, and swipe keyboards are accessibility and
language-support needs. Treating "did not type this" as "cheated" would make the product
discriminatory. Each gets its own input mode and none is flagged.

So every insertion carries a neutral, observed `input_mode`:

```
typed | pasted | dictated | composed | dropped | imported | ai_tool | synthetic
```

recorded as fact. The author may annotate a paste with its source ("my Scrivener draft"),
and that annotation is stored as **an author claim**, rendered distinctly from what the
system observed. We never collapse the two.

#### 7.5.4 Why this is an asset, not a police function

The pressing problem for honest authors today is not getting away with AI — it is **being
falsely accused of it** by detectors that do not work. A signed, timestamped record of a
manuscript accumulating over eight months at human cadence, with every paste accounted
for, is an affirmative defense that is currently unpurchasable.

That is the product: *proof of work for the accused*, with detection as a side effect.
It also determines the UI's voice — the provenance panel reads as a record of the
author's labor, never as a report on their conduct.

#### 7.5.5 Session and event model

A **authoring session** is a contiguous writing period (30-minute idle timeout). It
stores aggregates. An **input event** is stored only for non-typed insertions above a
threshold (default 200 characters) — typed text produces no per-event rows at all, only
session aggregates. Retention: input events expire after 24 months unless the repo has
an active verification link.

Events feed span evidence (§7.3) and the Prose Timeline's session density overlay (§10).
SHA-256 of pasted content is stored, not the content — enough to prove the same block was
pasted twice or matches an AI run's output, without retaining a copy.

---

## 8. The AI Researcher — an instrumented agent workflow

The feature is unchanged from the author's point of view: submit a premise, get a
novelty check and a committed `manuscript_architecture.md`. What changed is where the
thinking happens. GitLit supplies **instrumented tools and a constrained commit path**;
the author's Claude supplies the intelligence and pays for itself.

### 8.1 Shape

```
Author (in Claude Code or Claude desktop):
  "Research the premise on my GitLit repo 'saltmarsh' and write the architecture."

Claude                          GitLit MCP server              GitLit
  |                                    |                          |
  |-- gitlit_get_premise ------------->|                          |
  |<-- premise text, repo config ------|                          |
  |                                    |                          |
  |-- gitlit_search_prior_works(q) --->|-- Open Library/GBooks -->| ledger row written
  |<-- hits ---------------------------|                          | (per query, per hit)
  |      (x8 queries, model's choice)  |                          |
  |                                    |                          |
  |-- gitlit_similarity_check(text) -->|-- local embeddings ----->| deterministic score
  |<-- nearest works + scores ---------|                          |
  |                                    |                          |
  |-- gitlit_record_novelty(verdict) ->|                          | novelty_reports row
  |      <- HALT here if derivative and the toggle is on ->       |
  |                                    |                          |
  |-- gitlit_add_source(url, excerpt)->|-- fetch + hash --------->| ledger row + blob
  |      (research phase, x N)         |                          |
  |                                    |                          |
  |-- gitlit_commit_architecture(md) ->|-- validate + normalize ->| commit, provenance: ai
  |<-- commit sha, receipt id ---------|                          | receipt signed
```

Every arrow into GitLit is logged as an `agent_tool_call`. The audit trail is **observed
at our boundary**, which is strictly better evidence than a pipeline narrating its own
behavior — the previous design's step log was our own code's account of itself.

### 8.2 The ledger cannot be faked, by construction

`gitlit_search_prior_works` is the only search tool we expose, and it writes a
`research_sources` row for every query and every hit **before** returning results. A
model cannot claim to have searched what it did not search, or omit a source it found
inconvenient, because it never touches the corpora directly.

`gitlit_add_source(url, excerpt)` fetches the URL server-side, hashes the content, and
stores the excerpt *we* retrieved — not the excerpt the model reported. A hallucinated
citation fails at fetch time and is recorded as a failed call, visible in the ledger.

This is the single most important property in this section: **honesty is a consequence of
the tool surface, not of the model's cooperation.**

### 8.3 What the commit path enforces

`gitlit_commit_architecture` is deliberately narrow:

- Writes **only** `manuscript_architecture.md` and `.gitlit/**`. It cannot write to
  `manuscript/`. This is how "the AI never writes prose" (§16.2) is enforced — in code,
  on the honest path.
- Validates the document against the §6.3 schema; malformed input is rejected with a
  parse error the agent can act on.
- Requires that every beat's cited source ids exist in the ledger for this session.
  Fabricated `S-` references fail the commit.
- Stamps provenance `ai`, links the agent session, signs, emits a receipt.
- Refuses if the novelty check halted and the author has not responded.

### 8.4 What we can and cannot know about the agent

We observe: which tools were called, with what arguments, in what order, at what times,
and what we returned. We do **not** observe the model, the prompt, the reasoning, or the
token spend — all of that is inside the author's Claude session.

The agent may *declare* its model and version, and we record that as
`agent_sessions.declared_model`, rendered in the UI as **an agent claim**, in the same
visual register as an author's paste annotation (§7.5.3) and never as verified fact. We
did not check it and we will not imply that we did.

### 8.5 On-ramps — the novelist problem

Feature 2 now requires the author to have Claude. A CLI install is a large ask of someone
who writes literary fiction, so the MCP server ships in two transports:

| Transport | Client | Author profile |
|---|---|---|
| stdio | Claude Code | Technical authors; also how *we* develop. |
| Streamable HTTP + OAuth | Claude desktop / web connectors | **The default path.** Connect GitLit once in settings, then ask in plain English. |

The HTTP transport is not a secondary nicety — it is how most authors will ever use
feature 2, and it should be built first. Onboarding target: *connect GitLit → say
"research my premise" → architecture doc committed*, with no terminal and no file paths.

For authors with no Claude at all, GitLit still fully works as a manuscript repository
with provenance, timeline, and diff — feature 2 is the part that requires bringing an
agent. That degradation is graceful and worth stating on the marketing site rather than
hiding: the version control and the record are free and standalone.

### 8.6 Rate limiting without inference cost

We no longer meter tokens. We still meter the tools that cost *us* money or goodwill:

- Corpus API calls (Google Books and Crossref have quotas we must respect).
- Server-side URL fetches in `gitlit_add_source` — bounded per session, size-capped,
  SSRF-guarded.
- Local embedding compute — CPU-bound, queued.

Per-session caps: 40 searches, 100 source fetches, 1 architecture commit. Generous for a
real research session, tight enough that GitLit is not a free scraping proxy.

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
  agent_session_id TEXT REFERENCES agent_sessions,
  declared_model TEXT,               -- agent claim, unverified
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
  agent_session_id TEXT REFERENCES agent_sessions, model TEXT,
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

CREATE TABLE authoring_sessions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
  paths TEXT[] NOT NULL DEFAULT '{}',
  words_added INT NOT NULL DEFAULT 0, words_removed INT NOT NULL DEFAULT 0,
  keystrokes INT NOT NULL DEFAULT 0,          -- count only, never content
  iki_histogram INT[] NOT NULL DEFAULT '{}',  -- inter-keystroke interval buckets
  median_wpm REAL, burst_count INT,
  mode_words JSONB NOT NULL DEFAULT '{}',     -- {typed: 812, pasted: 140, dictated: 0}
  client TEXT NOT NULL,                       -- write_web | write_desktop | git | mcp
  commit_shas CHAR(40)[] NOT NULL DEFAULT '{}'
);
CREATE INDEX sessions_repo ON authoring_sessions (repo_id, started_at DESC);

CREATE TABLE input_events (        -- NON-TYPED insertions only, >= threshold chars
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES authoring_sessions ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  path TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
  input_mode TEXT NOT NULL,        -- pasted | dictated | composed | dropped
                                   -- | imported | ai_tool | synthetic
  char_count INT NOT NULL, word_count INT NOT NULL,
  content_hash TEXT NOT NULL,      -- sha256 of inserted text; text NOT stored
  is_trusted BOOLEAN NOT NULL DEFAULT TRUE,
  matched_matched_session_id TEXT REFERENCES agent_sessions, -- hash matches agent output
  author_note TEXT,                -- AUTHOR CLAIM about origin, not an observation
  author_noted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX input_events_repo ON input_events (repo_id, occurred_at DESC);

CREATE TABLE timeline_events (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,       -- commit | run_started | run_completed | run_halted
                            -- | phase_change | tag | collaborator_added | verification
  phase TEXT, commit_sha CHAR(40), agent_session_id TEXT, actor_id TEXT REFERENCES users,
  payload JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX timeline_scan ON timeline_events (repo_id, occurred_at);
```

### 11.4 Agent sessions and research logs

These tables record what an **external** agent did at our boundary. We store no tokens,
no cost, and no prompts — we never see them.

```sql
CREATE TABLE agent_sessions (      -- was ai_runs; now external, not ours
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users,       -- whose MCP credential
  transport TEXT NOT NULL,          -- stdio | http
  client_name TEXT,                 -- MCP clientInfo: "claude-code", "claude-desktop"
  declared_model TEXT,              -- AGENT CLAIM, never verified (§8.4)
  kind TEXT NOT NULL,               -- researcher | novelty_only | outline_refresh | other
  status TEXT NOT NULL,             -- active | halted | committed | abandoned | expired
  halt_reason TEXT,                 -- derivative_premise | quota | user_cancelled
  premise_id TEXT REFERENCES premises,
  output_commit_sha CHAR(40),
  tool_calls INT NOT NULL DEFAULT 0,
  searches INT NOT NULL DEFAULT 0, fetches INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE INDEX agent_sessions_repo ON agent_sessions (repo_id, started_at DESC);

CREATE TABLE agent_tool_calls (    -- the audit trail, observed not self-reported
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  seq INT NOT NULL, tool TEXT NOT NULL,
  args_hash TEXT NOT NULL, args_redacted JSONB,
  result_hash TEXT, result_ref TEXT,          -- R2 key for large payloads
  status TEXT NOT NULL,                       -- ok | rejected | failed
  reject_reason TEXT,                         -- e.g. path_outside_allowlist,
                                              -- unknown_source_ref, fetch_failed
  duration_ms INT, called_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX tool_calls_session ON agent_tool_calls (session_id, seq);

CREATE TABLE premises (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  text TEXT NOT NULL, text_hash TEXT NOT NULL,
  themes TEXT[], entities JSONB,
  embedding VECTOR(384),            -- local bge-small; dim pinned with model hash
  embedding_model TEXT NOT NULL,    -- "bge-small-en-v1.5@sha256:..." for reproducibility
  UNIQUE (repo_id, version)
);

CREATE TABLE research_sources (      -- the ledger; written by OUR tools, not the model
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  ledger_ref TEXT NOT NULL,          -- "S-014"
  discovered_via TEXT NOT NULL,      -- search_query | direct_fetch | user_supplied
  query TEXT,                        -- the exact query WE ran
  source_type TEXT NOT NULL,         -- web | book | paper | dataset
  url TEXT, title TEXT, authors TEXT[], publisher TEXT, published_at DATE,
  identifier TEXT,                   -- ISBN / DOI
  retrieved_at TIMESTAMPTZ NOT NULL, fetch_status TEXT NOT NULL,
  content_hash TEXT, excerpt TEXT, excerpt_ref TEXT,
  domain TEXT, used_in_beats TEXT[],
  embedding VECTOR(384)
);
CREATE INDEX sources_repo ON research_sources (repo_id, domain);

CREATE TABLE novelty_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories ON DELETE CASCADE,
  premise_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,             -- sparse_prior_art | crowded_field | derivative
  corpus_similarity REAL,            -- computed BY US, deterministically (§2.7)
  concept_overlap REAL, market_density INT,
  corpora TEXT[] NOT NULL, searched_at TIMESTAMPTZ NOT NULL,
  nearest_works JSONB NOT NULL,
  rationale TEXT NOT NULL,           -- the agent's prose reasoning (an agent claim)
  author_response TEXT,              -- revised | proceeded_anyway | abandoned
  author_responded_at TIMESTAMPTZ
);

CREATE TABLE prior_works (           -- corpus for similarity search
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- openlibrary | googlebooks | crossref | manual
  external_id TEXT, title TEXT NOT NULL, authors TEXT[],
  published_year INT, isbn TEXT, synopsis TEXT, subjects TEXT[],
  embedding VECTOR(384),
  UNIQUE (source, external_id)
);
CREATE INDEX prior_works_ann ON prior_works
  USING hnsw (embedding vector_cosine_ops);
```

Note the split in `novelty_reports`: the **scores are ours**, computed deterministically
and reproducible offline (§2.7); the **rationale is the agent's**, stored and displayed as
a claim. Keeping those in one row but distinct in the UI is the pattern used throughout.

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

### 12.4 Research (agent-driven)

The heavy lifting is MCP (§12.8). These REST routes let the *web app* show and steer what
the agent is doing, and let an author work without an agent.

```
POST   /repositories/:owner/:slug/premise             { text }        → premise version
GET    /repositories/:owner/:slug/agent-sessions?cursor=
GET    /agent-sessions/:id                            → status, tool-call summary
GET    /agent-sessions/:id/events                     → text/event-stream (live)
GET    /agent-sessions/:id/tool-calls                 → full observed audit trail
POST   /agent-sessions/:id/cancel                     → subsequent tool calls rejected
GET    /agent-sessions/:id/novelty                    → novelty_report
POST   /agent-sessions/:id/novelty/respond            { revised|proceed|abandon }
GET    /repositories/:owner/:slug/research/ledger?cursor=
POST   /repositories/:owner/:slug/research/sources    { url }   ← author adds own source
GET    /repositories/:owner/:slug/architecture?ref=   → parsed manuscript_architecture.md
GET    /repositories/:owner/:slug/mcp-setup           → connect instructions + OAuth link
```

`/agent-sessions/:id/events` is what makes the web app feel alive while the work happens
in Claude: the author watches the ledger fill in real time in a browser tab. Good demo,
and genuinely reassuring — it makes the research visible rather than a black box that
returns a document.

`POST /novelty/respond` still gates the architecture commit; the MCP tool refuses until
it is answered (§8.3), so the human stays in the loop across the boundary.

### 12.4b GitLit Write sessions

```
POST   /repositories/:owner/:slug/sessions              { path } → session_id
PATCH  /sessions/:id                                    { aggregates, events[] }  (batched)
POST   /sessions/:id/close
GET    /repositories/:owner/:slug/sessions?from=&to=
PATCH  /input-events/:id                                { author_note }  ← author claim
```

The client batches aggregates every 30s and on blur. Input events are rejected server-side
if they arrive without a valid session, so the record cannot be trivially suppressed by a
client that simply stops reporting — a commit with no session and no Git-remote origin is
recorded as `unknown`, not as typed.

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

### 12.8 MCP server — the primary agent interface

`apps/mcp`. Not a package and not an integration: this is how feature 2 executes.
Two transports (§8.5). Auth is OAuth 2.1 for HTTP, API token for stdio; every tool call
is scoped to repos the credential can reach and logged to `agent_tool_calls`.

| Tool | Purpose | Guardrail |
|---|---|---|
| `gitlit_list_repositories` | Find the author's books. | Scoped to credential. |
| `gitlit_get_premise` | Premise + repo config for context. | — |
| `gitlit_search_prior_works` | Novelty search across corpora. | **We run the query**; every hit is a ledger row. 40/session. |
| `gitlit_similarity_check` | Deterministic local-embedding scoring. | Scores are ours, not the model's (§2.7). |
| `gitlit_record_novelty` | Record verdict + rationale. | Rationale stored as agent claim. Halts if `derivative`. |
| `gitlit_add_source` | Add a source to the ledger. | **We fetch and hash the URL.** Hallucinated citations fail here. 100/session. SSRF-guarded. |
| `gitlit_commit_architecture` | Commit `manuscript_architecture.md`. | Path allowlist, §6.3 schema validation, ledger-ref check, 1/session. |
| `gitlit_read_document` | Read a chapter with provenance. | Read-only. |
| `gitlit_provenance_summary` | Current human/AI share. | Read-only. |
| `gitlit_diff_plan` | Plan-vs-prose divergence. | Read-only. |

**There is deliberately no `gitlit_write_document`.** The earlier draft had one; it is
removed. A general prose-write tool is exactly the hole through which "the AI never
writes prose" leaks, and the convenience is not worth it. Agents that want to draft can
do so in the author's own files and the author can paste — which §7.5 records honestly.

Tool *descriptions* state the provenance consequences plainly, so a well-behaved agent
tells the author what will be recorded before acting.

### 12.9 Webhooks

Events: `agent_session.committed`, `agent_session.halted`, `commit.created`, `phase.changed`,
`divergence.threshold_crossed`, `verification_link.viewed`. HMAC-SHA256 signed,
exponential-backoff retries, deliveries logged.

---

## 13. Monorepo layout

```
gitlit/
├── apps/
│   ├── web/              Next.js 15 — dashboard, editor, diff viewer, timeline
│   ├── api/              Fastify + tRPC + REST façade
│   ├── mcp/              MCP server — stdio + HTTP; feature 2's execution path
│   ├── worker/           BullMQ processors: indexer, diffcalc, corpus sync, export
│   └── gitd/             libgit2 service + smart HTTP + pre-receive hooks
├── packages/
│   ├── db/               Drizzle schema, migrations, seed
│   ├── core/             domain types, Zod schemas, ULIDs, shared errors
│   ├── prose/            normalizer, sentence segmenter, word count, docx/epub io
│   ├── diff/             sentence diff, move detection, derivation matcher
│   ├── provenance/       spans, trailers, receipts, signing, verifier
│   ├── research/         corpora clients, ledger writer, novelty scoring (local)
│   ├── embed/            pinned local ONNX model + weights hash (§2.7)
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
- **We send no manuscript to any AI vendor, ever** — not as policy but as architecture
  (§2.6). GitLit holds no model API key. What the author's own Claude reads is governed by
  the author's own agreement with Anthropic, and the MCP read tools are scoped and logged
  so they can see exactly what was accessed.
- **No training on user content.** Trivially true for us; state it plainly on the
  marketing site, because for this audience it is a purchase criterion.
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
| **2** | **Dashboard UI** + GitLit Write editor + chapter CRUD | 2.5 wks |
| **3** | Provenance spans, trailers, receipts, `gitlit verify` | 2 wks |
| **3.5** | Input provenance capture + session model (§7.5) | 1 wk |
| **4** | MCP server (both transports) + research tools + SSE session view | 2.5 wks |
| **5** | Provenance Diff Viewer (Modes A/B/C) + derivation matcher | 3 wks |
| **6** | Prose Timeline + stats | 1.5 wks |
| **7** | Publisher verification links + public verifier + gallery | 2 wks |
| **8** | Import/export (docx, epub), CLI, webhooks | 2 wks |

Phase 2 is what gets scaffolded on approval, per your Step 2.

Input capture (3.5) lands right after the span model it feeds, and deliberately *after*
the editor exists — instrumenting a writing surface that has not proven pleasant to write
in is optimizing the wrong thing. Phase 2's success test is an author finishing a session
in it without noticing the version control at all.

---

## 16. Decisions (resolved 2026-09-19)

1. **Novelty halt — toggle, defaulting to on.** `repositories.halt_on_derivative`.
   The run pauses on a `derivative` verdict and asks; authors who find it patronizing
   turn it off once. Either way the verdict is recorded in the architecture doc.
2. **Free to use.** No author paywall. Publisher verification becomes the revenue line
   once there is enough adoption for publishers to care. Affordable because of decision
   7 — see §16.1.
3. **The AI never writes prose.** Hard platform constraint: the AI Researcher emits
   plans, ledgers, and outlines only, and never writes into `manuscript/`. Enforced in
   the commit path, not by policy. Repos containing AI-generated prose are **labeled,
   not deleted** — see §16.2.
4. **Imports are labeled `imported`,** permanently and visibly. No attestation flow; an
   author signing a declaration that text is theirs adds a claim we cannot check, and
   the honest label is more valuable than a decorative one.
5. **Public gallery is opt-in,** per-repo, default off, and revocable.

Plus one new decision from the same round:

6. **GitLit Write ships as the default authoring surface** (§7.5), instrumented for
   input provenance, recording rather than accusing. Not a separate site.
7. **GitLit runs no AI and holds no model API key** (§2.6). Authors connect from their own
   Claude via our MCP server. This is the largest structural change in the document: it
   rewrites §8 from a server-side inference pipeline into an instrumented tool surface,
   deletes the inference cost model, strengthens the trust position from self-attestation
   to notarization, and forces every published metric to be locally reproducible (§2.7).

### 16.1 "Free" is now actually affordable

The cost controls drafted here previously assumed we paid for inference. **We do not**
(§2.6), so most of them are deleted. What a free tier costs us now:

- **Storage:** a 150k-word novel with full history is ~15MB of text. Negligible.
- **Corpus API quotas:** Google Books and Crossref have limits. Capped per session
  (§8.6) and cached in `prior_works` across all users — popular titles are fetched once
  platform-wide.
- **URL fetching** in `gitlit_add_source`: bandwidth plus abuse surface. Size-capped,
  rate-limited, SSRF-guarded. The real risk here is being used as a scraping proxy, not
  the cost.
- **Local embedding compute:** CPU in the worker. Scales with writing volume, which is
  slow by nature. A book is 150k words, not 150M.
- **`gitd` volume and egress:** the only line item that grows meaningfully with success,
  and it grows linearly and predictably.

So free is sustainable, and the paid tier is publisher verification, exactly as decided.
Feature 2's marginal cost is borne by the author's existing Claude subscription, which is
the correct place for it — they are getting the value directly and they already pay for it.

Remaining guard: research tools behind email verification + 24h account age, or GitLit
becomes a free book-search API within a week of launch.

### 16.2 One thing I want to push back on — removal

The decision recorded above is "labeled, not deleted," which is not quite what was asked
for. The reasoning, briefly:

- We cannot reliably detect AI prose (§7.5.2). An enforcement regime built on unreliable
  detection punishes the honest — the authors we would catch are the ones who *self
  -declared*, while the retypers sail through. That is a perverse incentive aimed
  squarely at our best users.
- Deleting an author's manuscript is the most destructive act available to us. If we are
  ever wrong once, in public, the platform is finished.
- Strategically it is the wrong business. "We remove AI books" makes us an AI-detection
  company, competing with tools that demonstrably do not work. "We record what happened"
  makes us a provenance company. Only the second is defensible.

The enforcement that *does* work, and is recommended instead:

- The **public gallery (§16.5) has a bar.** Listing requires a provenance standard:
  no AI-generated prose spans, no unexplained bulk pastes, a continuous session record.
  That is a real, enforceable gate on the thing authors actually want — visibility.
- **Publisher verification (§12.6) surfaces the full record**, so a publisher can decline
  the book. Let the market enforce it; that is what the record is for.
- Deletion stays reserved for what it is normally reserved for — abuse, plagiarism
  reports, illegal content — with an appeal path.

Say the word if you still want removal and I will design the enforcement path; I would
want us to agree on the false-positive cost first.

### 16.3 Still open

- **`write.gitlit.app` as a marketing surface** — same app, same account, different front
  door, for authors who want the writing tool before they want version control. Cheap to
  do later, so not scaffolded now. Worth revisiting after Phase 2.

---

*Approved 2026-09-19, revised same day for decision 7. Scaffolding Phases 0–2 on go.*
