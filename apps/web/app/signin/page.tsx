"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { API } from "@/lib/api";

interface Provider { id: string; label: string }

/**
 * Passwordless sign-in. There is no password anywhere in GitLit: nothing to
 * leak, nothing to reuse, and nothing for an author to lose along with access
 * to their own manuscript.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={<p className="meta">Loading…</p>}>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(search.get("error"));
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);

  // A session handed back by a provider callback arrives in the URL.
  useEffect(() => {
    const handed = search.get("session");
    if (!handed) return;
    try { localStorage.setItem("gitlit_session", handed); } catch { /* private mode */ }
    router.replace("/");
  }, [router, search]);

  useEffect(() => {
    fetch(`${API}/v1/auth/providers`)
      .then((r) => r.json())
      .then((d: { providers: Provider[] }) => setProviders(d.providers))
      .catch(() => setProviders([]));
  }, []);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/v1/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { devToken?: string };
      setSent(true);
      if (data.devToken) { setDevToken(data.devToken); setToken(data.devToken); }
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  async function consume(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/v1/auth/session`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) throw new Error("invalid");
      const { sessionToken } = (await res.json()) as { sessionToken: string };
      try { localStorage.setItem("gitlit_session", sessionToken); } catch { /* private mode */ }
      router.push("/");
      router.refresh();
    } catch {
      setError("That link is invalid, already used, or expired.");
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: "26rem" }}>
      <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>Sign in</h1>

      {providers.length > 0 && !sent && (
        <div style={{ marginBottom: 26 }}>
          {providers.map((p) => (
            <a
              key={p.id}
              className="btn secondary"
              style={{ display: "block", textAlign: "center", marginBottom: 8 }}
              href={`${API}/v1/auth/oauth/${p.id}`}
            >
              Continue with {p.label}
            </a>
          ))}
          <p className="meta" style={{ marginTop: 10 }}>
            GitLit asks {providers.length === 1 ? providers[0]!.label : "these services"} who you
            are and nothing else — no access to your repositories or files.
          </p>
          <p className="meta" style={{ textAlign: "center", margin: "18px 0 0" }}>or</p>
        </div>
      )}

      {!sent ? (
        <form onSubmit={request}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email}
                 onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <p className="meta" style={{ marginTop: 8 }}>
            We&apos;ll email you a link. No password to remember or lose.
          </p>
          <p style={{ marginTop: 18 }}>
            <button className="btn" disabled={busy || !email}>{busy ? "Sending…" : "Email me a link"}</button>
          </p>
        </form>
      ) : (
        <form onSubmit={consume}>
          <div className="notice">
            {devToken
              ? "Development mode: the link is shown below instead of being emailed."
              : `If ${email} can sign in, a link is on its way. It expires in 15 minutes and works once.`}
          </div>
          <label htmlFor="token">Sign-in token</label>
          <input id="token" value={token} onChange={(e) => setToken(e.target.value)}
                 style={{ fontFamily: "var(--mono)", fontSize: "0.8rem" }} />
          <p style={{ marginTop: 18 }}>
            <button className="btn" disabled={busy || !token}>{busy ? "Signing in…" : "Sign in"}</button>
          </p>
        </form>
      )}

      {error && <p style={{ color: "#b4462f" }}>{error}</p>}
    </section>
  );
}
