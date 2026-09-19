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
| `apps/api` | REST surface (§12) | — |
| `apps/web` | Dashboard + GitLit Write (§7.5) | — |

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
pnpm test        # 83 tests
pnpm typecheck
```

## What is deliberately absent

- **MCP server** (Phase 4) — how the AI Researcher actually executes (§8).
- **Postgres wiring.** The schema is written and typechecks; the API still uses an
  in-memory index. Because Postgres is only an index over Git (§2.3), swapping it
  in changes no provenance behaviour.
- **Smart HTTP / SSH transport** (§12.7), so `git clone` of a GitLit repo is not
  live yet, though the repositories on disk are ordinary bare Git repos.
- **TipTap.** The composer is an instrumented `<textarea>`; the input provenance
  model is real, the rich-text layer is Phase 2.5.
