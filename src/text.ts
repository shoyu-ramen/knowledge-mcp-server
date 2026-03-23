/**
 * Text processing utilities: stemmer, stopwords, and tokenizer.
 * Extracted from embeddings.ts for modularity.
 */

// --- Lightweight suffix stemmer (~18 rules, no dependencies) ---

export function stem(word: string): string {
  if (word.length < 4) return word;

  const rules: Array<[string, string]> = [
    ["ization", "ize"],
    ["ational", "ate"],
    ["iveness", "ive"],
    ["encies", "ency"],
    ["ation", "ate"],
    ["ness", ""],
    ["ment", ""],
    ["able", ""],
    ["ible", ""],
    ["ling", "le"],
    ["ies", "y"],
    ["ive", ""],
    ["ing", ""],
    ["ion", ""],
    ["ed", ""],
    ["ly", ""],
    ["er", ""],
    ["s", ""],
  ];

  for (const [suffix, replacement] of rules) {
    if (word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length) + replacement;
      if (base.length >= 3) return base;
    }
  }

  return word;
}

// --- Stopword set (filtered during BM25 tokenization, not embedding text) ---

export const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "get",
  "got",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "might",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "us",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "will",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

// --- Tokenizer (preserves compound terms, adds stems alongside originals) ---

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // Extract compound terms before stripping special chars (e.g., c++, c#)
  const compoundRegex = /[a-z][a-z0-9]*\+\+|[a-z]#/g;
  let match;
  while ((match = compoundRegex.exec(lower)) !== null) {
    tokens.push(match[0]);
  }

  // Standard tokenization (preserve hyphens for compound words like tf-idf)
  const standard = lower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  for (const token of standard) {
    if (STOPWORDS.has(token)) continue;
    tokens.push(token);
    const stemmed = stem(token);
    if (stemmed !== token) {
      tokens.push(stemmed);
    }
  }

  return tokens;
}
