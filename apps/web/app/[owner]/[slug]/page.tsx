import Link from "next/link";
import { api, type Commit, type Repo } from "@/lib/api";
import { ProseTimeline } from "@/components/ProseTimeline";
import { ProvenanceBar } from "@/components/ProvenanceBar";

export const dynamic = "force-dynamic";

interface Doc { path: string; title: string; wordCount: number }

export default async function BookPage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  const base = `/v1/repositories/${owner}/${slug}`;

  const [repo, docs, history, provenance] = await Promise.all([
    api<Repo & { files: string[] }>(base),
    api<{ documents: Doc[] }>(`${base}/documents`),
    api<{ commits: Commit[] }>(`${base}/commits`),
    api<{ spans: number; charsByOrigin: Record<string, number> }>(`${base}/provenance`),
  ]);

  const words = docs.documents.reduce((n, d) => n + d.wordCount, 0);

  return (
    <section>
      <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600, marginBottom: 4 }}>{repo.title}</h1>
      <p className="meta">
        {repo.form} · {words.toLocaleString()} words · {docs.documents.length} chapters · {repo.phase}
      </p>

      <div className="grid two" style={{ marginTop: 28 }}>
        <div>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "1.1rem" }}>Chapters</h2>
          {docs.documents.length === 0 ? (
            <div className="card">
              <p className="meta" style={{ marginTop: 0 }}>No chapters yet.</p>
              <Link href={`/${owner}/${slug}/write/manuscript/chapters/01-untitled.md`} className="btn">
                Write the first chapter
              </Link>
            </div>
          ) : (
            <>
              {docs.documents.map((d) => (
                <Link key={d.path} href={`/${owner}/${slug}/write/${d.path}`}>
                  <article className="card">
                    <h3>{d.title}</h3>
                    <p className="meta">{d.wordCount.toLocaleString()} words · <code>{d.path}</code></p>
                  </article>
                </Link>
              ))}
              <Link
                href={`/${owner}/${slug}/write/manuscript/chapters/${String(docs.documents.length + 1).padStart(2, "0")}-untitled.md`}
                className="btn secondary"
              >
                Add a chapter
              </Link>
            </>
          )}

          <h2 style={{ fontFamily: "var(--serif)", fontSize: "1.1rem", marginTop: 34 }}>Prose timeline</h2>
          <ProseTimeline commits={history.commits} />
        </div>

        <aside>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "1.1rem" }}>Provenance</h2>
          <div className="card">
            <ProvenanceBar charsByOrigin={provenance.charsByOrigin} />
            <p className="meta" style={{ marginTop: 14 }}>
              Recorded from {provenance.spans} span{provenance.spans === 1 ? "" : "s"} across{" "}
              {history.commits.length} commit{history.commits.length === 1 ? "" : "s"}.
            </p>
          </div>

          <div className="notice">
            <strong>What this shows.</strong> GitLit records what happened inside GitLit: who
            committed, when, and what the machine contributed. It cannot prove text marked as
            written here was not composed elsewhere and retyped. The record is evidence, not proof.
          </div>

          <h2 style={{ fontFamily: "var(--serif)", fontSize: "1.1rem", marginTop: 26 }}>Research</h2>
          <div className="card">
            <p className="meta" style={{ marginTop: 0 }}>
              No research session yet. Connect GitLit from your own Claude and ask it to research
              your premise — the source ledger and outline land here, signed.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
