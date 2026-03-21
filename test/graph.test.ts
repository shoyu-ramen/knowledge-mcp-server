import { describe, it, expect } from "vitest";
import { getAncestors, getRelated } from "../src/graph.js";
import { makeDoc, makeGraph } from "./helpers.js";

describe("getAncestors", () => {
  it("returns parent chain in root-to-leaf order", () => {
    const root = makeDoc({ id: "technology", parentId: null });
    const mid = makeDoc({ id: "technology/audio", parentId: "technology" });
    const leaf = makeDoc({ id: "technology/audio/pitch", parentId: "technology/audio" });
    const graph = makeGraph([root, mid, leaf]);

    const ancestors = getAncestors(graph, "technology/audio/pitch");
    expect(ancestors.map((a) => a.id)).toEqual(["technology", "technology/audio"]);
  });

  it("returns empty array for root-level doc", () => {
    const root = makeDoc({ id: "technology", parentId: null });
    const graph = makeGraph([root]);

    const ancestors = getAncestors(graph, "technology");
    expect(ancestors).toEqual([]);
  });

  it("handles missing parent gracefully", () => {
    const doc = makeDoc({ id: "technology/orphan", parentId: "technology" });
    const graph = makeGraph([doc]);

    // Parent "technology" doesn't exist in graph
    const ancestors = getAncestors(graph, "technology/orphan");
    expect(ancestors).toEqual([]);
  });
});

describe("getRelated", () => {
  it("returns forward links", () => {
    const docA = makeDoc({ id: "a", related: ["b"] });
    const docB = makeDoc({ id: "b", related: [] });
    const graph = makeGraph([docA, docB]);

    const related = getRelated(graph, "a");
    expect(related.map((r) => r.id)).toContain("b");
  });

  it("includes backlinks (bidirectional)", () => {
    const docA = makeDoc({ id: "a", related: ["b"] });
    const docB = makeDoc({ id: "b", related: [] });
    const graph = makeGraph([docA, docB]);

    // B should see A as related via backlink
    const related = getRelated(graph, "b");
    expect(related.map((r) => r.id)).toContain("a");
  });
});
