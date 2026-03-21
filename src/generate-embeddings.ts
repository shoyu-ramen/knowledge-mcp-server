/**
 * Generate embeddings for all knowledge documents using Voyage AI.
 * Writes to <knowledge-dir>/.embeddings.json
 *
 * Skips documents whose content hash hasn't changed since last run.
 * Reads knowledge.config.yaml for embedding provider settings if present.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { collectMarkdownFiles } from "./loader.js";

interface EmbeddingConfig {
  model: string;
  apiKeyEnv: string;
}

function loadEmbeddingConfig(knowledgeDir: string): EmbeddingConfig {
  const configPath = join(knowledgeDir, "knowledge.config.yaml");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const embeddings = parsed?.embeddings as Record<string, string> | undefined;
    return {
      model: embeddings?.model || "voyage-3-lite",
      apiKeyEnv: embeddings?.api_key_env || "VOYAGE_API_KEY",
    };
  } catch {
    return { model: "voyage-3-lite", apiKeyEnv: "VOYAGE_API_KEY" };
  }
}

interface DocFrontmatter {
  id?: string;
  title?: string;
  domain?: string;
  subdomain?: string;
  tags?: string[];
  body: string;
}

function parseFrontmatter(raw: string): DocFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: raw };
  const fm = parseYaml(match[1]) as Record<string, unknown>;
  return {
    id: fm.id as string | undefined,
    title: fm.title as string | undefined,
    domain: fm.domain as string | undefined,
    subdomain: fm.subdomain as string | undefined,
    tags: fm.tags as string[] | undefined,
    body: match[2].trim(),
  };
}

function buildEmbeddingInput(doc: DocFrontmatter): string {
  const parts: string[] = [];
  if (doc.title) parts.push(doc.title);
  const domainPart = [doc.domain, doc.subdomain].filter(Boolean).join("/");
  if (domainPart) parts.push(`Domain: ${domainPart}`);
  if (doc.tags?.length) parts.push(`Tags: ${doc.tags.join(", ")}`);
  parts.push("");
  parts.push(doc.body);
  return parts.join("\n");
}

interface DocForEmbedding {
  id: string;
  text: string;
  hash: string;
}

async function embedBatch(
  texts: string[],
  model: string,
  apiKey: string
): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: texts,
      input_type: "document",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage AI API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
    usage: { total_tokens: number };
  };
  console.log(`  Batch embedded: ${texts.length} docs, ${data.usage.total_tokens} tokens`);
  return data.data.map((d) => d.embedding);
}

export async function generateEmbeddings(knowledgeDir: string): Promise<void> {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  const embeddingConfig = loadEmbeddingConfig(knowledgeDir);
  const embeddingsPath = join(knowledgeDir, ".embeddings.json");
  const hashesPath = join(knowledgeDir, ".embeddings-hashes.json");

  const apiKey = process.env[embeddingConfig.apiKeyEnv];
  if (!apiKey) {
    console.error(`Error: ${embeddingConfig.apiKeyEnv} environment variable is required`);
    process.exit(1);
  }

  console.log(`Knowledge dir: ${knowledgeDir}`);
  console.log(`Embedding model: ${embeddingConfig.model}`);

  // Load existing embeddings and hashes
  let existingEmbeddings: Record<string, number[]> = {};
  let existingHashes: Record<string, string> = {};
  if (existsSync(embeddingsPath)) {
    existingEmbeddings = JSON.parse(readFileSync(embeddingsPath, "utf-8"));
  }
  if (existsSync(hashesPath)) {
    existingHashes = JSON.parse(readFileSync(hashesPath, "utf-8"));
  }

  // Collect all docs
  const files = collectMarkdownFiles(knowledgeDir);
  const docs: DocForEmbedding[] = [];

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed.id) continue;

    const text = buildEmbeddingInput(parsed);
    const hash = createHash("sha256").update(text).digest("hex");

    docs.push({ id: parsed.id, text, hash });
  }

  console.log(`Found ${docs.length} documents`);

  // Find docs that need (re-)embedding
  const toEmbed = docs.filter(
    (d) => !existingHashes[d.id] || existingHashes[d.id] !== d.hash
  );

  console.log(`${toEmbed.length} documents need embedding (${docs.length - toEmbed.length} cached)`);

  if (toEmbed.length === 0) {
    console.log("All embeddings up to date!");
    return;
  }

  // Embed in batches of 20
  const BATCH_SIZE = 20;
  const newEmbeddings: Record<string, number[]> = { ...existingEmbeddings };
  const newHashes: Record<string, string> = { ...existingHashes };

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    console.log(
      `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)}...`
    );

    const vectors = await embedBatch(
      batch.map((d) => d.text),
      embeddingConfig.model,
      apiKey
    );
    for (let j = 0; j < batch.length; j++) {
      newEmbeddings[batch[j].id] = vectors[j];
      newHashes[batch[j].id] = batch[j].hash;
    }
  }

  // Remove embeddings for deleted docs
  const validIds = new Set(docs.map((d) => d.id));
  for (const id of Object.keys(newEmbeddings)) {
    if (!validIds.has(id)) {
      delete newEmbeddings[id];
      delete newHashes[id];
    }
  }

  // Write output
  writeFileSync(embeddingsPath, JSON.stringify(newEmbeddings));
  writeFileSync(hashesPath, JSON.stringify(newHashes));

  console.log(`\nDone! Wrote ${Object.keys(newEmbeddings).length} embeddings to ${embeddingsPath}`);
}
