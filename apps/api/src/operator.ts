import type { FastifyRequest } from "fastify";
import { constantTimeEquals, forbidden } from "@gitlit/core";

/**
 * The operator surface, read by `gitlit-preflight`.
 *
 * This reports whether the deployment is configured safely — which is, read
 * the other way round, a list of the operator's weaknesses. So it has a
 * credential of its own rather than riding on an author's session: the person
 * who should see it is whoever can set secrets, not whoever happens to be
 * signed in.
 *
 * It reports BOOLEANS AND REASONS, NEVER VALUES. "A non-default token is set"
 * is what an operator needs; the token itself is what an attacker needs.
 */

const DEFAULT_SERVICE_TOKEN = "dev-service-token-change-me";

export function requireOperator(req: FastifyRequest): void {
  const expected = process.env.OPERATOR_TOKEN;
  const header = req.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";

  /**
   * Unset means off, not open. An operator surface that defaults to
   * reachable is worse than one that does not exist.
   */
  if (!expected || !presented || !constantTimeEquals(expected, presented)) {
    throw forbidden("Operator access is not available.");
  }
}

export interface OperatorState {
  nodeEnv: string;
  mail: { configured: boolean; from: string | null; fromDomain: string | null };
  webUrl: string | null;
  corsOrigins: string[];
  monitoring: boolean;
  serviceTokenIsDefault: boolean;
  migrationsApplied: boolean;
}

export function operatorState(input: {
  corsOrigins: string[];
  monitoring: boolean;
  migrationsApplied: boolean;
  env?: NodeJS.ProcessEnv;
}): OperatorState {
  const env = input.env ?? process.env;
  const from = env.MAIL_FROM?.trim() || null;
  const fromDomain = from ? (/@([^\s>]+)/.exec(from)?.[1] ?? null) : null;

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    mail: { configured: Boolean(env.RESEND_API_KEY?.trim()), from, fromDomain },
    webUrl: env.PUBLIC_WEB_URL?.trim() || null,
    corsOrigins: input.corsOrigins,
    monitoring: input.monitoring,
    serviceTokenIsDefault: (env.GITD_SERVICE_TOKEN ?? "") === DEFAULT_SERVICE_TOKEN,
    migrationsApplied: input.migrationsApplied,
  };
}
