# Putting GitLit online

Written for you, not for an engineer. Every step says what the thing *is*, why
it matters, and how to tell it worked.

Nothing here is code. The code is finished. This is accounts, names and
secrets — the parts only you can do, because they involve your money, your
domain and your identity.

Budget an afternoon. Steps 1–3 involve waiting for DNS, which is dead time you
can do other things during.

---

## The shape of it

GitLit is four programs that talk to each other:

| Program | What it is | Why it exists |
|---|---|---|
| **web** | The website authors look at | Dashboard, editor, diff viewer |
| **api** | The part that decides who may do what | Every permission check happens here, once |
| **gitd** | The part that holds the manuscripts | The only thing that touches the actual files |
| **mcp** | The doorway Claude connects through | So an author's own Claude can do the research |

Plus **Postgres**, a database. It holds accounts and an index of what exists —
never the manuscripts themselves. Those live with gitd.

The one thing worth internalising: **gitd is different from the others.** The
other three can run in as many copies as you like. gitd cannot. It holds the
books on one attached disk, and a second copy would get its own *empty* disk —
so some manuscripts would appear to vanish depending on which copy answered,
with nothing in any log to say why. Run exactly one. If it needs more power,
make it bigger; never make more of it.

---

## Step 1 — A domain

Buy one anywhere (Namecheap, Cloudflare, Porkbun). You will point three things
at it:

- `gitlit.app` → the website
- `api.gitlit.app` → the api
- email sent *from* `gitlit.app`

Substitute your real domain everywhere below.

---

## Step 2 — Email that arrives

Sign-in is a link emailed to the author. There is no password anywhere in
GitLit, so **if email does not work, nobody can get in at all.**

1. Make an account at [resend.com](https://resend.com). The free tier is
   plenty to start.
2. Add your domain and add the DNS records they give you.
3. Wait for it to say **Verified**. This can take up to an hour.
4. Create an API key and keep it safe. It looks like `re_...`.

**Why this matters more than it looks.** Those DNS records are SPF, DKIM and
DMARC — how a receiving mail server checks that mail claiming to be from your
domain really is. Without them, sign-in emails land in spam, which looks
exactly like the site being broken: the author never gets in and has no idea
why.

**How you know it worked:** Resend's dashboard says Verified, green ticks next
to each record.

---

## Step 3 — Sign in with Google and GitHub (optional)

An author can always use email. This just adds the buttons.

- **GitHub:** Settings → Developer settings → OAuth Apps → New.
  Callback URL: `https://api.gitlit.app/v1/auth/oauth/github/callback`
- **Google:** Cloud Console → Credentials → OAuth client ID.
  Redirect URI: `https://api.gitlit.app/v1/auth/oauth/google/callback`

Each gives you an ID and a secret.

**The callback URL must match exactly** — same scheme, same domain, no
trailing slash. A mismatch produces an error page from Google or GitHub rather
than from GitLit, which makes it confusing to chase.

GitLit asks these services only who you are. It never asks for access to your
repositories or files, and stores nothing that would let it act as you later.

---

## Step 4 — The secrets

Install the Fly CLI (`flyctl`), then `fly auth signup`.

**Create the four apps first.** `fly secrets set` needs an app to set secrets
*on*, so this has to come before the secrets, not after:

```
fly apps create gitlit-api
fly apps create gitlit-gitd
fly apps create gitlit-web
fly apps create gitlit-mcp
```

This makes the apps without deploying anything. If a name is taken, pick
another and use it consistently from here on — including in the `fly.toml`
files in step 5.

Create the database:

```
fly postgres create --name gitlit-db
```

Write down the connection string when it prints — it shows it once.

Now generate two secrets. Run this twice and keep both:

```
openssl rand -base64 32
```

| Secret | What it protects | What happens without it |
|---|---|---|
| `GITD_SERVICE_TOKEN` | The password api uses to talk to gitd | Anyone reaching gitd could write commits as any author |
| `SIGNING_MASTER_KEY` | Encrypts the keys that sign provenance receipts | Those keys sit readable on the disk — and disks get snapshotted, backed up and copied |

**Never lose `SIGNING_MASTER_KEY`.** Losing it means existing receipts can no
longer be unlocked, which breaks the provenance history GitLit exists to keep.
Put it in a password manager today, before you deploy.

### What actually happens when you set one

The value goes to Fly's API, which **can encrypt but cannot decrypt**, and is
stored in an encrypted vault. When a machine boots, Fly issues it a temporary
token, decrypts that app's secrets, and injects them as environment variables
into the running process. They never touch your repository, your image, or
your `fly.toml`.

Three consequences worth knowing before you start:

- **You can never read a secret back.** `fly secrets list` shows the name, a
  digest and when it was set — never the value. Fly does not allow read access
  to the plaintext, by design. So the password-manager advice above is not
  belt-and-braces: **if you lose `SIGNING_MASTER_KEY`, it is gone**, and with
  it every existing provenance receipt.
- **Setting a secret restarts the machines.** Fine now, since nothing is
  running. Later, `--stage` defers the restart until the next deploy.
- **Secrets are per app.** `gitlit-api` and `gitlit-gitd` each need their own,
  which is why `GITD_SERVICE_TOKEN` appears twice below.

### Setting them without leaving them in your shell history

`fly secrets set KEY="value"` puts the value in your terminal's saved history,
where it stays in a plain file on your machine. `fly secrets import` reads
`NAME=VALUE` lines from standard input instead, so nothing is ever typed as an
argument:

```
fly secrets import -a gitlit-api --stage <<'EOF'
DATABASE_URL=postgres://...
GITD_SERVICE_TOKEN=...
RESEND_API_KEY=re_...
MAIL_FROM=GitLit <hello@gitlit.app>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OPERATOR_TOKEN=...
EOF

fly secrets import -a gitlit-gitd --stage <<'EOF'
GITD_SERVICE_TOKEN=...
SIGNING_MASTER_KEY=...
OPERATOR_TOKEN=...
EOF
```

Type it exactly as shown. The `<<'EOF'` part means "everything until the next
line that says `EOF` is input" — paste your values in place of the `...`, then
`EOF` on its own line. No quotes around the values, and no spaces around the
`=`. The quotes around `'EOF'` matter: they stop the shell interpreting
anything in your values.

`--stage` means "store these, apply at next deploy" — which is what you want,
since nothing is deployed yet.

`GITD_SERVICE_TOKEN` must be **the same value in both**. It is a shared
password between two programs; if they disagree, every save fails. Same for
`OPERATOR_TOKEN`, which is what lets `pnpm preflight` check them in step 7.

Check they landed — this shows names only, never values:

```
fly secrets list -a gitlit-api
fly secrets list -a gitlit-gitd
```

---

## Step 5 — Edit the config files

Two files name a domain that is currently a placeholder. Replace `gitlit.app`
with yours:

- `apps/api/fly.toml` — `PUBLIC_API_URL`, `PUBLIC_WEB_URL`
- `apps/web/fly.toml` — `NEXT_PUBLIC_API_URL`

**If any app name was taken in step 4**, you also need to change it in three
places, or the services will look for each other under the wrong names:

- the `app = "..."` line at the top of that service's `fly.toml`
- `GITD_URL` in `apps/api/fly.toml` (`http://<gitd-app-name>.internal:4001`)
- `GITLIT_API_URL` in `apps/gitd/fly.toml` and `apps/mcp/fly.toml`
  (`http://<api-app-name>.internal:4000`)

Those `.internal` addresses are Fly's private network: they resolve by app
name, inside your organisation only, and never leave it.

`PUBLIC_WEB_URL` is load-bearing twice over. It is the address sign-in links
point at, **and** it is the only website allowed to talk to the api from a
browser. Get it wrong and either the links go nowhere or the dashboard will
not load.

---

## Step 6 — Deploy

Order matters. gitd first, because the others call it.

```
fly deploy -c apps/gitd/fly.toml
fly deploy -c apps/api/fly.toml
fly deploy -c apps/web/fly.toml
fly deploy -c apps/mcp/fly.toml
```

Then point your DNS at the web and api apps — `fly certs create` tells you
exactly which records to add.

**Expect the first attempt to need adjusting.** These files have never been
run against the real Fly. App names may be taken; regions may not suit you.
That is normal — read the error and change the file.

---

## Step 7 — Run the checker

Most of what can go wrong, a command can find for you:

```
pnpm preflight https://api.gitlit.app \
  --web https://gitlit.app \
  --token "$OPERATOR_TOKEN" \
  --email you@yourdomain.com \
  --html report.html
```

It prints a list you can read, writes a page you can keep, and exits non-zero
if something failed. It changes nothing, except sending one sign-in email to
the address you give it.

The settings, signing-key and backup checks need `OPERATOR_TOKEN`, which you
set on both apps back in step 4. Without it those checks are skipped, not
opened to anyone.

**What it can tell you:** whether the site is reachable over https; whether a
stranger website is refused; whether your dashboard is allowed to talk to the
API; whether sign-in is rate limited; whether sign-in tokens are leaking into
replies; whether exactly one gitd is running; whether the gitd password is
still the published example; whether mail is configured and sending from a
domain that relates to your site; whether the database is up to date; whether
the signing keys on the volume are encrypted; and whether the newest backup
**actually opens and restores**.

**What it will not pretend to know.** Two answers live outside the machine,
and it marks them "go and look" rather than passing them:

- whether the sign-in email *arrived* — only your inbox can say
- whether backups exist anywhere but that one disk — only you can say

A checker that guessed at either would be exactly the kind of green light this
whole page exists to distrust.

## Step 8 — Check the parts a machine cannot

Do all six by hand. Each fails in a different way, and several fail *silently*.

1. **Visit the site.** It should load over `https://`.
2. **Ask for a sign-in link with your own email.** It should arrive within a
   minute. If not, check Resend's dashboard — it logs every attempt and says
   why one failed.
3. **Click the link.** You should land on a page with a button, and be signed
   in after clicking it. That extra click is deliberate: company mail scanners
   open every link in an email before you see it, and a link that signed you
   in just by being opened would already be used up by the time you clicked.
4. **Create a book and write a sentence.** It should save.
5. **Clone it.** Mint a token in GitLit → Settings → Tokens, then:
   `git clone https://x:YOUR_TOKEN@api.gitlit.app/you/your-book.git`
   You should get a folder containing your sentence. This is the whole promise
   of the product — the manuscript is yours and leaves with you.
6. **Sign in from a second browser** (or a private window) and confirm you
   cannot see a book belonging to someone else.

---

## Security: what to check, in plain terms

These are the things that are wrong in a way you would not notice.

### Before you let anyone else in

Run `pnpm preflight` first — it covers most of this list automatically. These
are the ones it cannot check, or that matter enough to confirm by eye.

- [ ] **`SIGNING_MASTER_KEY` is in a password manager.** Not a note, not a
      terminal you will close. Losing it costs the provenance history.
- [ ] **`GITD_SERVICE_TOKEN` is a generated random string**, not
      `dev-service-token-change-me` from the example file. That value is in
      the public repository.
- [ ] **No secrets are in git.** Run `pnpm scan:secrets`. It searches every
      commit in the whole history, plus files you have not committed yet, and
      knows to leave the published local-development database alone. If it
      finds something, **rotate that secret** — issue a new one and revoke the
      old one. Do not just delete the line: once pushed, the old commit is on
      other machines and in GitHub's caches, so removing it does not
      un-publish it.
- [ ] **`PUBLIC_WEB_URL` is exactly your site.** This is the list of websites
      allowed to talk to the api as a signed-in author. Wrong, and either the
      dashboard breaks or — worse — another site could read manuscripts on a
      visitor's behalf.
- [ ] **`NODE_ENV=production` is set on api and gitd.** It is in the fly.toml
      files already; confirm it survived your edits. Outside production the
      api hands the sign-in token straight back in its reply — convenient
      locally, an open door in public.
- [ ] **Visit `https://api.gitlit.app/health`.** It should say `ok`. If it
      says `"monitoring": false` and you set up Sentry, the DSN did not take.

### Where the secrets actually live

Worth being clear about, because it is the thing people most often get wrong.

**No key or password is in the code.** Every one is read from the environment
at startup — `process.env.RESEND_API_KEY` and so on — and the values come from
`fly secrets set`, which stores them encrypted at Fly and injects them into the
running machine. They are never in a file, never in the repository, and never
in a build.

The one file that *looks* like secrets is `.env.example`. It is a template of
the names, with obviously-fake values like `dev-service-token-change-me`. That
is exactly why `pnpm preflight` checks whether you are still using that value:
it is published, so anyone can read it.

Two places a secret can still escape, both on your side:

- **Your terminal history**, if you use `fly secrets set` rather than the
  `fly secrets import` form in step 4. `set` puts the value in your shell's
  saved history as a plain file; `import` reads it from input and never does.
- **A file you create yourself.** `.gitignore` covers `.env`, `.env.*`,
  `repos/`, `backups/`, `*.pem` and `*.key`, so the obvious names are safe.
  `pnpm scan:secrets` is the backstop for the ones nobody anticipated.

`backups/` matters more than it looks: a backup holds both a copy of someone's
manuscript and a copy of that repository's signing key, so committing one would
publish both.

### Three failures that look like success

The service looks perfectly healthy while being broken:

1. **gitd running as more than one machine.** Books vanish and reappear
   depending on which one answers. `pnpm preflight` catches this by asking
   repeatedly and noticing two different machines reply; `fly status -a
   gitlit-gitd` must also show exactly one. Never run `fly scale count` above
   1 on gitd.
2. **Email sending domain unverified.** The site accepts sign-ups and says "a
   link is on its way" while Resend rejects every one. GitLit refuses to start
   without a mail key for exactly this reason, but it cannot tell whether your
   *domain* is verified. Only the test in step 7 tells you.
3. **Backups never actually copied off the machine.** GitLit bundles every
   repository on a schedule, but writes them to the same disk the books are
   on. One disk failure takes both. Copy them elsewhere (`aws s3 sync`,
   rclone, anything). `pnpm preflight` opens and verifies the newest backup
   every time it runs, so "a backup you have never restored" is handled — but
   it cannot see whether a copy exists anywhere else, and says so.

### What is deliberately *not* protected

So you are not surprised, and so you can say it plainly to your first authors:

- **Anyone with a sign-in link can sign in.** That is what passwordless means:
  it moves the security to the author's email account. Slack and Notion make
  the same trade.
- **A collaborator you add can read the whole book.** There is no
  chapter-level permission.
- **GitLit can read manuscripts.** It is not end-to-end encrypted. The
  provenance claim is about *where text came from*, not about hiding it from
  the people running the service.

### Not yet true, worth knowing before you grow

- **Rate limits are counted per machine.** If you ever run the api as more
  than one machine, the limits multiply. Fine at one; revisit before scaling.
- **The Fly configuration has never been run.** Everything else here has been
  built and driven end to end, including a real `git clone` out of a running
  container. Fly itself is the one untested link.

---

## If something breaks

```
fly logs -a gitlit-api      # or gitlit-gitd, gitlit-web, gitlit-mcp
fly status -a gitlit-gitd   # must be exactly one machine
fly ssh console -a gitlit-gitd
```

GitLit refuses to start rather than run in a dangerous half-state, so a
container that will not boot is usually telling you exactly what is missing.
Read the first error in the log — it is written to be read by a person.
