"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { API } from "@/lib/api";

/**
 * Passwordless sign-in. There is no password anywhere in GitLit: nothing to
 * leak, nothing to reuse, and nothing for an author to lose along with access
 * to their own manuscript.
 */
export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
