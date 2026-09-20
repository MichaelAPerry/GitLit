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

Then set everything:

```
fly secrets set -a gitlit-api \
  DATABASE_URL="postgres://..." \
  GITD_SERVICE_TOKEN="..." \
  RESEND_API_KEY="re_..." \
  MAIL_FROM="GitLit <hello@gitlit.app>" \
  GITHUB_CLIENT_ID="..." GITHUB_CLIENT_SECRET="..." \
  GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..."

fly secrets set -a gitlit-gitd \
  GITD_SERVICE_TOKEN="..." \
  SIGNING_MASTER_KEY="..."
```

`GITD_SERVICE_TOKEN` must be **the same value in both**. It is a shared
password between two programs; if they disagree, every save fails.

---

## Step 5 — Edit the config files

Two files name a domain that is currently a placeholder. Replace `gitlit.app`
with yours:

- `apps/api/fly.toml` — `PUBLIC_API_URL`, `PUBLIC_WEB_URL`
- `apps/web/fly.toml` — `NEXT_PUBLIC_API_URL`

(`apps/gitd/fly.toml` and `apps/mcp/fly.toml` need no changes.)

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

## Step 7 — Check it actually works

Do all six. Each fails in a different way, and several fail *silently*.

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

- [ ] **`SIGNING_MASTER_KEY` is in a password manager.** Not a note, not a
      terminal you will close. Losing it costs the provenance history.
- [ ] **`GITD_SERVICE_TOKEN` is a generated random string**, not
      `dev-service-token-change-me` from the example file. That value is in
      the public repository.
- [ ] **No secrets are in git.** `.env` is ignored, but check:
      `git log -p | grep -iE "re_[a-z0-9]{20}|postgres://"` should find
      nothing. If it does, **rotate that secret** rather than deleting the
      commit — once pushed, assume it is public forever.
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

### Three failures that look like success

The service looks perfectly healthy while being broken:

1. **gitd running as more than one machine.** Books vanish and reappear
   depending on which one answers. Check `fly status -a gitlit-gitd` — it must
   show exactly one. Never run `fly scale count` above 1 on gitd.
2. **Email sending domain unverified.** The site accepts sign-ups and says "a
   link is on its way" while Resend rejects every one. GitLit refuses to start
   without a mail key for exactly this reason, but it cannot tell whether your
   *domain* is verified. Only the test in step 7 tells you.
3. **Backups never actually copied off the machine.** GitLit bundles every
   repository on a schedule, but writes them to the same disk the books are
   on. One disk failure takes both. Copy them elsewhere (`aws s3 sync`,
   rclone, anything), then **restore one** to a scratch folder and confirm the
   text is really there. A backup you have never restored is a belief, not a
   backup.

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
