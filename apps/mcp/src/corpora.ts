/**
 * Corpus clients (§8.5). Plain catalogue APIs — no inference, no model keys.
 *
 * These are called by US, from `gitlit_search_prior_works`. The agent never
 * reaches a corpus directly, which is what makes the research ledger a record
 * of what was actually searched rather than what the model says it searched.
 */

export interface Work {
  source: "openlibrary" | "googlebooks" | "crossref" | "semanticscholar";
  externalId: string;
  title: string;
  authors: string[];
  publishedYear?: number;
  identifier?: string;
  synopsis?: string;
  url?: string;
}

const UA = { "user-agent": "GitLit/0.1 (+https://gitlit.app/bot)" };
const timeout = () => AbortSignal.timeout(12_000);

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: timeout() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function searchOpenLibrary(query: string, limit = 10): Promise<Work[]> {
  const data = await json<{ docs?: Record<string, unknown>[] }>(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}` +
      `&fields=key,title,author_name,first_publish_year,isbn,subject`,
  );
  return (data?.docs ?? []).map((d) => ({
    source: "openlibrary" as const,
    externalId: String(d["key"] ?? ""),
    title: String(d["title"] ?? ""),
    authors: (d["author_name"] as string[]) ?? [],
    publishedYear: d["first_publish_year"] as number | undefined,
    identifier: (d["isbn"] as string[] | undefined)?.[0],
    synopsis: ((d["subject"] as string[]) ?? []).slice(0, 25).join(", "),
    url: `https://openlibrary.org${String(d["key"] ?? "")}`,
  })).filter((w) => w.title);
}

export async function searchGoogleBooks(query: string, limit = 10): Promise<Work[]> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const data = await json<{ items?: Record<string, any>[] }>(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}` +
      `&maxResults=${limit}${key ? `&key=${key}` : ""}`,
  );
  return (data?.items ?? []).map((item) => {
    const v = item["volumeInfo"] ?? {};
    return {
      source: "googlebooks" as const,
      externalId: String(item["id"] ?? ""),
      title: String(v.title ?? ""),
      authors: (v.authors as string[]) ?? [],
      publishedYear: v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) : undefined,
      identifier: (v.industryIdentifiers as { identifier: string }[] | undefined)?.[0]?.identifier,
      synopsis: v.description as string | undefined,
      url: v.infoLink as string | undefined,
    };
  }).filter((w) => w.title);
}

export async function searchCrossref(query: string, limit = 10): Promise<Work[]> {
  const data = await json<{ message?: { items?: Record<string, any>[] } }>(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}` +
      `&select=DOI,title,author,issued,abstract`,
  );
  return (data?.message?.items ?? []).map((item) => ({
    source: "crossref" as const,
    externalId: String(item["DOI"] ?? ""),
    title: String((item["title"] as string[] | undefined)?.[0] ?? ""),
    authors: ((item["author"] as { given?: string; family?: string }[]) ?? [])
      .map((a) => [a.given, a.family].filter(Boolean).join(" ")),
    publishedYear: (item["issued"] as { "date-parts"?: number[][] })?.["date-parts"]?.[0]?.[0],
    identifier: String(item["DOI"] ?? ""),
    synopsis: typeof item["abstract"] === "string"
      ? item["abstract"].replace(/<[^>]+>/g, " ").trim() : undefined,
    url: item["DOI"] ? `https://doi.org/${item["DOI"]}` : undefined,
  })).filter((w) => w.title);
}

export async function searchSemanticScholar(query: string, limit = 10): Promise<Work[]> {
  const data = await json<{ data?: Record<string, any>[] }>(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
      `&limit=${limit}&fields=title,authors,year,abstract,externalIds,url`,
  );
  return (data?.data ?? []).map((p) => ({
    source: "semanticscholar" as const,
    externalId: String(p["paperId"] ?? ""),
    title: String(p["title"] ?? ""),
    authors: ((p["authors"] as { name?: string }[]) ?? []).map((a) => a.name ?? ""),
    publishedYear: p["year"] as number | undefined,
    identifier: (p["externalIds"] as { DOI?: string } | undefined)?.DOI,
    synopsis: p["abstract"] as string | undefined,
    url: p["url"] as string | undefined,
  })).filter((w) => w.title);
}

export const CORPORA = {
  openlibrary: searchOpenLibrary,
  googlebooks: searchGoogleBooks,
  crossref: searchCrossref,
  semanticscholar: searchSemanticScholar,
} as const;

export type CorpusName = keyof typeof CORPORA;

/**
 * Fan out across corpora. Degradation is recorded rather than hidden: the
 * caller gets the list of corpora that actually answered, so a partial search
 * is never presented in the ledger as a full one (§14).
 */
export async function searchAll(
  query: string, corpora: CorpusName[], limit = 10,
): Promise<{ works: Work[]; searched: CorpusName[]; failed: CorpusName[] }> {
  const results = await Promise.all(
    corpora.map(async (name) => {
      try {
        return { name, works: await CORPORA[name](query, limit) };
      } catch {
        return { name, works: null };
      }
    }),
  );
  return {
    works: results.flatMap((r) => r.works ?? []),
    searched: results.filter((r) => r.works !== null).map((r) => r.name),
    failed: results.filter((r) => r.works === null).map((r) => r.name),
  };
}
