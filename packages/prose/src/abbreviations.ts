/**
 * Abbreviation guard for sentence segmentation (§2.2).
 *
 * ALWAYS_MERGE: a period here is essentially never a sentence end, and what
 * follows is normally a capitalised name — so we cannot use "next token is
 * capitalised" to decide. Merge unconditionally.
 */
export const ALWAYS_MERGE = new Set([
  "Mr", "Mrs", "Ms", "Mx", "Dr", "Prof", "Rev", "Fr", "Sr", "Jr", "St",
  "Capt", "Cpt", "Lt", "Sgt", "Cpl", "Maj", "Col", "Gen", "Adm", "Cmdr",
  "Hon", "Gov", "Sen", "Rep", "Pres", "Supt", "Det", "Insp",
  "Ave", "Blvd", "Rd", "Ln", "Mt", "Ft", "Pt", "Sq",
  "Messrs", "Mmes", "Esq", "Ph", "Sta", "Ste",
]);

/**
 * AMBIGUOUS: genuinely can end a sentence ("...oranges, etc. Then she left.").
 * Merge only when the following text starts lowercase, which is the signal
 * that the sentence is continuing.
 */
export const AMBIGUOUS = new Set([
  "etc", "al", "vs", "v", "cf", "approx", "est", "ca", "circa",
  "eg", "ie", "No", "no", "Nos", "Vol", "vol", "pp", "ed", "Ed", "trans",
  "Inc", "Ltd", "Co", "Corp", "Dept", "Univ", "Assn", "Bros",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sept", "Sep", "Oct", "Nov", "Dec",
  "Mon", "Tue", "Tues", "Wed", "Thu", "Thurs", "Fri", "Sat", "Sun",
]);

/** "e.g." / "i.e." / "a.m." — dotted forms arrive with internal periods intact. */
export const DOTTED = new Set(["e.g", "i.e", "a.m", "p.m", "U.S", "U.K", "U.N", "A.D", "B.C"]);

/** Single capital + period: an initial, as in "J. R. R. Tolkien". */
export function isInitial(token: string): boolean {
  return /^[A-Z]$/.test(token);
}
