"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { API } from "@/lib/api";

export default function NewBook() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [form, setForm] = useState("novel");
  const [premise, setPremise] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/v1/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, slug, form, premise: premise || undefined, genre: [] }),
      });
      if (!res.ok) throw new Error(await res.text());
      const repo = await res.json();
      router.push(`/${repo.owner}/${repo.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: "34rem" }}>
      <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>Start a book</h1>

      <form onSubmit={submit}>
        <label htmlFor="title">Working title</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required
               placeholder="The Lighthouse at Saltmarsh" />
        {slug && <p className="meta" style={{ marginTop: 6 }}>Repository: <code>demo/{slug}</code></p>}

        <label htmlFor="form">Form</label>
        <select id="form" value={form} onChange={(e) => setForm(e.target.value)}>
          <option value="novel">Novel</option>
          <option value="nonfiction">Nonfiction</option>
          <option value="memoir">Memoir</option>
          <option value="collection">Collection</option>
        </select>

        <label htmlFor="premise">Premise <span className="meta">(optional)</span></label>
        <textarea id="premise" rows={5} value={premise} onChange={(e) => setPremise(e.target.value)}
                  placeholder="A lighthouse keeper's daughter returns to the island she swore she'd never see again…" />

        <div className="notice">
          Your premise stays in your repository. GitLit runs no AI and sends nothing to a model
          provider. To research it, connect GitLit from your own Claude — the research then lands
          here with its full source ledger.
        </div>

        {error && <p style={{ color: "#b4462f" }}>{error}</p>}

        <p style={{ marginTop: 20 }}>
          <button className="btn" disabled={busy || !title}>{busy ? "Creating…" : "Create book"}</button>
        </p>
      </form>
    </section>
  );
}
