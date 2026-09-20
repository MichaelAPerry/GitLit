# Where GitLit stands, and what comes next

**Written:** 2026-09-20, end of the build session.
**Read this first if you are picking the project up cold.**

Architecture and rationale: [`system_architecture.md`](./system_architecture.md).
How to run it and what each package does: [`README.md`](./README.md).

---

## 1. State

515 tests across 10 packages. `pnpm typecheck` clean across 18 tasks.

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

**The product works. The operations do not exist.** That is the whole gap.

---

## 2. Blockers before anyone else can use it

In severity order. Each names the file and what "done" means.

### 2.1 No backups — do not skip this one

`gitd`'s volume is the only copy of every manuscript. §4.1 specifies nightly
`git bundle` snapshots to object storage; none of it exists.

For a product whose pitch is *your history is safe here*, shipping without
this is the one thing I would refuse. **No real author should put a real book
in GitLit until this exists and a restore has actually been run.**

- Add a bundle job to `apps/worker` (or a cron in `gitd`) walking `REPO_ROOT`.
- `git bundle create <repo>.bundle --all` per repository, upload to R2/S3.
- **Done means:** a restore from a bundle into an empty volume has been
  performed and the receipt chain still verifies afterwards.

### 2.2 Nobody can sign in

Magic links are only ever returned in the dev response
(`apps/api/src/index.ts`, `/v1/auth/magic-link` → `devToken`). No email is
sent anywhere in the codebase. In production `devToken` is undefined and the
flow dead-ends.

- Add Resend + a React Email template (§4 names both).
- OAuth is a working alternative *if* GitHub/Google apps are registered and
  `PUBLIC_API_URL` matches the callback — but email sign-up must work too.
- **Done means:** a real address receives a link and completes sign-in with
  `NODE_ENV=production`.

### 2.3 The MCP HTTP transport is wide open

`apps/mcp/src/http.ts` line ~35: any bearer token maps to a single user.
Anyone who reaches that port gets agent access as whoever
`GITLIT_API_TOKEN` belongs to. Labelled a placeholder; never closed.

- Resolve the bearer against the API (the internal endpoint pattern used by
  `gitd` in `apps/gitd/src/git-routes.ts` is the model to copy).
- **Done means:** an unknown token gets 401, and two different tokens resolve
  to two different users with separate sessions.
- **Until then, do not expose port 4002.**

### 2.4 Nothing to deploy with

No Dockerfile, no fly.toml, no volume config.

- Dockerfiles for `api`, `gitd`, `web`, `mcp`.
- `fly.toml` for `gitd` **with a persistent volume** — this is the constraint
  that rules out an all-serverless deploy (§4.1).
- A migration step (`pnpm db:migrate`) in the release process.
- **Done means:** a clean deploy from zero, and `git clone` works against it.

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
2. MCP HTTP auth (§2.3) — smallest fix, removes a live hole
3. Email sending (§2.2)
4. Deploy config (§2.4)
5. Rate limits + Sentry (§2.5)

**Then it is genuinely alpha**, and a small private test is reasonable.

### The two-hour alternative

If the test is you and two friends on throwaway chapters: fix §2.3, register
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
