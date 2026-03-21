import { describe, it, expect } from "vitest";
import { rerank } from "../src/reranker.js";
import { makeDoc } from "./helpers.js";

describe("rerank", () => {
  it("boosts score when query tokens match title", () => {
    const doc = makeDoc({ id: "a", title: "Pitch Detection Pipeline" });
    const results = rerank([{ doc, score: 1.0 }], "pitch detection", "specific");
    expect(results[0].score).toBeGreaterThan(1.0);
  });

  it("boosts decision-type docs for decision queries", () => {
    const decisionDoc = makeDoc({ id: "a", type: "decision" });
    const detailDoc = makeDoc({ id: "b", type: "detail" });

    const results = rerank(
      [
        { doc: decisionDoc, score: 1.0 },
        { doc: detailDoc, score: 1.0 },
      ],
      "why did we choose CREPE",
      "decision"
    );

    const decisionScore = results.find((r) => r.doc.id === "a")!.score;
    const detailScore = results.find((r) => r.doc.id === "b")!.score;
    expect(decisionScore).toBeGreaterThan(detailScore);
  });

  it("penalizes stale docs (>6 months old)", () => {
    const staleDoc = makeDoc({ id: "a", lastUpdated: "2025-01-01" });
    const freshDoc = makeDoc({ id: "b", lastUpdated: "2026-03-20" });

    const results = rerank(
      [
        { doc: staleDoc, score: 1.0 },
        { doc: freshDoc, score: 1.0 },
      ],
      "some query",
      "specific"
    );

    const staleScore = results.find((r) => r.doc.id === "a")!.score;
    const freshScore = results.find((r) => r.doc.id === "b")!.score;
    expect(staleScore).toBeLessThan(freshScore);
  });

  it("boosts score for exact phrase match in content body", () => {
    const matchDoc = makeDoc({
      id: "a",
      contentBody: "We use pitch detection with CREPE for real-time analysis",
    });
    const noMatchDoc = makeDoc({
      id: "b",
      contentBody: "Audio processing system for guitar learning",
    });

    const results = rerank(
      [
        { doc: matchDoc, score: 1.0 },
        { doc: noMatchDoc, score: 1.0 },
      ],
      "pitch detection",
      "specific"
    );

    const matchScore = results.find((r) => r.doc.id === "a")!.score;
    const noMatchScore = results.find((r) => r.doc.id === "b")!.score;
    expect(matchScore).toBeGreaterThan(noMatchScore);
  });
});
