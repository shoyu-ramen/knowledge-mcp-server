/**
 * Generate embeddings for all knowledge documents.
 * Writes to <knowledge-dir>/.embeddings.json
 *
 * Supports local (Transformers.js) and Voyage AI providers.
 * Skips documents whose content hash hasn't changed since last run.
 * Reads knowledge.config.yaml for embedding provider settings if present.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collectMarkdownFiles, parseFrontmatter } from "./loader.js";
import { type EmbeddingProvider, LocalProvider, VoyageProvider } from "./embedding-provider.js";
import { loadEmbeddingMeta, saveEmbeddingMeta } from "./embedding-meta.js";
import { buildEmbeddingInput } from "./embeddings.js";
import { loadConfig } from "./config.js";

interface DocForEmbedding {
  id: string;
  text: string;
  hash: string;
}

function resolveProvider(knowledgeDir: string): EmbeddingProvider {
  let provider: string | undefined;
  let model: string | undefined;
  let apiKeyEnv: string | undefined;
  let cacheDir: string | undefined;

  try {
    const config = loadConfig(knowledgeDir);
    if (config?.embeddings) {
      provider = config.embeddings.provider;
      model = config.embeddings.model;
      apiKeyEnv = config.embeddings.api_key_env;
      cacheDir = config.embeddings.cache_dir;
    }
  } catch {
    // No config — use defaults
  }

  if (provider === "voyage") {
    const envVar = apiKeyEnv || "VOYAGE_API_KEY";
    const apiKey = process.env[envVar];
    if (!apiKey) {
      console.error(`Error: ${envVar} environment variable is required for Voyage provider`);
      process.exit(1);
    }
    return new VoyageProvider(model || "voyage-3-lite", apiKey);
  }

  // Default: local provider
  console.log("Using local embedding model (no API key required)");
  return new LocalProvider(model, cacheDir);
}

export async function generateEmbeddings(knowledgeDir: string): Promise<void> {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  const provider = resolveProvider(knowledgeDir);
  const embeddingsPath = join(knowledgeDir, ".embeddings.json");
  const hashesPath = join(knowledgeDir, ".embeddings-hashes.json");

  console.log(`Knowledge dir: ${knowledgeDir}`);
  console.log(
    `Embedding provider: ${provider.name} (${provider.model}, ${provider.dimensions} dims)`
  );

  // Load existing embeddings and hashes
  let existingEmbeddings: Record<string, number[]> = {};
  let existingHashes: Record<string, string> = {};
  if (existsSync(embeddingsPath)) {
    existingEmbeddings = JSON.parse(readFileSync(embeddingsPath, "utf-8"));
  }
  if (existsSync(hashesPath)) {
    existingHashes = JSON.parse(readFileSync(hashesPath, "utf-8"));
  }

  // Check for provider/model change — force full re-embed if mismatched
  const meta = loadEmbeddingMeta(knowledgeDir);
  if (meta && (meta.provider !== provider.name || meta.model !== provider.model)) {
    console.log(
      `Provider changed from ${meta.provider}/${meta.model} to ${provider.name}/${provider.model} — full re-embedding required`
    );
    existingEmbeddings = {};
    existingHashes = {};
  }

  // Collect all docs
  const files = collectMarkdownFiles(knowledgeDir);
  const docs: DocForEmbedding[] = [];

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!frontmatter.id) continue;

    const text = buildEmbeddingInput({
      title: (frontmatter.title as string) ?? "",
      domain: frontmatter.domain as string | undefined,
      subdomain: frontmatter.subdomain as string | undefined,
      tags: (frontmatter.tags as string[]) ?? [],
      contentBody: body,
    });
    const hash = createHash("sha256").update(text).digest("hex");

    docs.push({ id: frontmatter.id as string, text, hash });
  }

  console.log(`Found ${docs.length} documents`);

  // Find docs that need (re-)embedding
  const toEmbed = docs.filter((d) => !existingHashes[d.id] || existingHashes[d.id] !== d.hash);

  console.log(
    `${toEmbed.length} documents need embedding (${docs.length - toEmbed.length} cached)`
  );

  if (toEmbed.length === 0) {
    console.log("All embeddings up to date!");
    return;
  }

  // Batch size: smaller for local (CPU-bound), larger for API
  const BATCH_SIZE = provider.name === "local" ? 8 : 20;
  const newEmbeddings: Record<string, number[]> = { ...existingEmbeddings };
  const newHashes: Record<string, string> = { ...existingHashes };

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    console.log(
      `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)}...`
    );

    const vectors = await provider.embedDocuments(batch.map((d) => d.text));
    for (let j = 0; j < batch.length; j++) {
      if (j < vectors.length && vectors[j]) {
        newEmbeddings[batch[j].id] = vectors[j];
        newHashes[batch[j].id] = batch[j].hash;
      }
    }
  }

  // Remove embeddings for deleted docs
  const validIds = new Set(docs.map((d) => d.id));
  for (const id of Object.keys(newEmbeddings)) {
    if (!validIds.has(id)) {
      Reflect.deleteProperty(newEmbeddings, id);
      Reflect.deleteProperty(newHashes, id);
    }
  }

  // Write output
  writeFileSync(embeddingsPath, JSON.stringify(newEmbeddings));
  writeFileSync(hashesPath, JSON.stringify(newHashes));

  // Write metadata sidecar
  saveEmbeddingMeta(knowledgeDir, {
    provider: provider.name,
    model: provider.model,
    dimensions: provider.dimensions,
    createdAt: new Date().toISOString(),
  });

  console.log(`\nDone! Wrote ${Object.keys(newEmbeddings).length} embeddings to ${embeddingsPath}`);
}
