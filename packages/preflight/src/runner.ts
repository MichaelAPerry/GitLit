import { EXTERNAL_CHECKS, gitdChecks, internalChecks, type GitdState, type OperatorState } from "./checks.js";
import type { CheckContext, CheckResult, Report } from "./types.js";

/** A check that throws is a failed check, never a crashed run. */
async function safely(run: () => Promise<CheckResult>, id: string, title: string): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return {
      id, title, status: "fail",
      why: "This check could not complete.",
      detail: `The check itself errored: ${(err as Error).message}`,
      remedy: "Usually a network or address problem. Check the URL you gave.",
    };
  }
}

export async function runPreflight(ctx: CheckContext): Promise<Report> {
  const results: CheckResult[] = [];

  for (const check of EXTERNAL_CHECKS) {
    results.push(await safely(() => check.run(ctx), check.id, check.title));
    // Stop early if the API is not there: every later result would be noise
    // dressed up as a finding.
    if (check.id === "api-reachable" && results[0]?.status === "fail") return report(ctx, results);
  }

  if (ctx.operatorToken) {
    results.push(...await internalFor(ctx));
  } else {
    results.push({
      id: "operator-checks", title: "Checks that need an operator token",
      why: "Some things can only be seen from inside the running service.",
      status: "skip",
      detail: "No operator token given, so settings, keys and backups were not checked.",
      remedy: "Set OPERATOR_TOKEN on the API and gitd, then pass --token.",
    });
  }

  return report(ctx, results);
}

async function internalFor(ctx: CheckContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const auth = { authorization: `Bearer ${ctx.operatorToken}` };

  try {
    const res = await ctx.fetch(`${ctx.apiUrl}/v1/operator/state`, {
      headers: auth, signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      out.push(unauthorized("api"));
    } else if (res.ok) {
      out.push(...internalChecks((await res.json()) as OperatorState));
    } else {
      out.push(unavailable("api", res.status));
    }
  } catch (err) {
    out.push(unavailable("api", (err as Error).message));
  }

  const gitd = ctx.gitdUrl;
  if (!gitd) {
    out.push({
      id: "gitd-state", title: "gitd's keys and backups",
      why: "Only gitd can see the manuscript volume.",
      status: "skip",
      detail: "gitd was not reachable from here — normally correct, since it is internal-only.",
      remedy: "Run preflight from inside the private network (`fly ssh console -a gitlit-api`) to include these.",
    });
    return out;
  }

  try {
    const res = await ctx.fetch(`${gitd}/operator/state`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 || res.status === 403) out.push(unauthorized("gitd"));
    else if (res.ok) out.push(...gitdChecks((await res.json()) as GitdState));
    else out.push(unavailable("gitd", res.status));
  } catch (err) {
    out.push(unavailable("gitd", (err as Error).message));
  }
  return out;
}

const unauthorized = (service: string): CheckResult => ({
  id: `${service}-operator-auth`, title: `Operator access to ${service}`,
  why: "The internal checks need a credential.",
  status: "fail",
  detail: `${service} refused the operator token.`,
  remedy: `Set the same OPERATOR_TOKEN on ${service} as the one you passed with --token.`,
});

const unavailable = (service: string, reason: string | number): CheckResult => ({
  id: `${service}-operator-state`, title: `Operator access to ${service}`,
  why: "The internal checks need to read the service's own state.",
  status: "warn",
  detail: `Could not read ${service}'s state: ${reason}`,
  remedy: `Check that ${service} is running the current build.`,
});

const report = (ctx: CheckContext, results: CheckResult[]): Report => ({
  startedAt: new Date().toISOString(),
  target: ctx.apiUrl,
  results,
});
