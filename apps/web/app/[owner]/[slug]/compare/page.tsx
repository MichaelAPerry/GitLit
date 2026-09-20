import Link from "next/link";
import { api } from "@/lib/api";
import { CompareView } from "@/components/CompareView";

export const dynamic = "force-dynamic";

interface Doc { path: string; title: string; wordCount: number }

export default async function ComparePage({
  params, searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ path?: string; mode?: string }>;
}) {
  const { owner, slug } = await params;
  const { path, mode } = await searchParams;
  const base = `/v1/repositories/${owner}/${slug}`;

  const { documents } = await api<{ documents: Doc[] }>(`${base}/documents`);
  const selected = path ?? documents[0]?.path;

  if (!selected) {
    return (
      <div className="empty">
        <h2>Nothing to compare yet</h2>
        <p className="meta">Write a chapter first, and the comparison will have something to read.</p>
        <p style={{ marginTop: 20 }}><Link href={`/${owner}/${slug}`} className="btn secondary">Back to the book</Link></p>
      </div>
    );
  }

  return (
    <section>
      <p className="meta"><Link href={`/${owner}/${slug}`}>← {slug}</Link></p>
      <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600, marginBottom: 2 }}>
        Provenance
      </h1>
      <p className="meta">
        Where the plan ended and the writing began. Three ways of reading the same history.
      </p>

      {documents.length > 1 && (
        <p className="mode-note" style={{ marginTop: 14 }}>
          {documents.map((d) => (
            <Link
              key={d.path}
              href={`/${owner}/${slug}/compare?path=${encodeURIComponent(d.path)}${mode ? `&mode=${mode}` : ""}`}
              style={{
                marginRight: 14,
                textDecoration: d.path === selected ? "underline" : "none",
                color: d.path === selected ? "var(--ink)" : "var(--ink-faint)",
              }}
            >
              {d.title}
            </Link>
          ))}
        </p>
      )}

      <CompareView owner={owner} slug={slug} path={selected} initialMode={mode ?? "plan"} />
    </section>
  );
}
