import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initEmbeddingProvider,
  getEmbeddingProvider,
  resetEmbeddingProvider,
  LocalProvider,
  VoyageProvider,
} from "../src/embedding-provider.js";
import { cosineSimilarity } from "../src/embeddings.js";

describe("initEmbeddingProvider", () => {
  afterEach(() => {
    resetEmbeddingProvider();
    vi.unstubAllEnvs();
  });

  it("creates LocalProvider with no config", () => {
    initEmbeddingProvider(undefined);
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("local");
    expect(provider!.model).toBe("BAAI/bge-small-en-v1.5");
    expect(provider!.dimensions).toBe(384);
  });

  it("creates LocalProvider with explicit local provider", () => {
    initEmbeddingProvider({ provider: "local" });
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("local");
  });

  it("creates VoyageProvider when configured with API key", () => {
    vi.stubEnv("VOYAGE_API_KEY", "test-key");
    initEmbeddingProvider({ provider: "voyage" });
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("voyage");
    expect(provider!.model).toBe("voyage-3-lite");
  });

  it("creates VoyageProvider with custom model and env var", () => {
    vi.stubEnv("MY_KEY", "test-key");
    initEmbeddingProvider({ provider: "voyage", model: "voyage-3", api_key_env: "MY_KEY" });
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("voyage");
    expect(provider!.model).toBe("voyage-3");
    expect(provider!.dimensions).toBe(1024);
  });

  it("returns null when voyage configured without API key", () => {
    delete process.env.VOYAGE_API_KEY;
    initEmbeddingProvider({ provider: "voyage" });
    const provider = getEmbeddingProvider();
    expect(provider).toBeNull();
  });

  it("resetEmbeddingProvider clears the provider", () => {
    initEmbeddingProvider(undefined);
    expect(getEmbeddingProvider()).not.toBeNull();
    resetEmbeddingProvider();
    expect(getEmbeddingProvider()).toBeNull();
  });
});

describe("VoyageProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("embedQuery sends input_type query", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });

    const provider = new VoyageProvider("voyage-3-lite", "test-key");
    const result = await provider.embedQuery("test query");

    expect(result).toEqual([0.1, 0.2, 0.3]);
    capturedBody = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(capturedBody.input_type).toBe("query");
    expect(capturedBody.model).toBe("voyage-3-lite");
  });

  it("embedDocuments sends input_type document", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { embedding: [0.1, 0.2] },
          { embedding: [0.3, 0.4] },
        ],
      }),
    });

    const provider = new VoyageProvider("voyage-3-lite", "test-key");
    const result = await provider.embedDocuments(["doc1", "doc2"]);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    capturedBody = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(capturedBody.input_type).toBe("document");
    expect(capturedBody.input).toEqual(["doc1", "doc2"]);
  });

  it("embedQuery returns null on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });

    const provider = new VoyageProvider("voyage-3-lite", "test-key");
    const result = await provider.embedQuery("test");

    expect(result).toBeNull();
  });
});

describe("cosineSimilarity dimension guard", () => {
  it("returns 0 for mismatched dimensions", () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.1, 0.2, 0.3, 0.4];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("computes correctly for matching dimensions", () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });
});
