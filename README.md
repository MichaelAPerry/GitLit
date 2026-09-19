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
| `packages/db` | Drizzle schema for §11 | typechecked |
| `apps/gitd` | The commit path — the only writer of provenance (§5) | 16 tests |
| `apps/api` | REST surface (§12) | 13 tests |
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
pnpm test        # 178 tests
pnpm typecheck
```

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
| **No auth.** Hardcoded `u_demo`; every repo owned by `demo`. | Anyone reaching the API can do anything. No login, no permissions, no collaborator checks. | Any deployment. |
| **Postgres not wired.** Schema typechecks; nothing imports it. | Repositories and authoring sessions are in-memory and die with the API process. Git history survives — it is on disk — so nothing a commit recorded is lost. | Multi-process, restarts. |
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
