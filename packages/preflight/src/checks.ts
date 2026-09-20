import { fail, pass, skip, warn, type Check, type CheckContext, type CheckResult } from "./types.js";

const PROBE_ORIGIN = "https://preflight-probe.invalid";
const DEFAULT_SERVICE_TOKEN = "dev-service-token-change-me";

async function json(ctx: CheckContext, url: string, init?: RequestInit): Promise<unknown> {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return res.json();
}

/** ------------------------------------------------------------------ reach */

export const apiReachable: Check = {
  id: "api-reachable",
  title: "The API answers",
  why: "Nothing else can be checked if it does not.",
  async run(ctx) {
    try {
      const res = await ctx.fetch(`${ctx.apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { ok?: boolean; service?: string };
      if (res.ok && body.ok && body.service === "api") {
        return pass(this, `${ctx.apiUrl} is up.`);
      }
      return fail(this, `Answered ${res.status}, but not as the API.`,
        "Check you gave the API's address, not the website's.");
    } catch (err) {
      return fail(this, `Could not reach ${ctx.apiUrl}: ${(err as Error).message}`,
        "Check the address, and `fly status -a gitlit-api`.");
    }
  },
};

export const httpsOnly: Check = {
  id: "https",
  title: "Traffic is encrypted",
  why: "Over plain http, a sign-in link can be read off the wire by anyone on the network.",
  async run(ctx) {
    const insecure = [ctx.apiUrl, ctx.webUrl]
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .filter((u) => u.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(u));
    if (insecure.length === 0) return pass(this, "Everything is https (or local).");
    return fail(this, `Not https: ${insecure.join(", ")}`,
      "Run `fly certs create` for that app and point DNS at it.");
  },
};

/** --------------------------------------------------------- the CORS rules */

export const corsRefusesStrangers: Check = {
  id: "cors-strangers",
  title: "Other websites cannot act as your authors",
  why:
    "The API accepts requests carrying an author's sign-in. If it accepted them from any " +
    "website, a page an author merely visited could read their manuscripts.",
  async run(ctx) {
    const res = await ctx.fetch(`${ctx.apiUrl}/health`, {
      headers: { origin: PROBE_ORIGIN },
      signal: AbortSignal.timeout(10_000),
    });
    const allowed = res.headers.get("access-control-allow-origin");
    if (!allowed) return pass(this, "A stranger origin was not granted access.");
    if (allowed === PROBE_ORIGIN || allowed === "*") {
      return fail(this, `The API told ${PROBE_ORIGIN} it was allowed.`,
        "Set PUBLIC_WEB_URL to your website and redeploy the API. It should be the only origin allowed.");
    }
    return pass(this, `A stranger origin was answered with ${allowed}, not itself.`);
  },
};

export const corsAllowsTheDashboard: Check = {
  id: "cors-dashboard",
  title: "Your dashboard can talk to the API",
  why:
    "The dashboard sends every request with the author's sign-in attached. If the API does " +
    "not explicitly allow that, the browser throws the reply away and the site loads but does nothing.",
  async run(ctx) {
    if (!ctx.webUrl) return skip(this, "No website address given.");
    const res = await ctx.fetch(`${ctx.apiUrl}/health`, {
      headers: { origin: ctx.webUrl.replace(/\/+$/, "") },
      signal: AbortSignal.timeout(10_000),
    });
    const origin = res.headers.get("access-control-allow-origin");
    const creds = res.headers.get("access-control-allow-credentials");
    if (!origin) {
      return fail(this, `The API did not allow ${ctx.webUrl}.`,
        "PUBLIC_WEB_URL on the API must be exactly your website's address.");
    }
    if (creds !== "true") {
      return fail(this, "The API allows the origin but not credentials, so the browser discards every reply.",
        "This is a code-level setting; the API should send Access-Control-Allow-Credentials: true.");
    }
    return pass(this, `${ctx.webUrl} is allowed, with credentials.`);
  },
};

/** ------------------------------------------------------ the open-door case */

export const noDevTokenLeak: Check = {
  id: "dev-token-leak",
  title: "Sign-in tokens are not handed out in replies",
  why:
    "Outside production the API returns the sign-in token directly, to make local development " +
    "possible. In public that is an open door: anyone could sign in as anyone by asking.",
  async run(ctx) {
    if (!ctx.email) return skip(this, "No --email given; this check asks for a real sign-in link.");
    const res = await ctx.fetch(`${ctx.apiUrl}/v1/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ctx.email }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 429) return skip(this, "Rate limited — try again in a few minutes.");
    if (/"devToken"\s*:\s*"/.test(text)) {
      return fail(this, "The API returned a sign-in token in its reply.",
        "NODE_ENV is not 'production' on the API. Set it and redeploy — this is the most serious finding here.");
    }
    if (res.status === 502) {
      return fail(this, "The API could not send the email at all.",
        "Check RESEND_API_KEY, and that your sending domain shows Verified at Resend.");
    }
    if (!res.ok) return warn(this, `Unexpected ${res.status} from the sign-in route.`, "Check `fly logs -a gitlit-api`.");
    return pass(this, "No token in the reply, and the send was accepted.");
  },
};

export const emailActuallyArrives: Check = {
  id: "email-arrives",
  title: "The sign-in email reaches a real inbox",
  why:
    "There is no password in GitLit. If mail does not arrive, nobody can sign in at all — and " +
    "the site cheerfully says a link is on its way regardless.",
  async run(ctx) {
    if (!ctx.email) return skip(this, "No --email given.");
    // Deliberately not asserted: only the operator's inbox can answer this,
    // and a tool that pretended otherwise would be the exact kind of green
    // light this whole file exists to distrust.
    return {
      id: this.id, title: this.title, why: this.why, status: "warn", needsHuman: true,
      detail: `A sign-in link was requested for ${ctx.email}. Go and look.`,
      remedy:
        "If it has not arrived within two minutes, check Resend's dashboard — it logs every " +
        "attempt and says why one failed. Check the spam folder too: that means SPF/DKIM/DMARC.",
    };
  },
};

/** ------------------------------------------------------------ rate limits */

export const rateLimitIsOn: Check = {
  id: "rate-limit",
  title: "Sign-in attempts are rate limited",
  why: "Without it, one script can hammer the sign-in route as fast as it can send requests.",
  async run(ctx) {
    // Consumes the session route with a junk token: no email is sent, nothing
    // is created, and it is the route most worth limiting.
    let sawLimit = false;
    for (let i = 0; i < 14; i++) {
      const res = await ctx.fetch(`${ctx.apiUrl}/v1/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "glm_preflight_probe" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) { sawLimit = true; break; }
    }
    return sawLimit
      ? pass(this, "The API started refusing repeated attempts.")
      : fail(this, "14 rapid sign-in attempts were all accepted.",
          "The rate limiter is not running. Check TRUST_PROXY_HOPS and that the API is the current build.");
  },
};

/** ----------------------------------------------- gitd must be one machine */

export const gitdSingleMachine: Check = {
  id: "gitd-one-machine",
  title: "Exactly one gitd is running",
  why:
    "gitd holds the manuscripts on one disk. A second copy gets its own empty disk, so books " +
    "appear and vanish depending on which copy answers — and nothing logs an error.",
  async run(ctx) {
    if (!ctx.gitdUrl) return skip(this, "gitd is not reachable from here (usually correct — it is internal).");
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      try {
        const body = (await json(ctx, `${ctx.gitdUrl}/health`)) as { machine?: string };
        if (body.machine) seen.add(body.machine);
      } catch { /* one failed probe is not the question being asked */ }
    }
    if (seen.size === 0) return skip(this, "gitd did not report a machine id.");
    if (seen.size > 1) {
      return fail(this, `Saw ${seen.size} different gitd machines answering.`,
        "Run `fly scale count 1 -a gitlit-gitd` NOW. Manuscripts written to the other machine are on its own disk.");
    }
    return pass(this, "One machine answered every probe.");
  },
};

export const EXTERNAL_CHECKS: Check[] = [
  apiReachable, httpsOnly, corsRefusesStrangers, corsAllowsTheDashboard,
  noDevTokenLeak, emailActuallyArrives, rateLimitIsOn, gitdSingleMachine,
];

/** ---------------------------------------------------------------- internal
 *
 * These read state only the service itself can see. They are served behind an
 * operator token, because a list of an operator's weaknesses is exactly what
 * an attacker would like to read.
 */

export interface OperatorState {
  nodeEnv: string;
  mail: { configured: boolean; from: string | null; fromDomain: string | null };
  webUrl: string | null;
  corsOrigins: string[];
  monitoring: boolean;
  serviceTokenIsDefault: boolean;
  migrationsApplied: boolean;
}

export interface GitdState {
  machine: string;
  keysOnDisk: number;
  unwrappedKeys: number;
  masterKeySet: boolean;
  repositories: number;
  backups: { count: number; newestAgeHours: number | null; newestVerifies: boolean | null; directory: string };
}

export const internalChecks = (state: OperatorState): CheckResult[] => {
  const mk = (id: string, title: string, why: string): Check =>
    ({ id, title, why, run: async () => { throw new Error("unused"); } });

  const results: CheckResult[] = [];

  const prod = mk("node-env", "The API is in production mode",
    "Outside production it hands sign-in tokens straight back in its replies.");
  results.push(state.nodeEnv === "production"
    ? pass(prod, "NODE_ENV=production.")
    : fail(prod, `NODE_ENV is "${state.nodeEnv}".`,
        "Set NODE_ENV=production on the API and redeploy."));

  const tok = mk("service-token", "The gitd password is not the example one",
    "The example value is published in the repository. With it, anyone who reaches gitd can write commits as any author.");
  results.push(state.serviceTokenIsDefault
    ? fail(tok, "GITD_SERVICE_TOKEN is still the example value.",
        "Generate one with `openssl rand -base64 32` and set it on BOTH gitlit-api and gitlit-gitd.")
    : pass(tok, "A non-default token is set."));

  const cors = mk("cors-configured", "The API knows which website is yours",
    "It is the only origin allowed to act as a signed-in author.");
  results.push(state.corsOrigins.length > 0
    ? pass(cors, `Allowed: ${state.corsOrigins.join(", ")}`)
    : fail(cors, "No allowed origins are configured.",
        "Set PUBLIC_WEB_URL on the API to your website's address."));

  const mail = mk("mail-configured", "Mail is configured",
    "Without it nobody can sign in, and the site says a link is on its way regardless.");
  if (!state.mail.configured) {
    results.push(fail(mail, "No mail provider key is set.", "Set RESEND_API_KEY and MAIL_FROM."));
  } else if (state.webUrl && state.mail.fromDomain && !state.webUrl.includes(state.mail.fromDomain)) {
    results.push(warn(mail,
      `Sending from ${state.mail.fromDomain}, but the site is ${state.webUrl}.`,
      "Not necessarily wrong, but mail from a domain unrelated to your site is far more likely to be filtered as spam."));
  } else {
    results.push(pass(mail, `Sending as ${state.mail.from}.`));
  }

  const mig = mk("migrations", "The database is up to date",
    "A new build against an old schema fails in ways that look like data loss.");
  results.push(state.migrationsApplied
    ? pass(mig, "Migrations are applied.")
    : fail(mig, "The database is missing migrations.",
        "Redeploy the API — migrations run automatically as part of a deploy."));

  const mon = mk("monitoring", "Error monitoring", "Without it, a crash in production is invisible.");
  results.push(state.monitoring
    ? pass(mon, "Errors are being reported.")
    : warn(mon, "No error monitoring configured.", "Optional. Set SENTRY_DSN if you want crash reports."));

  return results;
};

export const gitdChecks = (state: GitdState): CheckResult[] => {
  const mk = (id: string, title: string, why: string): Check =>
    ({ id, title, why, run: async () => { throw new Error("unused"); } });
  const results: CheckResult[] = [];

  const keys = mk("signing-keys", "Signing keys are encrypted on disk",
    "These keys sign the provenance receipts. Unencrypted, anyone with a copy of the disk — a snapshot, a backup — can forge them.");
  const keyRemedy =
    "Set SIGNING_MASTER_KEY on gitlit-gitd, and keep a copy in a password manager — " +
    "losing it breaks every existing receipt.";
  if (!state.masterKeySet) {
    results.push(fail(keys, "SIGNING_MASTER_KEY is not set; keys are in plaintext on the volume.", keyRemedy));
  } else if (state.unwrappedKeys > 0) {
    // Keys written before the master key was set stay readable. Setting it
    // later protects new keys and silently leaves the old ones exposed.
    results.push(fail(keys,
      `${state.unwrappedKeys} of ${state.keysOnDisk} signing keys are still unencrypted.`,
      "These were written before SIGNING_MASTER_KEY was set. They stay readable until re-wrapped."));
  } else if (state.keysOnDisk === 0) {
    // Not a failure and not a pass worth boasting about: there is nothing to
    // encrypt yet. Saying "some keys are unencrypted" here would be a false
    // alarm on every fresh deployment, and a checker that cries wolf is one
    // nobody reads.
    results.push(pass(keys, "SIGNING_MASTER_KEY is set. No keys written yet."));
  } else {
    results.push(pass(keys, `All ${state.keysOnDisk} signing ${state.keysOnDisk === 1 ? "key is" : "keys are"} encrypted at rest.`));
  }

  const backups = mk("backups-exist", "Backups are being taken",
    "Manuscripts are the product. A disk failure without backups is the end of it.");
  if (state.repositories === 0) {
    results.push(skip(backups, "No repositories yet, so nothing to back up."));
  } else if (state.backups.count === 0) {
    results.push(fail(backups, "No backups found.",
      `Nothing has been written to ${state.backups.directory}. Run the backup command and schedule it.`));
  } else if (state.backups.newestAgeHours !== null && state.backups.newestAgeHours > 48) {
    results.push(fail(backups, `The newest backup is ${Math.round(state.backups.newestAgeHours)} hours old.`,
      "The schedule has stopped. Check it is still running."));
  } else {
    const n = state.backups.count;
    results.push(pass(backups,
      `${n} backup${n === 1 ? "" : "s"}, newest ${Math.round(state.backups.newestAgeHours ?? 0)}h old.`));
  }

  const verify = mk("backups-restore", "The newest backup actually restores",
    "A backup that has never been restored is a belief, not a backup.");
  if (state.backups.newestVerifies === null) {
    results.push(skip(verify, "No backup to verify."));
  } else if (state.backups.newestVerifies) {
    results.push(pass(verify, "The newest backup was opened and verified."));
  } else {
    results.push(fail(verify, "The newest backup is corrupt and would not restore.",
      "Do not rely on these. Investigate the backup job before anything else."));
  }

  const offsite = mk("backups-offsite", "Backups exist somewhere other than this machine",
    "Backups written beside the manuscripts share a disk. One failure takes both.");
  results.push({
    ...warn(offsite, `Backups are at ${state.backups.directory}, on the same volume as the manuscripts.`,
      "Copy them off — `aws s3 sync`, rclone, anything. This is the one thing here that no check can confirm for you."),
    needsHuman: true,
  });

  return results;
};
