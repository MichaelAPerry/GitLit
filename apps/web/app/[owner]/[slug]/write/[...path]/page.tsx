import { Composer } from "@/components/Composer";
import { API } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function WritePage({
  params,
}: {
  params: Promise<{ owner: string; slug: string; path: string[] }>;
}) {
  const { owner, slug, path } = await params;
  const filePath = path.join("/");

  // Flow view: the editor shows paragraphs, not the one-sentence-per-line form
  // that is stored on disk (§2.2). Authors never see the canonical format.
  let content = "";
  try {
    const res = await fetch(
      `${API}/v1/repositories/${owner}/${slug}/documents/${filePath}?flow=true`,
      { cache: "no-store" },
    );
    if (res.ok) content = ((await res.json()) as { content: string }).content;
  } catch {
    /* new file */
  }

  return <Composer owner={owner} slug={slug} path={filePath} initialContent={content} />;
}
