import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@gitlit/db";
import { newUserId, prefixed } from "@gitlit/core";
import { issueSecret, parseSecret, verifySecret } from "./secrets.js";
import {
  createPkce, isProviderId, OAuthError, PROVIDERS, safeReturnTo,
  type HttpClient, type OAuthProfile, type ProviderConfig, type ProviderId, type TokenResponse,
} from "./oauth-providers.js";
import type { User } from "./types.js";

const newStateId = prefixed("oas");
const newAccountId = prefixed("acct");

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthOutcome {
  user: User;
  sessionToken: string;
  returnTo: string;
  /** True when this provider identity was newly attached to the account. */
  linked: boolean;
  created: boolean;
}

/**
 * OAuth sign-in (§4).
 *
 * The flow itself is ordinary authorization-code-with-PKCE. What deserves
 * attention is `resolveIdentity` below: account linking is where OAuth
 * implementations get taken over, and the rule is stated there rather than
 * spread across branches.
 */
export class OAuthService {
  constructor(
    private readonly db: Database,
    private readonly configs: Partial<Record<ProviderId, ProviderConfig>>,
    private readonly http: HttpClient,
    private readonly createSession: (userId: string) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Providers with credentials configured. An unconfigured one is absent, not broken. */
  available(): { id: ProviderId; label: string }[] {
    return (Object.keys(PROVIDERS) as ProviderId[])
      .filter((id) => this.configs[id]?.clientId && this.configs[id]?.clientSecret)
      .map((id) => ({ id, label: PROVIDERS[id].label }));
  }

  private config(id: ProviderId): ProviderConfig {
    const config = this.configs[id];
    if (!config?.clientId || !config.clientSecret) {
      throw new OAuthError("provider_unconfigured", `${PROVIDERS[id].label} sign-in is not configured.`);
    }
    return config;
  }

  /** Step 1: mint state and return the URL to send the browser to. */
  async begin(input: {
    provider: string;
    redirectUri: string;
    returnTo?: string;
    /** Set when an already signed-in user is attaching a second provider. */
    linkUserId?: string;
  }): Promise<{ url: string; state: string }> {
    if (!isProviderId(input.provider)) {
      throw new OAuthError("unknown_provider", `No such provider: ${input.provider}`);
    }
    const provider = PROVIDERS[input.provider];
    const config = this.config(input.provider);

    const issued = issueSecret("glo");
    const pkce = createPkce();
    const nonce = randomBytes(16).toString("base64url");

    await this.db.insert(schema.oauthStates).values({
      id: newStateId(),
      provider: provider.id,
      selector: issued.selector,
      verifier: issued.verifier,
      codeVerifier: pkce.verifier,
      nonce,
      returnTo: safeReturnTo(input.returnTo),
      linkUserId: input.linkUserId,
      expiresAt: new Date(this.now().getTime() + OAUTH_STATE_TTL_MS),
    });

    const url = new URL(provider.authorizeUrl);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", provider.scopes.join(" "));
    url.searchParams.set("state", issued.plaintext);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (provider.usesNonce) url.searchParams.set("nonce", nonce);

    return { url: url.toString(), state: issued.plaintext };
  }

  /** Step 2: consume state, exchange the code, resolve the identity, sign in. */
  async complete(input: {
    provider: string;
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<OAuthOutcome> {
    if (!isProviderId(input.provider)) {
      throw new OAuthError("unknown_provider", `No such provider: ${input.provider}`);
    }
    const provider = PROVIDERS[input.provider];
    const config = this.config(input.provider);

    const parsed = parseSecret(input.state);
    if (!parsed || parsed.prefix !== "glo") {
      throw new OAuthError("bad_state", "That sign-in attempt is not recognised.");
    }

    /**
     * Consume in the same statement that checks it is unconsumed, for the same
     * reason magic links do: a read-then-write lets two deliveries of one
     * state both proceed.
     */
    const [state] = await this.db.update(schema.oauthStates)
      .set({ consumedAt: this.now() })
      .where(and(
        eq(schema.oauthStates.selector, parsed.selector),
        isNull(schema.oauthStates.consumedAt),
      ))
      .returning();

    if (!state) throw new OAuthError("bad_state", "That sign-in attempt has already been used.");
    if (state.provider !== provider.id) {
      throw new OAuthError("bad_state", "That sign-in attempt was for a different provider.");
    }
    if (new Date(state.expiresAt) <= this.now()) {
      throw new OAuthError("expired_state", "That sign-in attempt expired. Please try again.");
    }
    if (!verifySecret(parsed.secret, state.verifier)) {
      throw new OAuthError("bad_state", "That sign-in attempt is not recognised.");
    }

    const tokens = (await this.http.postForm(provider.tokenUrl, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: state.codeVerifier,
    })) as TokenResponse;

    if (typeof tokens["error"] === "string") {
      throw new OAuthError("token_exchange_failed", String(tokens["error_description"] ?? tokens["error"]));
    }

    const profile = await provider.fetchProfile(this.http, tokens, state.nonce, config.clientId);
    const resolved = await this.resolveIdentity(provider.id, profile, state.linkUserId ?? undefined);

    return {
      ...resolved,
      sessionToken: await this.createSession(resolved.user.id),
      returnTo: safeReturnTo(state.returnTo),
    };
  }

  /**
   * Decide which account this provider identity belongs to.
   *
   * THE rule: an unverified provider email never reaches an existing account.
   * Anyone can set their GitHub address to someone else's; if that were enough
   * to link, sign-in with any provider would be an account-takeover primitive
   * against every user who ever signed up by email.
   *
   * So:
   *   - already linked   -> that user, always. We have seen this identity.
   *   - signed in        -> attach to the current user. They proved control.
   *   - verified email   -> link to, or create, the user with that address.
   *   - unverified email -> refuse, and say how to proceed.
   *   - no email at all  -> refuse, and say how to proceed.
   */
  private async resolveIdentity(
    providerId: ProviderId, profile: OAuthProfile, linkUserId?: string,
  ): Promise<{ user: User; linked: boolean; created: boolean }> {
    const [existing] = await this.db.select().from(schema.accounts).where(and(
      eq(schema.accounts.provider, providerId),
      eq(schema.accounts.providerAccountId, profile.providerAccountId),
    ));

    if (existing) {
      if (linkUserId && existing.userId !== linkUserId) {
        throw new OAuthError(
          "already_linked",
          `That ${PROVIDERS[providerId].label} account is already linked to a different GitLit account.`,
        );
      }
      const user = await this.getUser(existing.userId);
      if (!user) throw new OAuthError("orphaned_account", "The linked account no longer exists.");
      return { user, linked: false, created: false };
    }

    if (linkUserId) {
      const user = await this.getUser(linkUserId);
      if (!user) throw new OAuthError("unknown_user", "That account no longer exists.");
      await this.link(providerId, profile, user.id);
      return { user, linked: true, created: false };
    }

    if (!profile.email) {
      throw new OAuthError(
        "no_email",
        `${PROVIDERS[providerId].label} did not share an email address, so GitLit cannot tell ` +
        `which account this is. Sign in with your email instead, then link ` +
        `${PROVIDERS[providerId].label} from your settings.`,
      );
    }

    if (!profile.emailVerified) {
      throw new OAuthError(
        "unverified_email",
        `${PROVIDERS[providerId].label} has not verified ${profile.email}, so GitLit will not ` +
        `use it to sign you in — an unverified address is not proof of ownership. ` +
        `Verify it with ${PROVIDERS[providerId].label}, or sign in with your email instead.`,
      );
    }

    const email = profile.email.trim().toLowerCase();
    const [match] = await this.db.select().from(schema.users).where(eq(schema.users.email, email));

    if (match) {
      await this.link(providerId, profile, match.id);
      return { user: toUser(match), linked: true, created: false };
    }

    const [created] = await this.db.insert(schema.users).values({
      id: newUserId(),
      email,
      handle: await this.suggestHandle(profile.handleHint ?? email.split("@")[0] ?? "author"),
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      emailVerified: this.now(),
    }).returning();

    await this.link(providerId, profile, created!.id);
    return { user: toUser(created!), linked: true, created: true };
  }

  private async link(providerId: ProviderId, profile: OAuthProfile, userId: string): Promise<void> {
    await this.db.insert(schema.accounts).values({
      id: newAccountId(),
      userId,
      provider: providerId,
      providerAccountId: profile.providerAccountId,
      linkedEmail: profile.email?.toLowerCase(),
      emailVerifiedByProvider: profile.emailVerified,
    });
  }

  async linkedProviders(userId: string): Promise<{ provider: string; linkedEmail: string | null }[]> {
    const rows = await this.db.select().from(schema.accounts)
      .where(eq(schema.accounts.userId, userId));
    return rows.map((r) => ({ provider: r.provider, linkedEmail: r.linkedEmail }));
  }

  /**
   * Unlink a provider. Refuses to remove the last way in: an account whose
   * only credential is a provider link, with no verified email, would be
   * unreachable afterwards.
   */
  async unlink(userId: string, providerId: string): Promise<boolean> {
    const user = await this.getUser(userId);
    if (!user?.emailVerifiedAt) {
      const remaining = await this.linkedProviders(userId);
      if (remaining.length <= 1) {
        throw new OAuthError(
          "last_credential",
          "That is the only way into this account. Verify an email address first.",
        );
      }
    }
    const removed = await this.db.delete(schema.accounts).where(and(
      eq(schema.accounts.userId, userId),
      eq(schema.accounts.provider, providerId),
    )).returning();
    return removed.length > 0;
  }

  async purgeExpiredStates(): Promise<number> {
    const rows = await this.db.delete(schema.oauthStates)
      .where(eq(schema.oauthStates.provider, schema.oauthStates.provider)).returning();
    return rows.length;
  }

  private async getUser(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id));
    return row ? toUser(row) : undefined;
  }

  private async suggestHandle(hint: string): Promise<string> {
    const base = hint.replace(/[^a-z0-9]/gi, "").toLowerCase() || "author";
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? base : `${base}${i + 1}`;
      const [taken] = await this.db.select().from(schema.users)
        .where(eq(schema.users.handle, candidate));
      if (!taken) return candidate;
    }
    return `${base}${Date.now()}`;
  }
}

type UserRow = typeof schema.users.$inferSelect;

const toUser = (r: UserRow): User => ({
  id: r.id,
  handle: r.handle,
  email: r.email,
  displayName: r.displayName ?? undefined,
  emailVerifiedAt: r.emailVerified?.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

/** The real HTTP client. Injectable so the flow is testable without a provider. */
export const liveHttpClient: HttpClient = {
  async postForm(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return (await res.json()) as Record<string, unknown>;
  },
  async getJson(url, token) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "GitLit",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new OAuthError("provider_request_failed", `${url} returned ${res.status}`);
    return res.json();
  },
};

export { OAuthError, safeReturnTo, createPkce, isProviderId, PROVIDERS, decodeJwtClaims } from "./oauth-providers.js";
export type { OAuthProfile, HttpClient, ProviderId, ProviderConfig } from "./oauth-providers.js";
