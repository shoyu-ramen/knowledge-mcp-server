/**
 * BM25 index and scoring with per-field weighting.
 *
 * Instead of boosting via text repetition (which distorts length normalization),
 * this module computes BM25 independently for title, tags, and body fields,
 * then combines with configurable weights.
 */

import { tokenize } from "./text.js";
import type { KnowledgeDocument } from "./loader.js";

// --- Field weights ---
const FIELD_WEIGHTS = { title: 3.0, tags: 2.0, body: 1.0 } as const;
type FieldName = keyof typeof FIELD_WEIGHTS;
const FIELDS: FieldName[] = ["title", "tags", "body"];

// BM25 scoring constants (defaults, overridable via config)
let BM25_K1 = 1.2;
let BM25_B = 0.75;

/** Configure BM25 parameters. Call before building index. */
export function configureBm25(params: { k1?: number; b?: number }): void {
  if (params.k1 !== undefined) BM25_K1 = params.k1;
  if (params.b !== undefined) BM25_B = params.b;
}

// --- Per-field BM25 Index ---

export interface FieldStats {
  docTermFreqs: Map<string, Map<string, number>>; // docId → term → raw count
  docLengths: Map<string, number>; // docId → token count
  avgDocLength: number;
}

export interface Bm25Index {
  fields: Record<FieldName, FieldStats>;
  docFreq: Map<string, number>; // term → number of docs containing it (across any field)
  idf: Map<string, number>; // term → IDF score
  docCount: number;
}

/** @deprecated Use Bm25Index — kept for backward compatibility */
export type TfIdfIndex = Bm25Index;

// --- IDF computation ---

function computeIdf(docFreq: Map<string, number>, docCount: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    // Standard BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    idf.set(term, Math.log((docCount - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

// --- Tokenize a document's fields ---

function tokenizeField(doc: KnowledgeDocument, field: FieldName): string[] {
  switch (field) {
    case "title":
      return tokenize(doc.title);
    case "tags":
      return tokenize(doc.tags.join(" "));
    case "body":
      return tokenize(doc.contentBody);
  }
}

// --- Build index ---

export function buildTfIdfIndex(docs: Map<string, KnowledgeDocument>): Bm25Index {
  const docFreq = new Map<string, number>();
  const docCount = docs.size;

  // Initialize per-field stats
  const fields: Record<FieldName, FieldStats> = {
    title: { docTermFreqs: new Map(), docLengths: new Map(), avgDocLength: 0 },
    tags: { docTermFreqs: new Map(), docLengths: new Map(), avgDocLength: 0 },
    body: { docTermFreqs: new Map(), docLengths: new Map(), avgDocLength: 0 },
  };

  const fieldTotals: Record<FieldName, number> = { title: 0, tags: 0, body: 0 };

  for (const doc of docs.values()) {
    // Track all unique terms across all fields for this doc (for docFreq)
    const allTermsInDoc = new Set<string>();

    for (const field of FIELDS) {
      const tokens = tokenizeField(doc, field);
      const termFreq = new Map<string, number>();

      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
        allTermsInDoc.add(token);
      }

      fields[field].docTermFreqs.set(doc.id, termFreq);
      fields[field].docLengths.set(doc.id, tokens.length);
      fieldTotals[field] += tokens.length;
    }

    // Update document frequency (term appears in at least one field of this doc)
    for (const term of allTermsInDoc) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  // Compute average doc lengths per field
  for (const field of FIELDS) {
    fields[field].avgDocLength = docCount > 0 ? fieldTotals[field] / docCount : 0;
  }

  const idf = computeIdf(docFreq, docCount);

  return { fields, docFreq, idf, docCount };
}

// --- BM25 scoring ---

export function bm25Score(query: string, docId: string, index: Bm25Index): number {
  const queryTokens = tokenize(query);
  let totalScore = 0;

  for (const field of FIELDS) {
    const fieldStats = index.fields[field];
    const docTerms = fieldStats.docTermFreqs.get(docId);
    if (!docTerms) continue;

    const docLen = fieldStats.docLengths.get(docId) || 0;
    const avgDocLen = fieldStats.avgDocLength || 1;
    let fieldScore = 0;

    for (const token of queryTokens) {
      const tf = docTerms.get(token) || 0;
      const idf = index.idf.get(token) || 0;
      if (tf === 0 || idf === 0) continue;

      // BM25: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / avgDocLen);
      fieldScore += idf * (numerator / denominator);
    }

    totalScore += fieldScore * FIELD_WEIGHTS[field];
  }

  return totalScore;
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
  const hadDoc = index.fields.title.docTermFreqs.has(docId);
  if (hadDoc) {
    // Collect all unique terms from all fields for this doc
    const oldTerms = new Set<string>();
    for (const field of FIELDS) {
      const fieldStats = index.fields[field];
      const oldTermFreqs = fieldStats.docTermFreqs.get(docId);
      if (oldTermFreqs) {
        for (const term of oldTermFreqs.keys()) {
          oldTerms.add(term);
        }
      }
      const oldLength = fieldStats.docLengths.get(docId) || 0;

      fieldStats.docTermFreqs.delete(docId);
      fieldStats.docLengths.delete(docId);

      // Recalculate average document length for this field
      const totalLength = fieldStats.avgDocLength * index.docCount - oldLength;
      fieldStats.avgDocLength = index.docCount > 1 ? totalLength / (index.docCount - 1) : 0;
    }

    // Decrement document frequencies
    for (const term of oldTerms) {
      const df = index.docFreq.get(term);
      if (df !== undefined) {
        if (df <= 1) {
          index.docFreq.delete(term);
        } else {
          index.docFreq.set(term, df - 1);
        }
      }
    }

    index.docCount--;
  }

  // Add new document if provided
  if (doc) {
    const allTermsInDoc = new Set<string>();

    for (const field of FIELDS) {
      const fieldStats = index.fields[field];
      const tokens = tokenizeField(doc, field);
      const termFreq = new Map<string, number>();

      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
        allTermsInDoc.add(token);
      }

      fieldStats.docTermFreqs.set(docId, termFreq);
      fieldStats.docLengths.set(docId, tokens.length);

      // Recalculate average document length for this field
      const totalLength = fieldStats.avgDocLength * index.docCount + tokens.length;
      fieldStats.avgDocLength = totalLength / (index.docCount + 1);
    }

    // Increment document frequencies
    for (const term of allTermsInDoc) {
      index.docFreq.set(term, (index.docFreq.get(term) || 0) + 1);
    }

    index.docCount++;
  }

  // Rebuild IDF (fast — just iterates the docFreq map)
  index.idf = computeIdf(index.docFreq, index.docCount);
}
