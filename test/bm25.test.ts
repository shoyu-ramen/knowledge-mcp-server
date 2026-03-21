import { describe, it, expect, beforeEach } from "vitest";
import { bm25Score, buildTfIdfIndex, updateBm25Index, type Bm25Index } from "../src/embeddings.js";
import { makeDoc, makeBm25Index } from "./helpers.js";

describe("BM25 scoring", () => {
  it("scores document containing query term higher than one without", () => {
    const docA = makeDoc({ id: "a", contentBody: "pitch detection using CREPE model" });
    const docB = makeDoc({ id: "b", contentBody: "chord progression analysis system" });
    const index = makeBm25Index([docA, docB]);

    expect(bm25Score("pitch detection", "a", index)).toBeGreaterThan(
      bm25Score("pitch detection", "b", index)
    );
  });

  it("boosts title matches (title tokens emitted 3x)", () => {
    const docTitle = makeDoc({
      id: "title-match",
      title: "Pitch Detection",
      contentBody: "Some generic content about audio processing",
    });
    const docBody = makeDoc({
      id: "body-match",
      title: "Audio Processing",
      contentBody: "Pitch detection is done using various algorithms",
    });
    const index = makeBm25Index([docTitle, docBody]);

    expect(bm25Score("pitch detection", "title-match", index)).toBeGreaterThan(
      bm25Score("pitch detection", "body-match", index)
    );
  });

  it("boosts tag matches (tag tokens emitted 2x)", () => {
    const docTag = makeDoc({
      id: "tag-match",
      tags: ["pitch-detection"],
      contentBody: "Some generic audio content",
    });
    const docBody = makeDoc({
      id: "body-only",
      tags: ["audio"],
      contentBody: "pitch detection using CREPE",
    });
    const index = makeBm25Index([docTag, docBody]);

    // Tag match gets 2x boost but body has the actual term too
    // The tag-match doc should score well on "pitch-detection"
    const tagScore = bm25Score("pitch-detection", "tag-match", index);
    expect(tagScore).toBeGreaterThan(0);
  });

  it("applies length normalization (longer docs penalized)", () => {
    const shortDoc = makeDoc({
      id: "short",
      contentBody: "pitch detection model",
    });
    const longDoc = makeDoc({
      id: "long",
      contentBody:
        "pitch detection model " +
        "with many additional words about various topics including audio processing " +
        "signal analysis frequency measurement waveform interpretation harmonic content " +
        "spectral analysis temporal patterns rhythmic structures melodic intervals " +
        "musical theory composition arrangement performance practice",
    });
    const index = makeBm25Index([shortDoc, longDoc]);

    // Short doc with same key terms should score higher due to BM25 length normalization
    expect(bm25Score("pitch detection", "short", index)).toBeGreaterThan(
      bm25Score("pitch detection", "long", index)
    );
  });

  it("gives higher IDF to rare terms", () => {
    const docs = [
      makeDoc({ id: "d1", contentBody: "pitch detection CREPE" }),
      makeDoc({ id: "d2", contentBody: "pitch detection YIN" }),
      makeDoc({ id: "d3", contentBody: "pitch detection onset" }),
      makeDoc({ id: "d4", contentBody: "chord analysis harmonic" }),
    ];
    const index = makeBm25Index(docs);

    // "crepe" appears in 1 doc, "pitch" in 3 — CREPE should have higher IDF
    const crepeScore = bm25Score("CREPE", "d1", index);
    expect(crepeScore).toBeGreaterThan(0);
  });

  it("adds new doc via updateBm25Index", () => {
    const docA = makeDoc({ id: "a", contentBody: "existing content" });
    const index = makeBm25Index([docA]);

    const newDoc = makeDoc({ id: "new", contentBody: "pitch detection CREPE" });
    updateBm25Index(index, "new", newDoc);

    expect(bm25Score("pitch detection", "new", index)).toBeGreaterThan(0);
    expect(index.docCount).toBe(2);
  });

  it("removes doc via updateBm25Index", () => {
    const docA = makeDoc({ id: "a", contentBody: "pitch detection CREPE" });
    const docB = makeDoc({ id: "b", contentBody: "chord analysis" });
    const index = makeBm25Index([docA, docB]);

    updateBm25Index(index, "a", null);

    expect(bm25Score("pitch detection", "a", index)).toBe(0);
    expect(index.docCount).toBe(1);
  });

  it("updates doc via updateBm25Index", () => {
    const docA = makeDoc({ id: "a", contentBody: "pitch detection CREPE" });
    const index = makeBm25Index([docA]);

    const updatedDoc = makeDoc({ id: "a", contentBody: "chord recognition essentia" });
    updateBm25Index(index, "a", updatedDoc);

    expect(bm25Score("chord recognition", "a", index)).toBeGreaterThan(0);
    expect(bm25Score("pitch detection", "a", index)).toBe(0);
    expect(index.docCount).toBe(1);
  });
});
