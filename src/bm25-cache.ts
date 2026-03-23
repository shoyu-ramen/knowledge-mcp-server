/**
 * BM25 index persistence — serialize/deserialize to disk for fast startup.
 * Uses a content hash to detect when the cache is stale.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { KnowledgeDocument } from "./loader.js";
import type { Bm25Index, FieldStats } from "./bm25.js";
import { log } from "./logger.js";

const CACHE_FILENAME = ".bm25-cache.json";
const CACHE_VERSION = 2; // Bump when index format changes (v2 = per-field)

interface SerializedFieldStats {
  docTermFreqs: Array<[string, Array<[string, number]>]>;
  docLengths: Array<[string, number]>;
  avgDocLength: number;
}

interface SerializedCache {
  version: number;
  docHash: string;
  docCount: number;
  docFreq: Array<[string, number]>;
  idf: Array<[string, number]>;
  fields: Record<string, SerializedFieldStats>;
}

/** Compute a hash of all document IDs + lastUpdated to detect staleness. */
export function computeDocHash(docs: Map<string, KnowledgeDocument>): string {
  const hash = createHash("sha256");
  // Sort by ID for deterministic hashing
  const sorted = [...docs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, doc] of sorted) {
    hash.update(`${id}:${doc.lastUpdated ?? ""}:${doc.wordCount}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Try to load a cached BM25 index. Returns null if missing, stale, or corrupt. */
export function loadBm25Cache(knowledgeDir: string, docHash: string): Bm25Index | null {
  const cachePath = join(knowledgeDir, CACHE_FILENAME);
  if (!existsSync(cachePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as SerializedCache;
    if (raw.version !== CACHE_VERSION || raw.docHash !== docHash) {
      log.debug("bm25_cache_stale", { cached: raw.docHash, current: docHash });
      return null;
    }

    const fields: Record<string, FieldStats> = {};
    for (const [fieldName, serialized] of Object.entries(raw.fields)) {
      fields[fieldName] = {
        docTermFreqs: new Map(
          serialized.docTermFreqs.map(([docId, terms]) => [docId, new Map(terms)])
        ),
        docLengths: new Map(serialized.docLengths),
        avgDocLength: serialized.avgDocLength,
      };
    }

    const index: Bm25Index = {
      fields: fields as Bm25Index["fields"],
      docFreq: new Map(raw.docFreq),
      idf: new Map(raw.idf),
      docCount: raw.docCount,
    };

    log.info("bm25_cache_loaded", { docs: index.docCount });
    return index;
  } catch (err) {
    log.debug("bm25_cache_error", { error: String(err) });
    return null;
  }
}

/** Save the BM25 index to disk. */
export function saveBm25Cache(knowledgeDir: string, index: Bm25Index, docHash: string): void {
  const cachePath = join(knowledgeDir, CACHE_FILENAME);

  const fields: Record<string, SerializedFieldStats> = {};
  for (const [fieldName, stats] of Object.entries(index.fields)) {
    fields[fieldName] = {
      docTermFreqs: [...stats.docTermFreqs.entries()].map(([docId, terms]) => [
        docId,
        [...terms.entries()],
      ]),
      docLengths: [...stats.docLengths.entries()],
      avgDocLength: stats.avgDocLength,
    };
  }

  const cache: SerializedCache = {
    version: CACHE_VERSION,
    docHash,
    docCount: index.docCount,
    docFreq: [...index.docFreq.entries()],
    idf: [...index.idf.entries()],
    fields,
  };

  try {
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
    log.debug("bm25_cache_saved", { docs: index.docCount });
  } catch (err) {
    log.warn("bm25_cache_save_error", { error: String(err) });
  }
}
