# Security notes

What has been probed, what was fixed, and — as honestly as possible — what is
still weak. Written after an adversarial read of the whole system, not a
checklist run.

## The threat that matters most

GitLit's product claim is provenance: that a manuscript's history shows where
text came from, and that a clone can be checked offline. The attacker to fear
is therefore not someone stealing a book — it is **an author passing AI-written
text off as their own**, because that defeats the one thing the platform sells.
Every finding below is weighed against that.

## Found and fixed

### Authors could forge the provenance record (critical, fixed)

The document-write route did no path validation, and the commit path's only
check rejected traversal and absolute paths — not writes into `.gitlit/`, the
tree that holds the signed receipt chain, the verifying keys, and the
per-file human/AI span labels.

Proven by exploit against a running stack: an ordinary author could

- overwrite `.gitlit/provenance/<file>.jsonl` to relabel machine text as human;
- write `.gitlit/keys/<anything>.pub`, planting a key the verifier then trusts;
- and a clone of the result **verified as `valid: true`**, because
  verification trusts every key it finds in the tree.

An `agent:research` token could do the same through the architecture route,
whose allowlist explicitly permitted all of `.gitlit/`.

**Fix.** `.gitlit/receipts/`, `.gitlit/keys/` and `.gitlit/provenance/` are now
*reserved*: written only by the commit path's own generation, never from a
caller's changes. Enforced at three layers — the author route
(`assertAuthorWritable`), the agent route (`assertAgentWritable`, which still
allows `.gitlit/research/` and `.gitlit/sessions/`), and the commit path itself
(`assertNotReserved`), which is the single chokepoint every write funnels
through so no future route can forget. Re-running the exploit now returns 400
at each write; legitimate prose and agent research still succeed.
Regression tests: `packages/core/src/reserved.test.ts`.

### The internal authorization endpoint was open and leaked paths (high, fixed)

`/v1/internal/git-access` — meant to be called only by gitd, with the service
token — checked nothing. Anonymous callers got a 200 that

- confirmed whether a private repository existed (`anonymous` vs `not_found`,
  an enumeration oracle), and
- returned the repository's **absolute path on the server's disk**.

gitd already sent the service token and used only the repo id. **Fix:** require
the token (constant-time compare), and drop `storagePath` from the response
entirely. Tests in `apps/api/src/access.test.ts`.

### OAuth: audience unchecked, and no browser binding (medium, fixed)

OAuth was the sharpest area to probe, so it got the closest read. The identity
rule is sound — an unverified provider email never reaches an existing account,
GitHub's verified address comes from `/user/emails` (not the spoofable `/user`
primary), state is single-use, provider-bound and expiring, PKCE and the OIDC
nonce are present, and `returnTo` is confined to a same-origin path (fuzzed
with ~20 open-redirect payloads — none escaped, which matters because the
callback appends the session token to that redirect). Two real gaps under it:

- **Google's id_token had no `aud` (audience) check.** OIDC Core §3.1.3.7 makes
  this a MUST. A valid Google token — real verified email, correct issuer —
  minted for *any other* Google application would have been accepted here and
  signed its holder in as that email's owner. Compensated in practice by the
  server-side code exchange and the nonce, but that is a fragile backstop for
  an auth path. Now the `aud` must contain our client_id, and `azp`, when
  present, must equal it.

- **OAuth state was not bound to the initiating browser** — login-CSRF. An
  attacker completes a flow for their own provider account, hands the victim
  the resulting callback URL, and the victim's browser signs in *as the
  attacker*; the victim then writes their next chapter into an account the
  attacker owns and can read. Now `begin` sets a one-time `SameSite=Lax`
  cookie holding the state, and the callback refuses any state that does not
  match it — a callback opened in a different browser has no matching cookie.

Regression tests: `packages/auth/src/oauth.test.ts` (aud/azp),
`apps/api/src/oauth-csrf.test.ts` (browser binding).

### Operator secrets and provider-token hijack (hardened)

The concern here is different from losing a manuscript: the *operator's* keys
leaking, and a user's Google/GitHub identity being hijacked through GitLit.
Probed each path a secret could take out of the system.

What was already right, and verified:

- **No provider tokens are stored.** The `accounts` table holds a provider id,
  the account id, the linked email and a verified flag — never an access or
  refresh token. So a stolen database yields nothing an attacker can use to act
  as a user on Google or GitHub. This is the main answer to "their OAuth gets
  hijacked."
- **No secret ships to the browser.** Nothing is prefixed `NEXT_PUBLIC_` but a
  URL; the client bundle carries no key.
- **No secret is returned by an endpoint.** `/v1/auth/providers` returns names
  only; the operator surface returns booleans; the 500 handler never echoes an
  error to the client; the OAuth token-exchange error surfaces the *provider's*
  message, not our request (which holds the client secret).

Two gaps closed:

- **A secret could have reached the logs.** A Postgres connection error carries
  the whole `DATABASE_URL` — password and all — and on a deployed box the log
  stream is a shared third-party store. Every log line from the API and gitd
  now passes through a scrubber at the stream that removes the literal value of
  every operator secret (`DATABASE_URL`, `SIGNING_MASTER_KEY`, the provider
  secrets, tokens…) plus any connection-URL password, by identity, whatever
  wrote it. The first attempt used a pino `formatters.log` hook and **failed a
  live test** — that hook is handed only the structured fields, so a secret in
  an error *message* passed straight through. The scrubber was moved to the
  stream, where the finished line cannot bypass it, and re-proven against a
  real Fastify logger across five leak paths.
- **The session token rode in a URL with no Referrer-Policy.** The token is
  handed to the SPA in the callback URL (the cross-origin cookie is not
  readable by the app's fetches). There were no security headers, so the day
  anyone added a Google Font or an avatar image, that URL — token included —
  would have leaked to the third party in a `Referer`. The web app now sends
  `Referrer-Policy: no-referrer`, a `Content-Security-Policy` confining
  `connect-src` to GitLit's own origins (so injected script cannot exfiltrate
  the token either), `frame-ancestors 'none'`, `nosniff` and HSTS. Verified in
  a real browser against the production build: headers present, no CSP
  violations, the app still hydrates.

Regression tests: `packages/observability/src/redact.test.ts`. Live proofs
(log scrubbing, CSP) run in the security pass, not committed.

## Held up under probing

- **Cross-account access (IDOR).** A signed-in stranger, and an anonymous
  caller, both get `404` — not `403` — for a private repo's metadata,
  documents, and provenance. Existence is treated as sensitive. Authoring
  sessions check `session.userId` on read and close.
- **Every route is guarded.** Only `/health`, the login flow (`/v1/auth/*`,
  rate-limited) and the provider *name* list are public; everything else
  requires a user, repo access, the operator token, or the service token.
- **CORS** allows exactly `PUBLIC_WEB_URL` with credentials, and refuses a
  stranger origin (verified in a real browser earlier in the build).
- **The MCP server** carries no identity of its own; every downstream call
  uses the caller's token.

## Known-weak, and why it is not yet closed

**Offline verification has no trust anchor.** After the fix above, a running
GitLit server will not let anyone forge the record. But `verifyRepository`
checks only that the receipt chain is internally consistent and signed by a key
present in the clone. An attacker who takes a clone *offline*, adds their own
key to `.gitlit/keys/`, and rebuilds the whole chain signed with it, produces a
clone that still verifies — because nothing anchors "which key is the real one"
outside the repository, and the signed span-digest is never re-derived from the
sidecars and compared.

This is inherent to offline verification without a published root of trust, and
it is what the architecture's **publisher verification links** (§12.6, Phase 7)
are for: the authoritative receipt ids live server-side, so a verifier checks
the clone *against the registry* rather than against itself. Until that ships,
the honest framing — already the architecture's stated position (§3) — is that
provenance here is **evidence, not proof**: it makes tampering with a genuine
history evident, and it does not stop someone manufacturing a false history
from scratch. Do not describe a green `verifyRepository` as "verified human."

Two smaller items live with it:

- `verifyRepository` does not re-derive the span digest from the on-disk
  sidecars and compare it to the signed receipt. Doing so would catch casual
  sidecar tampering in a clone even before the registry exists; it is left out
  rather than half-implemented, because a digest computed differently from the
  commit path would fail legitimate clones.
- Rate limits are per-machine (in-memory), so they multiply if the API is
  scaled past one machine. Fine at one; see the deploy notes.

## Running the checks

```bash
pnpm scan:secrets          # credentials in history / working tree
pnpm preflight <api-url>   # live deployment: config, keys, backups, CORS, one-gitd
pnpm -r test               # includes the exploit regression tests above
```
