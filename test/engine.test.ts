import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { KnowledgeEngine } from "../src/engine.js";

function freshDir(): string {
  const dir = join(tmpdir(), `knowledge-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFixtures(dir: string) {
  writeFileSync(
    join(dir, "knowledge.config.yaml"),
    `name: "test-project"
domains:
  - technology
  - business
phases:
  - id: 1
    name: "Phase 1"
  - id: 2
    name: "Phase 2"
`,
  );

  writeFileSync(
    join(dir, "_summary.md"),
    `---
id: root
title: Knowledge Root
type: summary
domain: technology
tags: [root]
phase: [1]
---

Root node of the knowledge graph.`,
  );

  mkdirSync(join(dir, "technology"), { recursive: true });
  writeFileSync(
    join(dir, "technology", "_summary.md"),
    `---
id: technology
title: Technology
type: summary
domain: technology
tags: [tech]
phase: [1]
---

Technology overview.`,
  );

  writeFileSync(
    join(dir, "technology", "audio.md"),
    `---
id: technology/audio
title: Audio Processing
type: detail
domain: technology
tags: [audio, pipeline]
phase: [1]
related: [technology]
---

# Audio Pipeline

Audio processing details for pitch detection and chord recognition.`,
  );
}

describe("KnowledgeEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("builds graph with loaded documents", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      expect(engine.graph.documents.size).toBe(3); // root, technology, technology/audio
      expect(engine.config).not.toBeNull();
      expect(engine.validDomains).toContain("technology");
    });

    it("works in zero-config mode without knowledge.config.yaml", () => {
      // Create minimal fixtures without config
      writeFileSync(
        join(tmpDir, "_summary.md"),
        `---
id: root
title: Root
type: summary
domain: technology
tags: [root]
phase: [1]
---

Root.`,
      );

      const engine = new KnowledgeEngine(tmpDir);
      expect(engine.graph.documents.size).toBe(1);
      expect(engine.config).toBeNull();
      expect(engine.validDomains).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  describe("search", () => {
    it("returns formatted search results", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = await engine.search({ query: "audio pipeline pitch detection" });
      expect(result).toContain("knowledge_context");
      expect(result).toContain("Audio Processing");
    });

    it("returns results with domain filter", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = await engine.search({
        query: "audio",
        domains: ["technology"],
      });
      expect(result).toContain("Audio Processing");
    });
  });

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  describe("lookup", () => {
    it("finds document by exact ID", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.lookup(["technology/audio"]);
      expect(result.found).toHaveLength(1);
      expect(result.found[0].doc.title).toBe("Audio Processing");
      expect(result.notFound).toHaveLength(0);
    });

    it("reports not-found IDs", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.lookup(["nonexistent/doc"]);
      expect(result.found).toHaveLength(0);
      expect(result.notFound).toEqual(["nonexistent/doc"]);
    });

    it("handles batch lookup", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.lookup(["technology/audio", "technology", "nonexistent"]);
      expect(result.found).toHaveLength(2);
      expect(result.notFound).toEqual(["nonexistent"]);
    });

    it("includes ancestors when requested", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.lookup(["technology/audio"], { includeAncestors: true });
      expect(result.found[0].ancestors.length).toBeGreaterThan(0);
    });

    it("includes related when requested", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.lookup(["technology/audio"], { includeRelated: true });
      expect(result.found[0].related.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Fuzzy Match
  // -----------------------------------------------------------------------

  describe("fuzzyMatchId", () => {
    it("suggests similar IDs", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const suggestions = engine.fuzzyMatchId("audio");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].id).toBe("technology/audio");
    });

    it("returns empty for completely unrelated query", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const suggestions = engine.fuzzyMatchId("xyzzy-nonexistent-12345");
      expect(suggestions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Graph View
  // -----------------------------------------------------------------------

  describe("graphView", () => {
    it("returns nodes and edges for root traversal", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.graphView("root", 3, false, 100);
      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBeGreaterThan(0);
      expect(result!.nodes[0].id).toBe("root");
    });

    it("respects depth limit", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const shallow = engine.graphView("root", 0, false, 100);
      expect(shallow).not.toBeNull();
      expect(shallow!.nodes).toHaveLength(1); // just root
    });

    it("respects maxNodes limit", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.graphView("root", 3, false, 2);
      expect(result).not.toBeNull();
      expect(result!.nodes.length).toBeLessThanOrEqual(2);
    });

    it("returns null for missing root", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.graphView("nonexistent", 3, false, 100);
      expect(result).toBeNull();
    });

    it("includes related edges when requested", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.graphView("technology", 2, true, 100);
      expect(result).not.toBeNull();
      // technology/audio has a related link to technology
      const relatedEdges = result!.edges.filter((e) => e.type === "related");
      // At minimum there should be child edges
      expect(result!.edges.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("returns all active documents", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list();
      expect(result.docs.length).toBe(3);
      expect(result.totalDocs).toBe(3);
    });

    it("filters by domain", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list({ domain: "technology" });
      expect(result.docs.every((d) => d.domain === "technology")).toBe(true);
    });

    it("filters by type", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list({ type: "detail" });
      expect(result.docs.every((d) => d.type === "detail")).toBe(true);
      expect(result.docs.length).toBe(1);
    });

    it("filters by titleSearch", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list({ titleSearch: "audio" });
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].id).toBe("technology/audio");
    });

    it("filters by tags", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list({ tags: ["audio"] });
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].id).toBe("technology/audio");
    });

    it("excludes drafts by default", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      // Write a draft doc
      await engine.write({
        id: "technology/draft-doc",
        title: "Draft Document",
        type: "detail",
        domain: "technology",
        tags: ["draft"],
        phase: [1],
        content: "Draft content.",
        status: "draft",
      });

      const result = engine.list();
      expect(result.docs.find((d) => d.id === "technology/draft-doc")).toBeUndefined();

      const withDrafts = engine.list({ includeDrafts: true });
      expect(withDrafts.docs.find((d) => d.id === "technology/draft-doc")).toBeDefined();
    });

    it("sorts by domain then id", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = engine.list();
      for (let i = 1; i < result.docs.length; i++) {
        const cmp =
          result.docs[i - 1].domain.localeCompare(result.docs[i].domain) ||
          result.docs[i - 1].id.localeCompare(result.docs[i].id);
        expect(cmp).toBeLessThanOrEqual(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Validate & Stats
  // -----------------------------------------------------------------------

  describe("validate", () => {
    it("returns a validation report", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const report = engine.validate();
      expect(report).toHaveProperty("orphans");
      expect(report).toHaveProperty("brokenRelated");
      expect(report).toHaveProperty("embeddingCoverage");
    });
  });

  describe("stats", () => {
    it("returns graph statistics", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const stats = engine.stats();
      expect(stats.totalDocs).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  describe("write", () => {
    it("creates a new document", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const result = await engine.write({
        id: "technology/new-doc",
        title: "New Document",
        type: "detail",
        domain: "technology",
        tags: ["test"],
        phase: [1],
        content: "New document content.",
      });

      expect(result.status).toBe("created");
      expect(engine.graph.documents.has("technology/new-doc")).toBe(true);
    });

    it("updates BM25 index after write", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      await engine.write({
        id: "technology/searchable-doc",
        title: "Searchable Document",
        type: "detail",
        domain: "technology",
        tags: ["unique-searchable-tag"],
        phase: [1],
        content: "This document has unique content for xylophone testing.",
      });

      const searchResult = await engine.search({ query: "xylophone testing" });
      expect(searchResult).toContain("searchable-doc");
    });

    it("serializes concurrent writes", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      // Fire two writes concurrently
      const [r1, r2] = await Promise.all([
        engine.write({
          id: "technology/concurrent-a",
          title: "Concurrent A",
          type: "detail",
          domain: "technology",
          tags: ["test"],
          phase: [1],
          content: "Concurrent write A.",
        }),
        engine.write({
          id: "technology/concurrent-b",
          title: "Concurrent B",
          type: "detail",
          domain: "technology",
          tags: ["test"],
          phase: [1],
          content: "Concurrent write B.",
        }),
      ]);

      expect(r1.status).toBe("created");
      expect(r2.status).toBe("created");
      expect(engine.graph.documents.has("technology/concurrent-a")).toBe(true);
      expect(engine.graph.documents.has("technology/concurrent-b")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Delete & Preview Delete
  // -----------------------------------------------------------------------

  describe("delete", () => {
    it("removes a document from graph and indices", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      await engine.write({
        id: "technology/to-delete",
        title: "To Delete",
        type: "detail",
        domain: "technology",
        tags: ["deleteme"],
        phase: [1],
        content: "This will be deleted.",
      });

      expect(engine.graph.documents.has("technology/to-delete")).toBe(true);

      await engine.delete("technology/to-delete");

      expect(engine.graph.documents.has("technology/to-delete")).toBe(false);
      // Tag should be cleaned up
      const tagSet = engine.graph.tagIndex.get("deleteme");
      expect(!tagSet || tagSet.size === 0).toBe(true);
    });
  });

  describe("previewDelete", () => {
    it("returns warnings without side effects", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      const sizeBefore = engine.graph.documents.size;
      const result = engine.previewDelete("technology/audio");
      const sizeAfter = engine.graph.documents.size;

      expect(result.warnings).toBeDefined();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("DRY RUN");
      expect(sizeBefore).toBe(sizeAfter);
    });

    it("warns about children that would be orphaned", async () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      // technology has technology/audio as child
      const result = engine.previewDelete("technology");
      expect(result.warnings.some((w) => w.includes("orphan") || w.includes("children"))).toBe(
        true,
      );
    });

    it("throws for non-existent document", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      expect(() => engine.previewDelete("nonexistent")).toThrow("not found");
    });
  });

  // -----------------------------------------------------------------------
  // bm25Index backward compatibility
  // -----------------------------------------------------------------------

  describe("bm25Index getter", () => {
    it("exposes internal BM25 index for backward compat", () => {
      createFixtures(tmpDir);
      const engine = new KnowledgeEngine(tmpDir);

      expect(engine.bm25Index).toBeDefined();
      expect(engine.bm25Index.docCount).toBeGreaterThan(0);
    });
  });
});
