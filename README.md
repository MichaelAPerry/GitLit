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
| `packages/diff` | Sentence diff, move detection, plan-to-prose derivation (§9) | 45 tests |
| `packages/embed` | Pinned local embedding model (§2.7) | 24 tests |
| `packages/provenance` | Spans, trailers, signed receipt chain (§7) | 28 tests |
| `packages/auth` | Credentials, roles, OAuth, the authorization decision | 136 tests |
| `packages/db` | Drizzle schema for §11, migrations, PGlite test harness | 16 tests |
| `packages/mail` | Sign-in email, Resend transport, the production guard | 24 tests |
| `packages/observability` | Error monitoring, and what may never leave the process | 51 tests |
| `apps/gitd` | The commit path, backups, offline verification (§5, §7.4) | 82 tests |
| `apps/api` | REST surface (§12), authorization enforcement, rate limits | 72 tests |
| `apps/web` | Dashboard, GitLit Write, Provenance Diff Viewer | 79 tests + 4 in-browser |
| `apps/mcp` | MCP server — how the AI Researcher executes (§8) | 73 tests |

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
pnpm test        # 668 tests
pnpm typecheck
pnpm --filter @gitlit/web test:e2e   # 4 real-browser tests
```

The browser tests exist for one reason: jsdom dispatches only synthetic
events, so `isTrusted` is always false there and "genuine typing is trusted"
is unverifiable by construction. That distinction is what separates an author
writing from a script driving the page, so it gets a real browser.

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

Embeddings are stored as `real[]` rather than pgvector's `vector(384)`. The
dimensions and values are final — they come from the pinned model below — but
`real[]` keeps the schema runnable under PGlite, which is how it gets tested.
Moving to pgvector is one `ALTER` per column plus an HNSW index, and buys ANN
search over the prior-works corpus; nothing needs it at current scale.

## The embedding model

Novelty scoring blends word overlap with meaning. The semantic half runs on a
pinned local model — `bge-small-en-v1.5`, 384 dimensions, int8 ONNX — fetched
rather than committed:

```bash
pnpm --filter @gitlit/embed fetch-model    # 34MB, hash-verified
```

**It runs under WebAssembly, and that is the point.** Native ONNX dispatches to
platform-specific SIMD kernels, so the same weights on a different CPU can
return slightly different floats — enough to move a published similarity in
the third decimal and make a receipt look tampered with. WASM has
deterministic floating-point semantics by specification: the same input gives
bit-identical output on every machine. That is worth more here than the speed
of the native build, and it is what lets §2.7 hold for a semantic score at all.

Three things are pinned, not one: the weights (by hash, and loading refuses a
mismatch), the tokenizer (implemented in-tree rather than taken from a
dependency that could change under a caret range), and the runtime.

Without the model GitLit still runs and still scores — lexically — and says
which scorer produced the number. It does not quietly return a weaker answer
in the same shape as a stronger one.

## The Provenance Diff Viewer

Three readings of the same history, at `/<owner>/<slug>/compare`.

**Plan vs. prose** (§9.1) compares a chapter against the beats planned for it
and classifies each paragraph: `faithful`, `developed`, `departed`, or
`unplanned` — plus `abandoned` for beats nothing realised. The headline
**divergence** figure is the share of prose, by word count, that left the plan
or was never in it.

Two deliberate departures from the architecture sketch, both because the
sketch would have produced misleading numbers:

- **Not a one-to-one assignment.** The sketch proposed Hungarian matching.
  Prose does not map to an outline one-for-one — a single beat is often
  realised across three paragraphs — and a bijection would mark two of them
  `unplanned`, inflating divergence with an artefact of the matching rather
  than of the writing. Each side takes its best partner independently.
- **Expansion is scored separately from retention.** Containment asks how much
  of the *beat* survives, so a beat quoted verbatim plus three added sentences
  still scores ~1.0. Without a length signal, `developed` could essentially
  never fire for the most common way an author grows an outline.

**Who wrote what** (§9.2) renders the chapter as continuous prose, underlined
by what GitLit observed. `imported` and `unknown` get a dotted rule rather
than being folded into "written here".

**Revisions** (§9.3) is commit-to-commit at sentence level, with word-level
detail inside a changed sentence and moves reported as moves.

All of it is deterministic and local (§2.7) — declared links and lexical
overlap only, so the numbers reproduce offline from a clone.

## Backups

```bash
REPO_ROOT=./repos BACKUP_DIR=/mnt/backups pnpm --filter @gitlit/gitd backup
```

Every repository is bundled with `git bundle --all`, and each bundle is
verified before it counts — a bundle that cannot restore is not a backup, and
that is only discoverable in advance. Stale bundles are pruned **only after a
clean run**, because deleting old copies on the strength of a partly failed
run is how one bad night becomes permanent loss.

A corrupt repository is reported as **failed**, never as empty. Collapsing
those would quietly drop a damaged book from the backup set while the run
still looked clean.

Restore, which the same module owns because a backup nobody has restored is a
hypothesis:

```bash
pnpm --filter @gitlit/gitd backup -- --restore /mnt/backups/<id>.bundle /repos/ab/cd/<id>.git
```

**Public keys are committed into each repository** at `.gitlit/keys/<id>.pub`.
This is what makes §7.4's offline verification real: without it a clone
carries a receipt chain it has no way to check, and the verifier would have to
ask our servers for the key — the exact dependency receipts exist to remove.
It also means losing the volume stops new receipts but never invalidates
existing ones.

Verified by rehearsal, not assumed: a book is written, the volume is deleted
entirely, the bundle is restored, and the chain verifies 4/4 using only what
the restored repository contains.

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
to their manuscript.

**The link renders on GET and signs you in on POST.** Corporate mail gateways
and link-preview bots fetch every URL in an inbound message before the reader
ever sees it. A magic link that signs you in on GET is spent by the scanner,
and the author is told their link is invalid — every time, with no way to tell
why. So the emailed URL lands on `/signin`, which renders and takes the token
out of the address bar; the click is what posts it. One extra tap, and the link
survives being prefetched.

**The browser origin is an allowlist, and credentials are allowed.** These are
one decision, not two. The web app sends every request with
`credentials: "include"`, so the API must answer
`Access-Control-Allow-Credentials: true` or the browser discards the response
and the dashboard never loads. But once credentials are allowed, reflecting
whatever `Origin` asked becomes an account-takeover primitive: any page an
author visits could call the API as them and read their manuscripts. So
production allows `PUBLIC_WEB_URL` (plus `EXTRA_CORS_ORIGINS`) and nothing
else, and the API refuses to start with neither set. Getting one of these
right and not the other is worse than getting both wrong — which is how it
was: credentials were off and every origin was reflected, so the dashboard
could not load at all. Caught by driving a real browser at the API; no amount
of `curl` shows it.

**Mail is a startup requirement, not a per-request one.** The API refuses to
start in production without `RESEND_API_KEY` and a `MAIL_FROM` on a verified
domain. Without that guard the server looks healthy, accepts sign-ups, answers
"a link is on its way", and sends nothing — and the only person who finds out
is the author who cannot get in. In development, with no key set, the message
is printed in full to the API log, so a developer with no mail provider can
still complete a real sign-in by reading the link out of their terminal.

If a send fails, the API returns 502 and says so rather than claiming a link
was sent. That leaks nothing: whether Resend is reachable does not depend on
who asked, so the failure says nothing about whether the address has an
account — and an author told plainly that sending failed will try again, where
one told "a link is on its way" waits for a message that is never coming.

GitHub and Google sign-in are available when configured; an unconfigured
provider is simply absent from the page rather than a button that fails.

**GitLit asks a provider who you are and nothing else.** Scopes are
`read:user user:email` and `openid email profile` — never `repo`. No provider
access or refresh token is stored: GitLit never calls GitHub or Google on an
author's behalf, so holding long-lived third-party credentials would be a
breach liability kept for no purpose.

**An unverified provider email never reaches an existing account.** Anyone can
set their GitHub address to someone else's; if that were enough to link,
"Sign in with GitHub" would be an account-takeover primitive against every
user who ever signed up by email. The rules, in order: a provider identity
already linked signs in as that user; a signed-in author may attach a provider
to their own account; a *verified* address links to or creates the user with
that address; an unverified or absent address is refused, with the reason and
the remedy.

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

Then add `http://localhost:4002/mcp` as a connector in Claude's settings, with
your GitLit API token as the bearer credential.

**Claude Code:**

```bash
GITLIT_API_TOKEN=glt_... claude mcp add gitlit -- node /path/to/GitLit/apps/mcp/dist/stdio.js
```

Both need a token you mint in GitLit with the `agent:research` and `repo:read`
scopes. The MCP server goes through the API, never directly to gitd, so every
agent call passes the same permission checks a browser request does.

**The HTTP server holds no credential of its own.** It reads the bearer token
off each request, resolves it against the API, and makes every downstream call
with *that* token. One shared server-side token would authenticate an author at
the door and then act on their behalf with the operator's permissions — a
confused deputy, not an authorization system. An unknown or revoked token gets
401; a token without `agent:research` gets 403; and an MCP session id can only
be resumed by the user who opened it. The stdio server checks the same things
once at startup and exits with an explanation rather than failing later, mid-tool-call.

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

## Deploying

One Dockerfile, four images; `--target` picks the service, so the install and
build stages are shared and the images cannot drift apart.

```bash
docker compose up --build     # the whole stack, locally
```

**Deploying it for real is [`DEPLOY.md`](./DEPLOY.md)** — written for a
non-engineer, covering the domain, mail verification, secrets, what to check
afterwards, and the three failures that look like success.

That is also the cheapest pre-flight: if compose comes up green from empty
volumes, the images and the release order are right.

```bash
fly deploy -c apps/gitd/fly.toml    # deploy gitd first; the others call it
fly deploy -c apps/api/fly.toml
fly deploy -c apps/web/fly.toml
fly deploy -c apps/mcp/fly.toml
```

**Migrations run as a release command**, on a temporary machine, before any
new machine takes traffic — `node /migrate/dist/migrate-cli.js`, using the
migrator built into drizzle-orm rather than `drizzle-kit`, which is a
devDependency and has no business in a production image. A failed migration
aborts the deploy. Because it runs *before* the rollout, a migration must be
compatible with the image still serving: add a column, deploy, then write to
it; never drop one in the release that stops using it.

**`gitd` is not horizontally scalable, and this is the one thing to get right.**
It holds every manuscript on an attached volume, and a Fly volume belongs to
exactly one machine. A second machine gets a second, empty volume: clones
would succeed or 404 depending on which machine answered, pushes would land on
one copy of a book, and nothing would log an error. Scale it *up* — bigger VM,
bigger volume — never out. `apps/gitd/fly.toml` pins it to one always-on
machine.

Three services refuse to start in production rather than come up green and
broken: the API without `RESEND_API_KEY` (nobody could sign in), `gitd`
without `GITD_SERVICE_TOKEN` (anyone reaching it could commit as anyone) and
without `GITLIT_API_URL` (every clone 500s while `/health` stays green).

**What the rehearsal actually proved.** The stack was built and run here, not
just written: all four images build, compose comes up from empty volumes, the
migration applies from inside the image, and a full path runs through the
containers — sign in, create a repository, commit a chapter, `git clone` it
over smart HTTP, and verify the receipt chain offline from that clone with
nothing but what the clone contains. Two bugs came out of it that no unit test
would have found; both are described in `NEXT.md` §2.4. What has *not* been
rehearsed is Fly itself: the `fly.toml` files are unapplied, so treat app
names, regions and volume sizes as a starting point.

## Rate limiting and error monitoring

**Two limits, because they stop different things.** Per IP, a script hammering
the API from one place. Per email address, a botnet asking for sign-in links
to *one victim's inbox* — every request from a different host, so the per-IP
limit never fires, and the victim is mail-bombed on GitLit's sending
reputation. The second is the one an IP limit cannot cover, and it is why the
magic-link route has a limit of its own. The 429 is identical whether or not
the address has an account, so it stays useless for enumeration.

**Two paths are never limited**, and both would fail quietly if they were.
`/health` is polled by the platform every few seconds, so limiting it takes
the service out of rotation. `/v1/internal/git-access` is called by gitd once
per Git transport request, all from one internal address — a limit there does
not slow an attacker down, it breaks `git clone` for every author at once. A
rehearsal ran 20 consecutive clones through the live stack: 80 authorization
callbacks, none refused.

**`TRUST_PROXY_HOPS` decides what `req.ip` is**, and the limiter is keyed on
it, so both wrong answers are bad in opposite directions. Too low and every
request carries the edge proxy's address: one bucket for the whole platform,
and one busy author limits everyone. Too high (or `true`) and a client puts
whatever it likes in `X-Forwarded-For` and gets a fresh bucket per request,
which is no limit at all. Fly puts exactly one proxy in front, hence the
default of 1; compose puts none, hence 0.

**Monitoring is off without `SENTRY_DSN`, and silent about it** — a stack that
refuses to run without an error tracker has made the tracker a dependency of
the product. Only 5xx is reported: a 4xx is a normal outcome, and paging on
those trains everyone to ignore the alerts that matter.

**What may never leave the process.** An error tracker is a pipe to a third
party that runs on the unhappy path, where payloads are largest and least
expected — and here the payloads are manuscripts and sign-in links. So the
scrubbing is a deny-by-default filter over the whole event rather than a list
of fields someone remembered: credentials by shape, addresses, auth headers,
and any key holding prose, a diff or computed spans. The `user` block, cookies
and the request body are dropped outright rather than scrubbed, because
neither is worth the risk of one missed pattern.

Two things were found by driving the real SDK at a local ingest endpoint
rather than by testing the scrubber. Sentry attaches the **deployed source**
around every stack frame (`pre_context` / `context_line` / `post_context`), so
text near a throw left the process no matter what the scrubber knew about —
the fix is not to send it, and `ContextLines` is now filtered out. Local
variables are explicitly off too: a frame in the commit path has the chapter
in scope. `packages/observability/src/wire.test.ts` asserts all of this
against a real endpoint so it stays true.

## Known gaps — read this before trusting the build

These are staging, not surprises. What is *not* on this list is real and tested.

| Gap | Consequence today | Blocks |
|---|---|---|
| **MCP auth is a GitLit API token, not §12.8's OAuth 2.1 flow.** | Per-user and enforced, but an author pastes a token rather than clicking through a consent screen. | A one-click connector. |
| **Composer is a `<textarea>`**, not TipTap. | No rich text. The input provenance model is real and wired. | Editing comfort. |
| **Rate limits are per machine, not shared.** | In-memory counters, so N API machines means N times the limit. Fine at one machine; wrong the moment you scale out. | Scaling the API past one machine. |
| **Fly itself is unrehearsed.** | The images and compose are verified by building and running them; the `fly.toml` files have never been applied. | Treating app names, regions and volume sizes as tested. |

Signing keys are **not** on this list any more: they persist per repo, survive
restarts, are wrapped with AES-256-GCM, and gitd refuses to start in production
without `SIGNING_MASTER_KEY` rather than leave them in plaintext on the volume —
or regenerate a key and orphan an existing receipt chain.

## What is deliberately absent

- **SSH transport** (§12.7). Smart HTTP is live and `git clone`/`git push` work
  over it; SSH is not wired.
- **OAuth 2.1 for MCP** (§12.8), with dynamic client registration and a consent
  screen. The transport authenticates and authorizes per user today — see
  "Connecting from Claude" — but by API token rather than that flow.
- **TipTap.** The composer is an instrumented `<textarea>`; the input provenance
  model is real, the rich-text layer is Phase 2.5.
- **Publisher verification links** (§12.6) and the public gallery (§16.3),
  which are Phases 7–8 and the reason the trust layer exists at all.
- **Import/export.** `.docx` in, `.docx`/`.epub` out. Imported manuscripts are
  labelled `imported` (§16 decision 4) and the plumbing for the label exists.
