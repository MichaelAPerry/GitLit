import Link from "next/link";
import { api, type Repo } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  let repositories: Repo[] = [];
  let offline = false;
  try {
    ({ repositories } = await api<{ repositories: Repo[] }>("/v1/repositories"));
  } catch {
    offline = true;
  }

  if (offline) {
    return (
      <div className="empty">
        <h2>The API isn&apos;t running</h2>
        <p className="meta">
          Start the services with <code>pnpm dev</code>, or <code>docker compose up -d</code> first.
        </p>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="empty">
        <h2>No books yet</h2>
        <p className="meta">
          If you have books already, <Link href="/signin" style={{ textDecoration: "underline" }}>sign in</Link> to see them.
        </p>
        <p className="meta">A book is a repository. Its history is the record of how it was written.</p>
        <p style={{ marginTop: 24 }}><Link href="/new" className="btn">Start a book</Link></p>
      </div>
    );
  }

  return (
    <section>
      <h1 style={{ fontFamily: "var(--serif)", fontWeight: 600 }}>Your books</h1>
      {repositories.map((r) => (
        <Link key={r.id} href={`/${r.owner}/${r.slug}`}>
          <article className="card">
            <h3>{r.title}</h3>
            <p className="meta">
              {r.form}{r.genre.length > 0 && <> · {r.genre.join(", ")}</>} · {r.phase} ·
              updated {new Date(r.updatedAt).toLocaleDateString()}
            </p>
          </article>
        </Link>
      ))}
    </section>
  );
}
