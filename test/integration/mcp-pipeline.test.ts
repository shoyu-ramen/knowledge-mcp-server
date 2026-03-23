import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKnowledgeServer } from "../../src/index.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDir(): string {
  const dir = join(tmpdir(), `knowledge-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFixtures(dir: string, { includeConfig = true }: { includeConfig?: boolean } = {}) {
  // Add a knowledge.config.yaml so domain validation is enforced
  if (includeConfig) {
    writeFileSync(
      join(dir, "knowledge.config.yaml"),
      `name: "test-project"
domains:
  - technology
phases:
  - id: 1
    name: "Phase 1"
`,
    );
  }

  // Create a "root" summary (every graph needs one)
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

  // Create a domain directory with parent summary and child doc
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
---

# Audio Pipeline

Audio processing details for pitch detection and chord recognition.`,
  );
}

/** Spin up an in-process MCP client + server pair and return the client. */
async function startClient(knowledgeDir: string) {
  const { server } = createKnowledgeServer(knowledgeDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

/** Extract text from a tool call result. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if ("content" in result && Array.isArray(result.content)) {
    return result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP knowledge server integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Write -> Search -> Find
  // -----------------------------------------------------------------------

  describe("write-search pipeline", () => {
    it("write-search-basic: written doc is immediately searchable", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write a new doc
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/pitch-detection",
          title: "Pitch Detection",
          type: "detail",
          domain: "technology",
          tags: ["audio", "pitch"],
          phase: [1],
          content:
            "CREPE Tiny runs on-device for real-time monophonic pitch detection with sub-cent accuracy.",
        },
      });

      // Search for it
      const searchResult = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "CREPE pitch detection" },
      });

      const text = textOf(searchResult);
      expect(text).toContain("pitch-detection");
      expect(text).toContain("Pitch Detection");
    });

    it("write-search-related: related links are expanded in search results", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write doc A
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/pitch-detection",
          title: "Pitch Detection",
          type: "detail",
          domain: "technology",
          tags: ["audio", "pitch"],
          phase: [1],
          content: "CREPE Tiny for monophonic pitch detection.",
        },
      });

      // Write doc B related to A
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/chord-recognition",
          title: "Chord Recognition",
          type: "detail",
          domain: "technology",
          tags: ["audio", "chords"],
          phase: [1],
          related: ["technology/pitch-detection"],
          content: "Essentia ChordsDetection runs in parallel with CREPE for polyphonic analysis.",
        },
      });

      // Search for chords
      const searchResult = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "chord recognition polyphonic" },
      });

      const text = textOf(searchResult);
      expect(text).toContain("chord-recognition");
    });

    it("write-update: updating a doc reflects new content in search", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write initial version
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/pitch-detection",
          title: "Pitch Detection",
          type: "detail",
          domain: "technology",
          tags: ["audio"],
          phase: [1],
          content: "Initial content about basic pitch detection.",
        },
      });

      // Update with new content
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/pitch-detection",
          title: "Pitch Detection (Updated)",
          type: "detail",
          domain: "technology",
          tags: ["audio", "crepe"],
          phase: [1],
          content:
            "Updated content: CREPE Tiny achieves sub-cent accuracy using a convolutional neural network.",
        },
      });

      // Lookup should return updated content
      const lookupResult = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: "technology/pitch-detection" },
      });

      const text = textOf(lookupResult);
      expect(text).toContain("Updated");
      expect(text).toContain("convolutional neural network");
    });
  });

  // -----------------------------------------------------------------------
  // Write -> Delete -> Verify
  // -----------------------------------------------------------------------

  describe("write-delete pipeline", () => {
    it("write-delete-basic: deleted doc disappears from search", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/temporary-doc",
          title: "Temporary Document",
          type: "detail",
          domain: "technology",
          tags: ["temp"],
          phase: [1],
          content: "This document will be deleted shortly after creation.",
        },
      });

      // Verify it exists
      const beforeSearch = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "temporary document deleted" },
      });
      expect(textOf(beforeSearch)).toContain("temporary-doc");

      // Delete
      await client.callTool({
        name: "knowledge_delete",
        arguments: { id: "technology/temporary-doc" },
      });

      // Verify it's gone from lookup
      const lookupResult = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: "technology/temporary-doc" },
      });
      expect(textOf(lookupResult)).toContain("not found");
    });

    it("delete-with-children: warns about orphaned children", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Create a subdomain summary under technology
      mkdirSync(join(tmpDir, "technology", "audio-detection"), { recursive: true });
      writeFileSync(
        join(tmpDir, "technology", "audio-detection", "_summary.md"),
        `---
id: technology/audio-detection
title: Audio Detection
type: summary
domain: technology
tags: [audio]
phase: [1]
---

Audio detection subsystem.`,
      );

      // Restart with the new fixtures loaded
      const { client: c2 } = await startClient(tmpDir);

      // Write a child document under the subsystem
      await c2.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/audio-detection/crepe",
          title: "CREPE Implementation",
          type: "detail",
          domain: "technology",
          tags: ["crepe"],
          phase: [1],
          content: "CREPE Tiny implementation details.",
        },
      });

      // Delete the parent
      const deleteResult = await c2.callTool({
        name: "knowledge_delete",
        arguments: { id: "technology/audio-detection" },
      });

      const text = textOf(deleteResult);
      expect(text).toContain("orphan");
    });
  });

  // -----------------------------------------------------------------------
  // Graph Traversal
  // -----------------------------------------------------------------------

  describe("graph traversal", () => {
    it("graph-tree: returns nodes and edges for fixture documents", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_graph",
        arguments: { root_id: "root", depth: 3 },
      });

      const text = textOf(result);
      // The output is XML-formatted with <node> and <edge> elements
      expect(text).toContain("root");
      expect(text).toContain("technology");
    });

    it("graph-related: cross-references appear as related edges", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write two related docs
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/doc-a",
          title: "Document A",
          type: "detail",
          domain: "technology",
          tags: ["test"],
          phase: [1],
          content: "First document.",
        },
      });
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/doc-b",
          title: "Document B",
          type: "detail",
          domain: "technology",
          tags: ["test"],
          phase: [1],
          related: ["technology/doc-a"],
          content: "Second document related to A.",
        },
      });

      const result = await client.callTool({
        name: "knowledge_graph",
        arguments: { root_id: "technology", depth: 2, include_related: true },
      });

      const text = textOf(result);
      expect(text).toContain("doc-a");
      expect(text).toContain("doc-b");
      expect(text).toContain("related");
    });
  });

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  describe("lookup", () => {
    it("lookup-exact: retrieves document by exact ID", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Write a doc
      await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/exact-lookup-test",
          title: "Exact Lookup Test",
          type: "detail",
          domain: "technology",
          tags: ["test"],
          phase: [1],
          content: "Content for exact lookup verification.",
        },
      });

      const result = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: "technology/exact-lookup-test" },
      });

      const text = textOf(result);
      expect(text).toContain("Exact Lookup Test");
      expect(text).toContain("exact lookup verification");
    });

    it("lookup-fuzzy: returns suggestions for non-existent ID", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: "technology/audio-something" },
      });

      const text = textOf(result);
      expect(text).toContain("not found");
      // Should suggest the existing "technology/audio" doc
      expect(text).toMatch(/did you mean|technology\/audio/i);
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty-graph: search on empty knowledge dir returns no results", async () => {
      // Empty dir, no fixtures
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "anything at all" },
      });

      const text = textOf(result);
      // Should return empty / no results without crashing
      expect(text).not.toContain("Error");
    });

    it("corrupt-frontmatter: files with invalid YAML load without crashing", async () => {
      // Create a valid root + one corrupt file
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

      mkdirSync(join(tmpDir, "technology"), { recursive: true });
      writeFileSync(
        join(tmpDir, "technology", "_summary.md"),
        `---
id: technology
title: Technology
type: summary
domain: technology
tags: [tech]
phase: [1]
---

Tech.`,
      );

      // Write a file with frontmatter that parses as YAML but is missing required fields
      // (no id field, so the loader will skip it gracefully)
      writeFileSync(
        join(tmpDir, "technology", "corrupt.md"),
        `---
title: Missing ID Document
tags: not-an-array
domain: technology
---

Content that should be skipped.`,
      );

      // This should not throw — the server should skip the corrupt file
      const { client } = await startClient(tmpDir);

      // The valid doc should still be searchable
      const result = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "technology" },
      });

      const text = textOf(result);
      // Should find the valid technology summary
      expect(text).toContain("technology");
    });

    it("write-validation-error: write with invalid params returns error", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      // Invalid domain (config file restricts to "technology" only)
      const result = await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "technology/test",
          title: "Test",
          type: "detail",
          domain: "invalid-domain-xyz",
          tags: ["test"],
          phase: [1],
          content: "Test content.",
        },
      });

      const text = textOf(result);
      expect(text).toContain("Error");
      expect(text).toContain("invalid-domain-xyz");
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  describe("list tool", () => {
    it("list-all: returns all documents", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_list",
        arguments: {},
      });

      const text = textOf(result);
      expect(text).toContain("technology/audio");
      expect(text).toContain("Audio Processing");
    });

    it("list-filtered: filters by domain", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_list",
        arguments: { domain: "technology" },
      });

      const text = textOf(result);
      expect(text).toContain("technology");
    });

    it("list-title-search: filters by title substring", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_list",
        arguments: { title_search: "Audio" },
      });

      const text = textOf(result);
      expect(text).toContain("Audio Processing");
    });
  });

  // -----------------------------------------------------------------------
  // Validate
  // -----------------------------------------------------------------------

  describe("validate tool", () => {
    it("validate: returns integrity report", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_validate",
        arguments: {},
      });

      const text = textOf(result);
      // Should contain validation output (issues or "no issues")
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  describe("stats tool", () => {
    it("stats: returns knowledge graph metrics", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_stats",
        arguments: {},
      });

      const text = textOf(result);
      expect(text).toContain("Total documents");
    });
  });

  // -----------------------------------------------------------------------
  // Delete dry-run
  // -----------------------------------------------------------------------

  describe("delete dry-run", () => {
    it("dry-run: previews deletion without removing document", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_delete",
        arguments: { id: "technology/audio", dry_run: true },
      });

      const text = textOf(result);
      expect(text).toContain("DRY RUN");

      // Verify doc still exists
      const lookup = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: "technology/audio" },
      });
      expect(textOf(lookup)).toContain("Audio Processing");
    });
  });

  // -----------------------------------------------------------------------
  // Batch Lookup
  // -----------------------------------------------------------------------

  describe("batch lookup", () => {
    it("batch: retrieves multiple documents by ID array", async () => {
      createFixtures(tmpDir);
      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_lookup",
        arguments: { id: ["technology/audio", "technology"] },
      });

      const text = textOf(result);
      expect(text).toContain("Audio Processing");
      expect(text).toContain("Technology");
    });
  });

  describe("zero-config mode", () => {
    it("accepts any domain when no config file present", async () => {
      createFixtures(tmpDir, { includeConfig: false });

      // Add a custom domain parent
      mkdirSync(join(tmpDir, "custom-domain"), { recursive: true });
      writeFileSync(
        join(tmpDir, "custom-domain", "_summary.md"),
        `---
id: custom-domain
title: Custom Domain
type: summary
domain: custom-domain
tags: [custom]
phase: [1]
---

Custom domain overview.`,
      );

      const { client } = await startClient(tmpDir);

      const result = await client.callTool({
        name: "knowledge_write",
        arguments: {
          id: "custom-domain/test-doc",
          title: "Test Doc",
          type: "detail",
          domain: "custom-domain",
          tags: ["test"],
          phase: [1],
          content: "This should work in zero-config mode.",
        },
      });

      const text = textOf(result);
      expect(text).not.toContain("Error");
      expect(text).toContain("custom-domain/test-doc");
    });
  });
});
