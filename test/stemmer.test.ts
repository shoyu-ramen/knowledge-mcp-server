import { describe, it, expect } from "vitest";
import { tokenize } from "../src/text.js";

// The stem function is private, so we test it indirectly via tokenize
// which includes both original and stemmed forms
function getStemmed(word: string): string[] {
  const tokens = tokenize(word);
  // The first token from standard path is the original, the second (if different) is the stem
  return tokens.filter((t) => t !== word.toLowerCase());
}

describe("stemmer", () => {
  it("applies -ization rule", () => {
    expect(getStemmed("optimization")).toContain("optimize");
  });

  it("applies -ies rule", () => {
    expect(getStemmed("frequencies")).toContain("frequency");
  });

  it("applies -ing rule", () => {
    expect(getStemmed("processing")).toContain("process");
  });

  it("protects short words (length < 4)", () => {
    // "is" is a stopword so use tokenize differently
    // "run" has length 3, so stem() returns it unchanged
    const tokens = tokenize("run");
    // Should contain "run" but no stem variant
    const unique = [...new Set(tokens)];
    expect(unique).toEqual(["run"]);
  });

  it("applies -s rule to valid words", () => {
    expect(getStemmed("models")).toContain("model");
  });
});
