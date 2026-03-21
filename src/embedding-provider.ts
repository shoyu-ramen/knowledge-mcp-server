/**
 * Embedding provider abstraction.
 * Supports local (Transformers.js) and Voyage AI providers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

export interface EmbeddingProvider {
  readonly name: "local" | "voyage";
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[] | null>;
}

// --- Known local model dimensions ---

const LOCAL_MODEL_DIMS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "nomic-ai/nomic-embed-text-v1.5": 768,
};

const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_LOCAL_DIMS = 384;

// --- Local Provider (Transformers.js) ---

type Pipeline = (texts: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

export class LocalProvider implements EmbeddingProvider {
  readonly name = "local" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly cacheDir: string | undefined;
  private pipeline: Pipeline | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(model?: string, cacheDir?: string) {
    this.model = model || DEFAULT_LOCAL_MODEL;
    this.dimensions = LOCAL_MODEL_DIMS[this.model] ?? DEFAULT_LOCAL_DIMS;
    this.cacheDir = cacheDir
      || process.env.TRANSFORMERS_CACHE
      || join(homedir(), ".cache", "knowledge-mcp-server", "models");
  }

  private async loadPipeline(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.cacheDir) {
        env.cacheDir = this.cacheDir;
      }
      // Disable remote model fetching fallback to browser cache
      env.allowLocalModels = true;
      this.pipeline = (await pipeline("feature-extraction", this.model, {
        dtype: "fp32",
      })) as unknown as Pipeline;
      log.info("local_embedding_model_loaded", { model: this.model, dimensions: this.dimensions });
    })();
    await this.initPromise;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    await this.loadPipeline();
    const output = await this.pipeline!(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  async embedQuery(text: string): Promise<number[] | null> {
    try {
      await this.loadPipeline();
      const output = await this.pipeline!([text], { pooling: "mean", normalize: true });
      return output.tolist()[0];
    } catch (err) {
      log.warn("local_embed_query_error", { error: String(err) });
      return null;
    }
  }
}

// --- Voyage Provider ---

export class VoyageProvider implements EmbeddingProvider {
  readonly name = "voyage" as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
    // voyage-3-lite = 512, voyage-3 = 1024
    this.dimensions = model.includes("lite") ? 512 : 1024;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
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
    };
    return data.data.map((d) => d.embedding);
  }

  async embedQuery(text: string): Promise<number[] | null> {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: [text],
        input_type: "query",
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data[0]?.embedding ?? null;
  }
}

// --- Module-level singleton ---

let activeProvider: EmbeddingProvider | null = null;

export function initEmbeddingProvider(
  config?: {
    provider?: string;
    model?: string;
    api_key_env?: string;
    cache_dir?: string;
  }
): void {
  if (config?.provider === "voyage") {
    const envVar = config.api_key_env || "VOYAGE_API_KEY";
    const apiKey = process.env[envVar];
    if (!apiKey) {
      log.warn("embedding_provider", {
        message: `Voyage provider configured but ${envVar} not set. Embeddings disabled.`,
      });
      activeProvider = null;
      return;
    }
    const model = config.model || "voyage-3-lite";
    activeProvider = new VoyageProvider(model, apiKey);
    log.info("embedding_provider", { provider: "voyage", model });
    return;
  }

  // Default: local provider
  const model = config?.provider === "local" ? (config.model || undefined) : undefined;
  activeProvider = new LocalProvider(model, config?.cache_dir);
  log.info("embedding_provider", { provider: "local", model: activeProvider.model });
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  return activeProvider;
}

/** Reset provider — for testing only */
export function resetEmbeddingProvider(): void {
  activeProvider = null;
}
