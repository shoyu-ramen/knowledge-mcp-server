import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeDocument } from "./loader.js";
import { log } from "./logger.js";

export interface EmbeddingsStore {
  vectors: Map<string, number[]>;
  available: boolean;
}

export function loadEmbeddings(knowledgeDir: string): EmbeddingsStore {
  const embeddingsPath = join(knowledgeDir, ".embeddings.json");
  if (!existsSync(embeddingsPath)) {
    return { vectors: new Map(), available: false };
  }

  try {
    const raw = JSON.parse(readFileSync(embeddingsPath, "utf-8")) as Record<string, number[]>;
    const vectors = new Map(Object.entries(raw));
    return { vectors, available: vectors.size > 0 };
  } catch {
    return { vectors: new Map(), available: false };
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Query embedding LRU cache (256 entries, ~512KB) ---

const CACHE_MAX = 256;
const queryCache = new Map<string, number[]>();

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

// --- Exponential backoff for Voyage API failures ---

let backoffUntil = 0;
let backoffMs = 0;
const BACKOFF_MAX = 60_000;

export async function embedQuery(query: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  const key = normalizeQuery(query);
  const cached = queryCache.get(key);
  if (cached) {
    // Move to end (most recently used)
    queryCache.delete(key);
    queryCache.set(key, cached);
    return cached;
  }

  // Check backoff
  if (Date.now() < backoffUntil) {
    log.debug("embed_query_backoff", { remainingMs: backoffUntil - Date.now() });
    return null;
  }

  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-3-lite",
        input: [query],
        input_type: "query",
      }),
    });

    if (!response.ok) {
      log.warn("embed_query_failed", { status: response.status, statusText: response.statusText });
      backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, BACKOFF_MAX);
      backoffUntil = Date.now() + backoffMs;
      return null;
    }

    // Reset backoff on success
    backoffMs = 0;
    backoffUntil = 0;

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    const vector = data.data[0]?.embedding ?? null;
    if (vector) {
      // Evict oldest if at capacity
      if (queryCache.size >= CACHE_MAX) {
        const oldest = queryCache.keys().next().value!;
        queryCache.delete(oldest);
      }
      queryCache.set(key, vector);
    }
    return vector;
  } catch (err) {
    log.warn("embed_query_error", { error: String(err) });
    backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, BACKOFF_MAX);
    backoffUntil = Date.now() + backoffMs;
    return null;
  }
}

// --- Lightweight suffix stemmer (~18 rules, no dependencies) ---

function stem(word: string): string {
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

const STOPWORDS = new Set([
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

// --- BM25 Index ---

export interface Bm25Index {
  docTermFreqs: Map<string, Map<string, number>>; // docId → term → raw count
  docFreq: Map<string, number>; // term → number of docs containing it
  idf: Map<string, number>; // term → IDF score
  docLengths: Map<string, number>; // docId → token count
  avgDocLength: number;
  docCount: number;
}

/** @deprecated Use Bm25Index — kept for backward compatibility */
export type TfIdfIndex = Bm25Index;

function computeIdf(docFreq: Map<string, number>, docCount: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    // Standard BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    idf.set(term, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

export function buildTfIdfIndex(docs: Map<string, KnowledgeDocument>): Bm25Index {
  const docTermFreqs = new Map<string, Map<string, number>>();
  const docFreq = new Map<string, number>();
  const docLengths = new Map<string, number>();
  const docCount = docs.size;
  let totalLength = 0;

  for (const doc of docs.values()) {
    // Title tokens 3x, tag tokens 2x, body 1x for field boosting
    const text = buildBoostedText(doc);
    const tokens = tokenize(text);
    const termFreq = new Map<string, number>();
    const seenTerms = new Set<string>();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
      if (!seenTerms.has(token)) {
        seenTerms.add(token);
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }

    // Store raw term counts (no normalization — BM25 handles length internally)
    docTermFreqs.set(doc.id, termFreq);
    docLengths.set(doc.id, tokens.length);
    totalLength += tokens.length;
  }

  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;
  const idf = computeIdf(docFreq, docCount);

  return { docTermFreqs, docFreq, idf, docLengths, avgDocLength, docCount };
}

// --- Field boosting: title 3x, tags 2x, body 1x ---

function buildBoostedText(doc: KnowledgeDocument): string {
  const title = doc.title;
  const tags = doc.tags.join(" ");
  return `${title} ${title} ${title} ${tags} ${tags} ${doc.contentBody}`;
}

// BM25 scoring constants
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function bm25Score(query: string, docId: string, index: Bm25Index): number {
  const queryTokens = tokenize(query);
  const docTerms = index.docTermFreqs.get(docId);
  if (!docTerms) return 0;

  const docLen = index.docLengths.get(docId) || 0;
  let score = 0;

  for (const token of queryTokens) {
    const tf = docTerms.get(token) || 0;
    const idf = index.idf.get(token) || 0;
    if (tf === 0 || idf === 0) continue;

    // BM25: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / (index.avgDocLength || 1));
    score += idf * (numerator / denominator);
  }

  return score;
}

/** @deprecated Use bm25Score — kept for backward compatibility */
export const tfidfScore = bm25Score;

// --- Incremental Index Updates ---

export function updateBm25Index(
  index: Bm25Index,
  docId: string,
  doc: KnowledgeDocument | null
): void {
  // Remove old document if it exists in the index
  const oldTermFreqs = index.docTermFreqs.get(docId);
  if (oldTermFreqs) {
    const oldLength = index.docLengths.get(docId) || 0;

    // Decrement document frequencies for each term
    for (const term of oldTermFreqs.keys()) {
      const df = index.docFreq.get(term);
      if (df !== undefined) {
        if (df <= 1) {
          index.docFreq.delete(term);
        } else {
          index.docFreq.set(term, df - 1);
        }
      }
    }

    index.docTermFreqs.delete(docId);
    index.docLengths.delete(docId);
    index.docCount--;

    // Recalculate average document length
    const totalLength = index.avgDocLength * (index.docCount + 1) - oldLength;
    index.avgDocLength = index.docCount > 0 ? totalLength / index.docCount : 0;
  }

  // Add new document if provided
  if (doc) {
    const text = buildBoostedText(doc);
    const tokens = tokenize(text);
    const termFreq = new Map<string, number>();
    const seenTerms = new Set<string>();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
      if (!seenTerms.has(token)) {
        seenTerms.add(token);
        index.docFreq.set(token, (index.docFreq.get(token) || 0) + 1);
      }
    }

    index.docTermFreqs.set(docId, termFreq);
    index.docLengths.set(docId, tokens.length);

    // Recalculate average document length
    const totalLength = index.avgDocLength * index.docCount + tokens.length;
    index.docCount++;
    index.avgDocLength = totalLength / index.docCount;
  }

  // Rebuild IDF (fast — just iterates the docFreq map)
  index.idf = computeIdf(index.docFreq, index.docCount);
}

// --- Inline Embedding ---

export async function embedSingleDocument(
  embeddingsStore: EmbeddingsStore,
  knowledgeDir: string,
  doc: KnowledgeDocument
): Promise<void> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return;

  // Respect backoff for document embedding too
  if (Date.now() < backoffUntil) return;

  try {
    const text = `${doc.title}\n${doc.tags.join(", ")}\n${doc.contentBody}`;
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-3-lite",
        input: [text],
        input_type: "document",
      }),
    });

    if (!response.ok) {
      log.warn("embed_doc_failed", { id: doc.id, status: response.status });
      backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, BACKOFF_MAX);
      backoffUntil = Date.now() + backoffMs;
      return;
    }

    backoffMs = 0;
    backoffUntil = 0;

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    const vector = data.data[0]?.embedding;
    if (!vector) return;

    embeddingsStore.vectors.set(doc.id, vector);
    embeddingsStore.available = true;
    persistEmbeddings(embeddingsStore, knowledgeDir);
    log.debug("embed_doc", { id: doc.id });
  } catch (err) {
    log.warn("embed_doc_error", { id: doc.id, error: String(err) });
    backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, BACKOFF_MAX);
    backoffUntil = Date.now() + backoffMs;
  }
}

export function removeEmbedding(
  embeddingsStore: EmbeddingsStore,
  knowledgeDir: string,
  docId: string
): void {
  if (embeddingsStore.vectors.delete(docId)) {
    embeddingsStore.available = embeddingsStore.vectors.size > 0;
    persistEmbeddings(embeddingsStore, knowledgeDir);
  }
}

// --- Debounced async embedding persistence ---

let pendingFlush: { store: EmbeddingsStore; knowledgeDir: string } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function flushEmbeddings(): Promise<void> {
  if (!pendingFlush) return;
  const { store, knowledgeDir } = pendingFlush;
  pendingFlush = null;
  try {
    const embeddingsPath = join(knowledgeDir, ".embeddings.json");
    const obj: Record<string, number[]> = {};
    for (const [id, vec] of store.vectors) {
      obj[id] = vec;
    }
    await writeFile(embeddingsPath, JSON.stringify(obj), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

function persistEmbeddings(store: EmbeddingsStore, knowledgeDir: string): void {
  pendingFlush = { store, knowledgeDir };
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushEmbeddings();
  }, 5000);
}

// Flush on process exit
process.on("beforeExit", () => {
  flushEmbeddings();
});
