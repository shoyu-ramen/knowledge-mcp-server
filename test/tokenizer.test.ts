import { describe, it, expect } from "vitest";
import { tokenize } from "../src/embeddings.js";

describe("tokenize", () => {
  it("tokenizes basic text into lowercase tokens", () => {
    const tokens = tokenize("hello world");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
  });

  it("removes stopwords", () => {
    const tokens = tokenize("how does the pitch detection work");
    expect(tokens).not.toContain("how");
    expect(tokens).not.toContain("does");
    expect(tokens).not.toContain("the");
    expect(tokens).toContain("pitch");
    expect(tokens).toContain("detection");
  });

  it("preserves compound terms like c++ and c#", () => {
    const tokens = tokenize("c++ and c# support");
    expect(tokens).toContain("c++");
    expect(tokens).toContain("c#");
  });

  it("adds stemmed tokens alongside originals", () => {
    const tokens = tokenize("organizations");
    expect(tokens).toContain("organizations");
    // Stemmer applies first matching rule: -s → "organization"
    expect(tokens).toContain("organization");
  });

  it("preserves hyphenated compound terms", () => {
    const tokens = tokenize("tf-idf scoring");
    expect(tokens).toContain("tf-idf");
  });

  it("filters single-character tokens from standard tokenization", () => {
    const tokens = tokenize("a b c hello");
    // "a" is a stopword, "b" and "c" are filtered (length <= 1)
    expect(tokens).not.toContain("b");
    expect(tokens).not.toContain("c");
    expect(tokens).toContain("hello");
  });

  it("normalizes case", () => {
    const tokens = tokenize("CREPE Model");
    expect(tokens).toContain("crepe");
    expect(tokens).toContain("model");
  });
});
