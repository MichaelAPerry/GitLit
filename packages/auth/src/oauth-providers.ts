import { createHash, randomBytes } from "node:crypto";

/**
 * Identity providers (§4).
 *
 * GitLit asks a provider one question — who is this — and stores nothing else.
 * Scopes are the minimum that answers it: no repository access, no contacts,
 * no offline access. An author signing in to a writing tool should not be
 * handing over their GitHub repositories.
 */

export type ProviderId = "github" | "google";

export interface OAuthProfile {
  providerAccountId: string;
  email: string | null;
  /**
   * Whether the PROVIDER vouches for the address. Account linking turns
   * entirely on this: linking an unverified address to an existing account is
   * an account-takeover primitive, not a convenience.
   */
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
  handleHint?: string;
}

export interface HttpClient {
  postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>>;
  getJson(url: string, token: string): Promise<unknown>;
}

export interface ProviderConfig {
  id: ProviderId;
  clientId: string;
  clientSecret: string;
}

export interface Provider {
  id: ProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** OIDC providers return an id_token whose nonce must match the request. */
  usesNonce: boolean;
  fetchProfile(http: HttpClient, tokens: TokenResponse, expectedNonce: string): Promise<OAuthProfile>;
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  [key: string]: unknown;
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

// ------------------------------------------------------------------ GitHub

const github: Provider = {
  id: "github",
  label: "GitHub",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  // read:user for the profile, user:email for the verified-address list.
  // Notably NOT `repo` — GitLit has no business reading anyone's code.
  scopes: ["read:user", "user:email"],
  usesNonce: false,

  async fetchProfile(http, tokens) {
    const token = tokens.access_token;
    if (!token) throw new OAuthError("no_access_token", "GitHub returned no access token.");

    const user = (await http.getJson("https://api.github.com/user", token)) as Record<string, unknown>;
    if (!user["id"]) throw new OAuthError("no_profile", "GitHub returned no profile.");

    /**
     * The primary email on /user can be null (private) and carries no verified
     * flag, so the address list is the only trustworthy source.
     *
     * Verified addresses are preferred, but an unverified one is still
     * REPORTED rather than discarded — with its flag intact. Dropping it would
     * make an unverified address indistinguishable from no address at all, and
     * the caller would then tell the author "GitHub shared no email" when it
     * shared one it simply has not confirmed. Same refusal either way; only
     * one of the two messages points at the right remedy.
     */
    const emails = (await http.getJson("https://api.github.com/user/emails", token)) as
      { email: string; primary: boolean; verified: boolean }[] | undefined;
    const list = Array.isArray(emails) ? emails : [];
    const chosen =
      list.find((e) => e.primary && e.verified) ??
      list.find((e) => e.verified) ??
      list.find((e) => e.primary) ??
      list[0];

    return {
      providerAccountId: String(user["id"]),
      email: chosen?.email ?? null,
      emailVerified: Boolean(chosen?.verified),
      displayName: (user["name"] as string) ?? undefined,
      avatarUrl: (user["avatar_url"] as string) ?? undefined,
      handleHint: (user["login"] as string) ?? undefined,
    };
  },
};

// ------------------------------------------------------------------ Google

const google: Provider = {
  id: "google",
  label: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email", "profile"],
  usesNonce: true,

  async fetchProfile(_http, tokens, expectedNonce) {
    const idToken = tokens.id_token;
    if (!idToken) throw new OAuthError("no_id_token", "Google returned no id_token.");

    /**
     * The id_token arrived directly from Google's token endpoint over TLS, so
     * per OIDC §3.1.3.7 the signature need not be re-verified — the channel
     * already establishes the issuer. The claims still must be checked, and
     * the nonce is what ties this token to the authorization we started.
     */
    const claims = decodeJwtClaims(idToken);

    const issuer = String(claims["iss"] ?? "");
    if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") {
      throw new OAuthError("bad_issuer", `Unexpected id_token issuer: ${issuer}`);
    }
    const expiry = Number(claims["exp"] ?? 0);
    if (!expiry || expiry * 1000 <= Date.now()) {
      throw new OAuthError("expired_id_token", "Google's id_token has expired.");
    }
    if (claims["nonce"] !== expectedNonce) {
      throw new OAuthError("nonce_mismatch", "The id_token does not match this sign-in attempt.");
    }
    if (!claims["sub"]) throw new OAuthError("no_subject", "Google's id_token carries no subject.");

    return {
      providerAccountId: String(claims["sub"]),
      email: (claims["email"] as string) ?? null,
      emailVerified: claims["email_verified"] === true || claims["email_verified"] === "true",
      displayName: (claims["name"] as string) ?? undefined,
      avatarUrl: (claims["picture"] as string) ?? undefined,
    };
  },
};

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OAuthError("malformed_id_token", "id_token is not a JWT.");
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("malformed_id_token", "id_token claims are not valid JSON.");
  }
}

export const PROVIDERS: Record<ProviderId, Provider> = { github, google };

export const isProviderId = (value: string): value is ProviderId =>
  value === "github" || value === "google";

// -------------------------------------------------------------------- PKCE

export interface Pkce { verifier: string; challenge: string }

/** RFC 7636 S256. Defence in depth even for a confidential client. */
export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Where the browser may be sent after sign-in.
 *
 * Only a local path. A returnTo that accepts an absolute URL — or a
 * protocol-relative one, which is the usual way this is missed — turns the
 * sign-in endpoint into an open redirect and a credible phishing hop.
 */
export function safeReturnTo(value: string | undefined | null): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\r\n]/.test(value)) return "/";
  return value;
}
