/**
 * BERT WordPiece tokenizer, built from the model's own `tokenizer.json`.
 *
 * Implemented here rather than pulled in: the tokenizer is part of the pinned
 * pipeline (§2.7), so it has to be a fixed artefact we can hash alongside the
 * weights, not a dependency that can change under a caret range and silently
 * move every score in the corpus.
 */
export interface TokenizerConfig {
  vocab: Record<string, number>;
  lowercase: boolean;
  stripAccents: boolean;
  unkToken: string;
  clsToken: string;
  sepToken: string;
  maxInputCharsPerWord: number;
  continuingPrefix: string;
}

export function loadTokenizer(tokenizerJson: unknown): TokenizerConfig {
  const json = tokenizerJson as {
    model?: { vocab?: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
    normalizer?: { lowercase?: boolean; strip_accents?: boolean | null };
  };
  const vocab = json.model?.vocab;
  if (!vocab) throw new Error("tokenizer.json carries no vocabulary");

  return {
    vocab,
    lowercase: json.normalizer?.lowercase ?? true,
    // BERT-uncased strips accents whenever it lowercases, unless told not to.
    stripAccents: json.normalizer?.strip_accents ?? json.normalizer?.lowercase ?? true,
    unkToken: json.model?.unk_token ?? "[UNK]",
    clsToken: "[CLS]",
    sepToken: "[SEP]",
    maxInputCharsPerWord: json.model?.max_input_chars_per_word ?? 100,
    continuingPrefix: json.model?.continuing_subword_prefix ?? "##",
  };
}

const PUNCTUATION = /[!-/:-@[-`{-~¡-¿‐-⁞]/u;

/** Whitespace split, then punctuation split — BertPreTokenizer's behaviour. */
export function basicTokenize(text: string, config: TokenizerConfig): string[] {
  let normalized = text.normalize("NFD");
  if (config.stripAccents) normalized = normalized.replace(/\p{Mn}/gu, "");
  if (config.lowercase) normalized = normalized.toLowerCase();

  const words: string[] = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (!chunk) continue;
    let current = "";
    for (const char of chunk) {
      if (PUNCTUATION.test(char)) {
        if (current) { words.push(current); current = ""; }
        words.push(char);
      } else {
        current += char;
      }
    }
    if (current) words.push(current);
  }
  return words;
}

/** Greedy longest-match-first WordPiece. */
export function wordpiece(word: string, config: TokenizerConfig): string[] {
  if (word.length > config.maxInputCharsPerWord) return [config.unkToken];

  const pieces: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let match: string | null = null;
    while (start < end) {
      const candidate = start === 0 ? word.slice(start, end) : config.continuingPrefix + word.slice(start, end);
      if (candidate in config.vocab) { match = candidate; break; }
      end -= 1;
    }
    // An unmatchable character anywhere makes the whole word unknown, which is
    // what the reference implementation does — not a partial tokenization.
    if (match === null) return [config.unkToken];
    pieces.push(match);
    start = end;
  }
  return pieces;
}

export function encode(text: string, config: TokenizerConfig, maxTokens: number): number[] {
  const id = (token: string) => config.vocab[token] ?? config.vocab[config.unkToken] ?? 0;
  const body: number[] = [];
  for (const word of basicTokenize(text, config)) {
    for (const piece of wordpiece(word, config)) {
      body.push(id(piece));
      // Leave room for [CLS] and [SEP]; truncation is deterministic.
      if (body.length >= maxTokens - 2) break;
    }
    if (body.length >= maxTokens - 2) break;
  }
  return [id(config.clsToken), ...body, id(config.sepToken)];
}
