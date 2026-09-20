# Where GitLit stands, and what comes next

**Written:** 2026-09-20, end of the build session.
**Read this first if you are picking the project up cold.**

Architecture and rationale: [`system_architecture.md`](./system_architecture.md).
How to run it and what each package does: [`README.md`](./README.md).

---

## 1. State

594 tests across 12 packages. `pnpm typecheck` clean across 20 tasks.

The product works end to end and has been driven against live services, not
just asserted in tests:

- Repositories are real bare Git repos; `git clone` and `git push` work over
  smart HTTP, and a `pre-receive` hook refuses pushes that forge provenance.
- Provenance spans, the signed receipt chain, and tamper detection survive a
  service restart (verified by killing `gitd` mid-history).
- Authorization is enforced on every route, including the Git transport, and
  verified live: a stranger gets 404, a read-only token cannot push.
- Postgres is wired and tested against real Postgres in-process (PGlite).
- All three Provenance Diff Viewer modes work on live data.
- The MCP server runs the full research flow with a real client.
- Semantic novelty scoring runs on a pinned, bit-reproducible local model.

**The product works, and it deploys.** Backups, email sign-in, per-user MCP
auth and deploy config are done. What is left is §2.5: rate limiting and error
monitoring.

---

## 2. Blockers before anyone else can use it

In severity order. Each names the file and what "done" means.

### 2.1 Backups — DONE

`apps/gitd/src/backup.ts`, with `backup-cli.js` for cron. Bundles are verified
before they count, pruning happens only after a clean run, and a corrupt
repository is reported as failed rather than empty.

Rehearsed rather than assumed: a book was written, the volume deleted
entirely, the bundle restored, and the chain verified 4/4 from the restored
repository alone.

**The rehearsal found a flaw that had been present all along.** Signing keys
lived only in the gitdir, and public keys were never committed — so a restore
recovered the manuscript and every receipt, and could verify none of them.
Worse, the same gap meant a plain `git clone` could not verify either, which
made §2.3 and §7.4's central promise untrue in the shipped build. Public keys
now live at `.gitlit/keys/<id>.pub` inside the history.

Still worth doing: copy `BACKUP_DIR` offsite (`aws s3 sync`, rclone) — the
store is a directory precisely so that stays the operator's choice.

### 2.2 Email sign-in — **DONE**

New `packages/mail`: the sign-in email, a Resend transport over its REST API,
a console transport for development, and the factory that picks between them.

- The API **refuses to start in production** without `RESEND_API_KEY` and a
  `MAIL_FROM`. That guard is the point: a server that starts without a mail
  provider looks healthy, accepts sign-ups, answers "a link is on its way",
  and sends nothing — and the only person who finds out is the author who
  cannot get in.
- The emailed link lands on `/signin` (a GET that renders) and is consumed by
  a POST on click. Mail gateways prefetch every URL in an inbound message; a
  link that signs you in on GET is spent by the scanner before the author sees
  it. The page also strips the token out of the address bar on arrival.
- A failed send returns 502 and says so. This leaks nothing — provider
  reachability does not depend on who asked — and an author told plainly will
  retry, where one told "a link is on its way" waits for nothing.
- Departs from §4 on **React Email**: an email client is not a browser, the
  output has to be a table of inline styles whatever renders it, so the two
  templates are two functions rather than a React renderer in the API. The
  reasoning is in `packages/mail/src/layout.ts`. Revisit at a dozen templates.

**Rehearsed, not just asserted.** `ResendTransport` was driven over real HTTP
against a server speaking Resend's protocol (bearer header, `to` as an array,
`reply_to`, tags, both body parts all confirmed on the wire), and a live API
against real Postgres completed a full sign-in from the link as printed:
link → session → `/v1/me` → replay rejected 401. The send log line carries
neither the address nor the token.

**Still the operator's job:** verify the sending domain at Resend and set SPF,
DKIM and DMARC. Unverified domain means every send is rejected 403 — which
the transport surfaces verbatim rather than retrying, since it fails the same
way twice.

### 2.3 The MCP HTTP transport — **DONE**

The hole was wider than the placeholder that flagged it. `gitlit-client.ts`
read one `GITLIT_API_TOKEN` from the environment for *every* downstream call,
so fixing only the bearer check would have closed the front door and left a
confused deputy behind it: each authenticated author's agent would have acted
with the operator's permissions.

What changed:

- `gitlit-client.ts` — the global `gitlit` object and the env-token reader are
  gone. `createGitlitClient(token)` builds a per-caller client; `identify(token)`
  resolves a token against `/v1/me`. The server now has no identity of its own.
- `http.ts` — real bearer auth with a 60s identity cache (revocation still takes
  effect within the TTL), 401 with `www-authenticate` for an unknown token, 403
  when `agent:research` is absent, and `transportOwners` so a resumed
  `mcp-session-id` must belong to the same user that opened it.
- `stdio.ts` — validates the token and scope at startup, explains on stderr and
  exits non-zero rather than failing later, mid-tool-call.
- `tools.ts` — `ToolContext` carries the caller's `GitlitClient`.

**Done:** `apps/mcp/src/http.test.ts` (10 tests) covers the unknown token → 401,
two tokens → two users with separate sessions, and that no token is read from
the environment. Port 4002 is safe to expose.

### 2.4 Deploy config — **DONE**

One `Dockerfile` with four targets (api, gitd, web, mcp), a `.dockerignore`,
a full-stack `docker-compose.yml`, and a `fly.toml` per service.

- **Migrations run as a release command** on a temporary machine before any
  new machine takes traffic: `node /migrate/dist/migrate-cli.js`. New
  `packages/db/src/migrate.ts` uses drizzle-orm's own migrator rather than
  `drizzle-kit`, which is a devDependency — a production image that has to
  carry the dev toolchain to migrate is an image shipping a compiler to run a
  web server.
- **`gitd` is pinned to one always-on machine.** A Fly volume belongs to one
  machine, so a second gitd gets a second empty volume: clones would 404 or
  succeed depending on which machine answered, and nothing would log an error.
  Scale it up, never out. The warning is at the top of `apps/gitd/fly.toml`.
- `NEXT_PUBLIC_API_URL` is a **build arg**, not an env var: Next.js inlines it
  into the client bundle, so setting it at runtime leaves the browser calling
  localhost.

**Rehearsed by building and running it, which found two bugs no test would
have.** All four images build; compose comes up from empty volumes; the
migration applies from inside the image; and a full path runs through the
containers — sign in, create a repository, commit a chapter, `git clone` over
smart HTTP, verify the receipt chain offline from that clone
(`valid: true, verified 2/2`). The mail path was exercised against the real
Resend API, which rejected a deliberately bad key: 401 surfaced verbatim in
the log, 502 and a safe message to the author.

The two bugs:

1. **Every malformed request returned 500 "Internal error"** instead of 400. A
   Zod failure fell through to the generic handler, so an author who omitted a
   field was told the server was broken — and an operator's error monitoring
   (§2.5, next) would have filled with alarms nobody caused. Now 400 with the
   offending field named.
2. **`gitd` defaulted `GITLIT_API_URL` to localhost.** Deployed, that resolves
   to gitd itself, so it asks *itself* to authorize each clone: every clone
   500s while `/health` reports ok throughout. It now refuses to start in
   production without it. This is the shape worth remembering — a service that
   is green and entirely broken — and it is only findable by deploying.

**Not rehearsed:** Fly itself. The `fly.toml` files are unapplied, so app
names, regions and volume sizes are a starting point, not a tested
configuration. Postgres is assumed attached (`fly postgres create`), not
deployed by these files.

### 2.5 Lower, but real

- No rate limiting on any endpoint. `@fastify/rate-limit` on `/v1/auth/*`
  and the research endpoints at minimum.
- No error monitoring. §4 names Sentry.
- Signing keys sit unencrypted on disk unless `SIGNING_MASTER_KEY` is set.
  Set it, or the AES-256-GCM wrap in `apps/gitd/src/keystore.ts` never runs.

---

## 3. The plan

### Session 1 — make it deployable (~1 day)

Order matters: backups first, because everything after it increases the
amount that can be lost.

1. Backups + a rehearsed restore (§2.1)
2. ~~MCP HTTP auth (§2.3) — smallest fix, removes a live hole~~ **DONE**
3. ~~Email sending (§2.2)~~ **DONE**
4. ~~Deploy config (§2.4)~~ **DONE**
5. Rate limits + Sentry (§2.5)

**Then it is genuinely alpha**, and a small private test is reasonable.

### The two-hour alternative

If the test is you and two friends on throwaway chapters: register
OAuth apps, deploy without backups, and say plainly that manuscripts may be
lost. Only acceptable while nothing real is in it.

### Session 2 — the parts that make it a product

From the §15 build order, phases 7–8 remain:

- **Publisher verification links** (§12.6) and the public verifier at
  `GET /verify/:receipt_id`. This is the revenue line per §16 decision 2, and
  the reason the trust layer exists at all. Nothing implements it yet.
- **The public gallery** (§16.3) with its provenance standard — the
  enforcement mechanism that actually has teeth.
- **Import/export**: `.docx` in, `.docx`/`.epub` out. Imported manuscripts
  are labelled `imported` (§16 decision 4) and the plumbing for that exists;
  the file conversion does not.
- **The `gitlit` CLI**: `verify`, `replay`, `reindex`. §11's claim that the
  whole index can be rebuilt from Git is currently untested — `reindex` is
  the command that would prove it, and CI should run it.
- **Webhooks** (§12.9).

### Still open, needs your call

- `write.gitlit.app` as a separate front door (§16.3) — same app, different
  entrance, for authors who want the writing tool before version control.
- Whether §2.1's backups go to R2 or somewhere you already pay for.

---

## 4. Decisions already made — do not quietly undo these

A fresh session will re-derive from the architecture doc and may "fix" these
back. They are deliberate, and several are corrections *to* that doc.

| Decision | Why |
|---|---|
| **No model API key in GitLit, ever** | Authors connect from their own Claude via MCP (§2.6). Makes us a notary rather than an interested party. |
| **Plan-to-prose matching is not one-to-one** | The doc proposed Hungarian assignment. One beat is often realised across several paragraphs; a bijection marks the rest `unplanned` and inflates divergence with an artefact of the matching. |
| **Expansion is scored separately from retention** | Containment asks how much of the *beat* survives, so a beat quoted verbatim plus added prose scores ~1.0. Without a length signal, `developed` can never fire. |
| **Embeddings run under WASM, not native ONNX** | Native dispatches to platform-specific SIMD; the same weights on another CPU return different floats. WASM is bit-identical, which is what §2.7 needs. |
| **No provider access/refresh tokens stored** | GitLit never calls GitHub or Google on a user's behalf. Credentials held for no purpose are pure liability. |
| **An unverified provider email never reaches an existing account** | Otherwise "Sign in with GitHub" is an account-takeover primitive. |
| **Repos are labelled, never force-published or deleted** (§16.2) | Forced publication destroys the book's market value irreversibly and is us infringing the author's copyright. |
| **Postgres indexes; Git is the source of truth** | Except for users/sessions/tokens, which have no other source. |
| **`unknown` and `imported` are honest states** | Never fold them into "written here" in any UI. |

And the language rules, which are tested, not stylistic:

- Never "verified human", "certified", "proven", "guaranteed".
- Paste is recorded as a **fact, not a suspicion**. Dictation and IME input
  are never flagged.
- An author's note about a paste is stored as **their claim**, visually
  distinct from what was observed.

---

## 5. Commands worth running before the next session

Cheap, and they confirm the state above rather than trusting this file.

```bash
pnpm install
pnpm --filter @gitlit/embed fetch-model      # 34MB, hash-verified
pnpm build && pnpm typecheck && pnpm test    # expect 515 passing

# Drive it locally end to end:
docker compose up -d                          # or rely on the PGlite fallback
pnpm dev
```

One known flake: a single web test failed once under full-suite CPU
contention after the WASM inference tests were added. It has not reproduced
across six subsequent runs and is unfixed. If CI goes red intermittently,
look there first — `apps/web/components/Composer.test.tsx`.

---

## 6. The honest summary

The thing that works is the hard part: a provenance record that survives
restarts, travels with a `git clone`, detects tampering, refuses to let a
client assert its own authorship, and is reproducible offline down to the
embedding scores.

The thing that is missing is ordinary: backups, email, deploy config, rate
limits. A day of unglamorous work stands between a prototype that does
something genuinely novel and something an author could actually be invited
to use.

Do the backups first.
