/**
 * Metadata sidecar for tracking which provider/model generated the embeddings.
 * Used to detect provider changes and force full re-embedding.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
  createdAt: string;
}

const META_FILENAME = ".embeddings-meta.json";

export function loadEmbeddingMeta(knowledgeDir: string): EmbeddingMeta | null {
  const metaPath = join(knowledgeDir, META_FILENAME);
  if (!existsSync(metaPath)) return null;

  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as EmbeddingMeta;
  } catch {
    return null;
  }
}

export function saveEmbeddingMeta(knowledgeDir: string, meta: EmbeddingMeta): void {
  const metaPath = join(knowledgeDir, META_FILENAME);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}
