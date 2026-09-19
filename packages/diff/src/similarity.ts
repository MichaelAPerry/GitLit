/** Token set for similarity. Case- and punctuation-insensitive. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []);
}

/**
 * Token-level Dice coefficient with multiplicity. Used for span retention
 * (§7.3) and for pairing a deleted sentence with the insert that replaced it.
 */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c && c > 0) { overlap++; counts.set(t, c - 1); }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

/** Character n-gram containment — catches near-verbatim carryover (§9.1). */
export function containment(needle: string, haystack: string, n = 5): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, " ").trim();
    const set = new Set<string>();
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  };
  const a = grams(needle);
  if (a.size === 0) return 0;
  const b = grams(haystack);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}
