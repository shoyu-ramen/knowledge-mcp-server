/**
 * Embedding store, similarity functions, query cache, and persistence.
 * BM25 logic is in bm25.ts, text processing in text.ts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeDocument } from "./loader.js";
import { log } from "./logger.js";
import { getEmbeddingProvider } from "./embedding-provider.js";

// Re-export from bm25.ts and text.ts for backward compatibility
export { tokenize } from "./text.js";
export {
  buildTfIdfIndex,
  bm25Score,
  tfidfScore,
  updateBm25Index,
  type Bm25Index,
  type TfIdfIndex,
} from "./bm25.js";

// --- Embedding vector type ---
type EmbeddingVector = Float32Array | number[];

export interface EmbeddingsStore {
  vectors: Map<string, EmbeddingVector>;
  available: boolean;
  normalized: boolean;
}

export function loadEmbeddings(knowledgeDir: string): EmbeddingsStore {
  const embeddingsPath = join(knowledgeDir, ".embeddings.json");
  if (!existsSync(embeddingsPath)) {
    return { vectors: new Map(), available: false, normalized: true };
  }

  try {
    const raw = JSON.parse(readFileSync(embeddingsPath, "utf-8")) as Record<string, number[]>;
    const vectors = new Map<string, EmbeddingVector>();
    for (const [id, arr] of Object.entries(raw)) {
      vectors.set(id, new Float32Array(arr));
    }
    return { vectors, available: vectors.size > 0, normalized: true };
  } catch {
    return { vectors: new Map(), available: false, normalized: true };
  }
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) return 0;
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

/** Fast dot product for pre-normalized vectors (skips norm computation) */
export function dotProduct(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// --- Query embedding LRU cache (256 entries, ~512KB) ---

const CACHE_MAX = 256;
const queryCache = new Map<string, number[]>();
let cacheProviderKey = "";

function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .trim()
    .replace(/[?!.,;:]+$/g, "")
    .replace(/\s+/g, " ");
}

// --- Exponential backoff for remote API failures ---

let backoffUntil = 0;
let backoffMs = 0;
const BACKOFF_MAX_REMOTE = 60_000;
const BACKOFF_MAX_LOCAL = 5_000;

export async function embedQuery(query: string): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  // Invalidate cache if provider changed (e.g., model upgrade)
  const providerKey = `${provider.name}/${provider.model}`;
  if (providerKey !== cacheProviderKey) {
    queryCache.clear();
    cacheProviderKey = providerKey;
  }

  const key = normalizeQuery(query);
  const cached = queryCache.get(key);
  if (cached) {
    // Move to end (most recently used)
    queryCache.delete(key);
    queryCache.set(key, cached);
    return cached;
  }

  // Check backoff (only applies to remote providers, but harmless for local)
  if (provider.name === "voyage" && Date.now() < backoffUntil) {
    log.debug("embed_query_backoff", { remainingMs: backoffUntil - Date.now() });
    return null;
  }

  try {
    const vector = await provider.embedQuery(query);

    // Reset backoff on success
    backoffMs = 0;
    backoffUntil = 0;

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
    const maxBackoff = provider.name === "voyage" ? BACKOFF_MAX_REMOTE : BACKOFF_MAX_LOCAL;
    backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, maxBackoff);
    backoffUntil = Date.now() + backoffMs;
    return null;
  }
}

// --- Embedding Input Format (shared between inline and batch embedding) ---

// Max characters for embedding input — prevents silent model-level truncation
const MAX_EMBEDDING_CHARS = 4000;

export function buildEmbeddingInput(doc: {
  title: string;
  domain?: string;
  subdomain?: string;
  tags: string[];
  contentBody: string;
}): string {
  const parts: string[] = [];
  if (doc.title) parts.push(doc.title);
  const domainPart = [doc.domain, doc.subdomain].filter(Boolean).join("/");
  if (domainPart) parts.push(`Domain: ${domainPart}`);
  if (doc.tags.length > 0) parts.push(`Tags: ${doc.tags.join(", ")}`);
  parts.push("");
  parts.push(doc.contentBody);
  const text = parts.join("\n");
  return text.length > MAX_EMBEDDING_CHARS ? text.slice(0, MAX_EMBEDDING_CHARS) : text;
}

// --- Inline Embedding ---

export async function embedSingleDocument(
  embeddingsStore: EmbeddingsStore,
  knowledgeDir: string,
  doc: KnowledgeDocument
): Promise<void> {
  const provider = getEmbeddingProvider();
  if (!provider) return;

  // Respect backoff for document embedding too
  if (provider.name === "voyage" && Date.now() < backoffUntil) return;

  try {
    const text = buildEmbeddingInput(doc);
    const vectors = await provider.embedDocuments([text]);
    const vector = vectors[0];
    if (!vector) return;

    backoffMs = 0;
    backoffUntil = 0;

    embeddingsStore.vectors.set(doc.id, new Float32Array(vector));
    embeddingsStore.available = true;
    persistEmbeddings(embeddingsStore, knowledgeDir);
    log.debug("embed_doc", { id: doc.id });
  } catch (err) {
    log.warn("embed_doc_error", { id: doc.id, error: String(err) });
    const maxBackoff = provider.name === "voyage" ? BACKOFF_MAX_REMOTE : BACKOFF_MAX_LOCAL;
    backoffMs = Math.min(backoffMs === 0 ? 1000 : backoffMs * 2, maxBackoff);
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

// --- Helpers to convert Float32Array <-> number[] for JSON serialization ---

function vectorsToJson(vectors: Map<string, EmbeddingVector>): Record<string, number[]> {
  const obj: Record<string, number[]> = {};
  for (const [id, vec] of vectors) {
    obj[id] = vec instanceof Float32Array ? Array.from(vec) : vec;
  }
  return obj;
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
    await writeFile(embeddingsPath, JSON.stringify(vectorsToJson(store.vectors)), "utf-8");
  } catch (err) {
    log.error("flush_embeddings_error", { error: String(err) });
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

// Flush on process exit — use synchronous write in "exit" handler since async is unreliable
process.on("beforeExit", () => {
  flushEmbeddings();
});

process.on("exit", () => {
  if (!pendingFlush) return;
  const { store, knowledgeDir } = pendingFlush;
  pendingFlush = null;
  try {
    const embeddingsPath = join(knowledgeDir, ".embeddings.json");
    writeFileSync(embeddingsPath, JSON.stringify(vectorsToJson(store.vectors)), "utf-8");
  } catch (err) {
    log.error("flush_embeddings_exit_error", { error: String(err) });
  }
});
