import { describe, it, expect } from "vitest";
import { dotProduct, buildEmbeddingInput } from "../src/embeddings.js";

describe("dotProduct", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(dotProduct([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(dotProduct([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for antiparallel unit vectors", () => {
    expect(dotProduct([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(dotProduct([1, 0], [1, 0, 0])).toBe(0);
  });

  it("handles empty vectors", () => {
    expect(dotProduct([], [])).toBe(0);
  });

  it("computes correct value for non-unit vectors", () => {
    // [2, 3] . [4, 5] = 8 + 15 = 23
    expect(dotProduct([2, 3], [4, 5])).toBe(23);
  });
});

describe("buildEmbeddingInput", () => {
  it("includes title, domain, tags, and body", () => {
    const result = buildEmbeddingInput({
      title: "Test Title",
      domain: "technology",
      subdomain: "audio",
      tags: ["ml", "audio"],
      contentBody: "Body content here.",
    });

    expect(result).toContain("Test Title");
    expect(result).toContain("Domain: technology/audio");
    expect(result).toContain("Tags: ml, audio");
    expect(result).toContain("Body content here.");
  });

  it("handles missing optional fields", () => {
    const result = buildEmbeddingInput({
      title: "Title Only",
      tags: [],
      contentBody: "Body.",
    });

    expect(result).toContain("Title Only");
    expect(result).toContain("Body.");
    expect(result).not.toContain("Domain:");
    expect(result).not.toContain("Tags:");
  });

  it("truncates at 4000 characters", () => {
    const longContent = "x".repeat(5000);
    const result = buildEmbeddingInput({
      title: "Title",
      tags: ["tag"],
      contentBody: longContent,
    });

    expect(result.length).toBeLessThanOrEqual(4000);
  });
});
