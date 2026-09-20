# GitLit

Version control for book manuscripts, with verifiable provenance.

Architecture and rationale: [`system_architecture.md`](./system_architecture.md).
Section references in code comments (§7.3, §8.2, …) point there.

## What is scaffolded

Phases 0–2 of the build order (§15).

| Package | What it does | Tested |
|---|---|---|
| `packages/core` | Domain types, ULIDs, path allowlist (§8.3) | via consumers |
| `packages/prose` | Prose normalizer — one sentence per line (§2.2) | 21 tests |
| `packages/diff` | Sentence diff, move detection, word runs (§9.3) | 18 tests |
| `packages/provenance` | Spans, trailers, signed receipt chain (§7) | 28 tests |
| `packages/auth` | Credentials, roles, the authorization decision | 94 tests |
| `packages/db` | Drizzle schema for §11, migrations, PGlite test harness | 13 tests |
| `apps/gitd` | The commit path — the only writer of provenance (§5) | 16 tests |
| `apps/api` | REST surface (§12), authorization enforcement | 43 tests |
| `apps/web` | Dashboard + GitLit Write (§7.5) | — |
| `apps/mcp` | MCP server — how the AI Researcher executes (§8) | 55 tests |

## Two properties worth knowing before reading the code

**There is no model API key anywhere in this repo, and there is not meant to be.**
GitLit runs no inference (§2.6). Authors connect from their own Claude over MCP,
which is Phase 4.

**Provenance is never taken from the caller.** The write path accepts a
`newTextOrigin` describing how text *arrived*, but what survives from the parent
commit is recomputed in `apps/gitd/src/commit-path.ts`. A client cannot assert
its own provenance class (§7.2).

## Running it

```bash
pnpm install
docker compose up -d          # postgres + redis (not needed for the demo below)
cp .env.example .env

pnpm --filter @gitlit/gitd build && node apps/gitd/dist/index.js &
pnpm --filter @gitlit/api dev &
pnpm --filter @gitlit/web dev
```

Then open http://localhost:3000.

## Checks

```bash
pnpm test        # 341 tests
pnpm typecheck
```

## Data

Postgres 16 via Drizzle. `pnpm db:migrate` applies `packages/db/migrations`.

**Tests run against real Postgres, in-process.** PGlite is Postgres compiled to
WASM, so the suite executes the same migrations and the same SQL production
does — no mock, no in-memory stand-in with different semantics. This is not
pedantry: the first thing it caught was a unique index over a nullable column,
which Postgres does not enforce at all (`NULL != NULL`), so the same author
could create the same book slug twice. Nothing short of real Postgres finds
that.

Two things the database is **not**:

- It is not the source of truth for content or provenance. Those live in Git
  (§2.3), and every table derived from them can be rebuilt by replaying a
  repository's history.
- It is not optional for identity. Users, sessions and tokens have no other
  source of truth — losing them loses real state rather than something a
  reindex could reconstruct.

Embeddings are stored as `real[]` rather than pgvector's `vector(384)` for now:
nothing reads or writes one yet (§2.7 — the pinned local model is Phase 5), and
a portable type keeps the whole schema runnable under PGlite. Adding pgvector
later is one `ALTER` per column plus the HNSW index; the data shape is unchanged.

## Git access

Every GitLit book is a real Git repository and you can clone it:

```bash
git clone http://x:<your-api-token>@localhost:4001/<owner>/<slug>.git
```

The protocol is handled by git's own `upload-pack` and `receive-pack` in
`--stateless-rpc` mode, the same approach Gitea and GitLab take. Pack
negotiation is a large amount of subtle code with nothing to gain from
reimplementing; what is worth owning is the layer around it.

Auth is HTTP Basic with an API token as the password (the username is ignored,
as on every other host). The decision itself is made by the API, not by gitd —
one `authorize()` call covers a browser request and a `git push` alike, rather
than two implementations that drift. Scopes apply: a `repo:read` token can
clone and cannot push.

**A pushed commit may not assert its own provenance.** GitLit issues
`GitLit-` trailers from the commit path, where spans are actually computed.
A commit arriving over the wire carries no such evidence, so a `pre-receive`
hook rejects any push whose new commits carry those trailers:

```
remote: GitLit refused this push.
remote:   Commit 0f88061 carries GitLit- provenance trailers.
remote:   Those trailers are issued by GitLit itself, from the commit path
remote:   where spans are actually computed...
```

Push without them and the push is accepted; the prose is recorded as `unknown`
origin, which means only that GitLit did not observe how it was written. That
is an honest state (§6.4), not a penalty — an author writing in their own
editor is doing something entirely legitimate.

## Authentication

Passwordless, and backed by Postgres. Sign-in is a single-use emailed link, so there is no password to
leak, reuse, or hash badly — and nothing for an author to lose along with access
to their manuscript. In development the link is returned in the response rather
than emailed.

Three credential types, all 256-bit random and stored as SHA-256 verifiers with
constant-time comparison:

| Credential | Prefix | Used by |
|---|---|---|
| Magic link | `glm_` | Sign-in. Single use, 15-minute expiry. |
| Web session | `gls_` | The browser. HttpOnly cookie, 30-day expiry. |
| API token | `glt_` | CLI and MCP. Scoped, revocable, shown once. |

**Scope bounds role, never widens it.** An owner acting through a `repo:read`
token cannot write. This is checked *before* the role, so a broad role cannot
rescue a narrow credential.

**`agent:research` is separate from `repo:write`.** An MCP token carries the
former and not the latter, so the credential itself cannot author prose even
before the path allowlist is consulted — scope, allowlist and gitd's own check
are three independent layers over one rule (§8.3).

**Denials return 404, not 403, when the caller cannot read the repo at all.**
Telling a stranger that `mara/secret-novel` exists leaks that an author is
writing it, which for an unpublished manuscript is itself sensitive.

Roles: `owner`, `co_author`, `editor`, `beta_reader`, `verifier`. A verifier can
check provenance without reading the manuscript, and neither they nor a beta
reader can write — a provenance system whose reviewers can edit what they are
attesting to is worthless.

`gitd` requires `GITD_SERVICE_TOKEN` and refuses to start without it in
production. It holds every repository and the commit path; if it is reachable
unauthenticated, authorization in the API is decorative.

## Connecting from Claude

GitLit holds no model API key. The research in feature 2 runs on the author's
own Claude, which connects to GitLit over MCP (§2.6).

**Claude desktop / web** — the default on-ramp, no terminal needed:

```bash
pnpm --filter @gitlit/mcp build && node apps/mcp/dist/http.js   # :4002/mcp
```

Then add `http://localhost:4002/mcp` as a connector in Claude's settings.

**Claude Code:**

```bash
claude mcp add gitlit -- node /path/to/GitLit/apps/mcp/dist/stdio.js
```

Both need `GITLIT_API_TOKEN` — a token you mint in GitLit with the
`agent:research` and `repo:read` scopes. The MCP server goes through the API,
never directly to gitd, so every agent call passes the same permission checks a
browser request does.

Ten tools, and note what is missing: **there is no tool that writes prose.**
`gitlit_commit_architecture` can only write `manuscript_architecture.md` and
`.gitlit/**` — the path allowlist lives in `packages/core` and is enforced
again in gitd's commit path.

Two properties are worth understanding before trusting the output:

**The ledger cannot be faked.** `gitlit_search_prior_works` runs the query
itself and writes every hit to the ledger *before* returning it;
`gitlit_add_source` fetches and hashes the URL server-side and stores the
excerpt *it* retrieved. A citation the agent invents fails at commit time with
the list of refs that actually exist.

**The scores are ours; the reasoning is the agent's.** Novelty numbers are
computed locally and deterministically (`novelty/lexical-v1`) so anyone with a
clone can reproduce them offline. The agent's rationale and its declared model
are stored as *claims* and rendered as such.

## Known gaps — read this before trusting the build

These are staging, not surprises. What is *not* on this list is real and tested.

| Gap | Consequence today | Blocks |
|---|---|---|
| **No OAuth providers.** Sign-in is email magic link only. | Authors cannot use "Sign in with GitHub/Google" yet. The session and token layers are provider-agnostic. | Convenience, not security. |
| **Git smart HTTP not implemented** (§12.7). | `git clone` of a GitLit repo does not work over the network yet, though the repos on disk are ordinary bare Git repos. | The "clone it and verify offline" promise. |
| **No OAuth on the MCP HTTP transport.** | Any bearer token maps to the demo user. | Multi-user MCP. |
| **Novelty scoring is lexical**, not semantic. | Verdicts are weaker than the design intends. The tool says so rather than implying otherwise. | Quality, not correctness. |
| **Composer is a `<textarea>`**, not TipTap. | No rich text. The input provenance model is real and wired. | Editing comfort. |
| **No web tests.** | UI regressions are uncaught. | Confidence in `apps/web`. |

Signing keys are **not** on this list any more: they persist per repo, survive
restarts, are wrapped with AES-256-GCM when `SIGNING_MASTER_KEY` is set, and the
service refuses to start rather than regenerate a key and orphan an existing
receipt chain.

## What is deliberately absent

- **Local embeddings.** Novelty scoring is lexical today. The `Embedder`
  interface and the pinned-model slot exist (`src/novelty.ts`); the bge-small
  ONNX weights are Phase 5. Until then the tool says its scores are lexical
  rather than implying semantic comparison.
- **OAuth.** The HTTP transport takes a bearer token placeholder; §12.8's
  OAuth 2.1 flow maps it to a user. The tool layer is already user-scoped, so
  that swap does not reach the tools.
- **Postgres wiring.** The schema is written and typechecks; the API still uses an
  in-memory index. Because Postgres is only an index over Git (§2.3), swapping it
  in changes no provenance behaviour.
- **Smart HTTP / SSH transport** (§12.7), so `git clone` of a GitLit repo is not
  live yet, though the repositories on disk are ordinary bare Git repos.
- **TipTap.** The composer is an instrumented `<textarea>`; the input provenance
  model is real, the rich-text layer is Phase 2.5.
