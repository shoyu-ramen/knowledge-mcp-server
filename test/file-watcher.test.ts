import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
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
phases:
  - id: 1
    name: "Phase 1"
`
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

Root node.`
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

Technology overview.`
  );

  writeFileSync(
    join(dir, "technology", "audio.md"),
    `---
id: technology/audio
title: Audio Processing
type: detail
domain: technology
tags: [audio]
phase: [1]
---

Audio processing details.`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("File Watcher", () => {
  let tmpDir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    tmpDir = freshDir();
    createFixtures(tmpDir);
    engine = new KnowledgeEngine(tmpDir);
  });

  afterEach(() => {
    engine.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("filePathIndex", () => {
    it("populates filePathIndex during graph construction", () => {
      const graph = engine.graph;
      expect(graph.filePathIndex.size).toBe(graph.documents.size);

      for (const doc of graph.documents.values()) {
        const mappedId = graph.filePathIndex.get(doc.filePath);
        expect(mappedId).toBe(doc.id);
      }
    });

    it("maps filePath to docId for all documents", () => {
      const graph = engine.graph;
      // Check a specific known doc
      const audioDoc = graph.documents.get("technology/audio");
      expect(audioDoc).toBeDefined();
      expect(graph.filePathIndex.get(audioDoc!.filePath)).toBe("technology/audio");
    });
  });

  describe("watch lifecycle", () => {
    it("starts and stops cleanly", () => {
      engine.watch();
      // Should not throw when called again (idempotent)
      engine.watch();
      engine.close();
      // Should not throw when closed again
      engine.close();
    });

    it("detects new file creation after debounce", async () => {
      engine.watch();
      const initialCount = engine.graph.documents.size;

      writeFileSync(
        join(tmpDir, "technology", "new-doc.md"),
        `---
id: technology/new-doc
title: New Document
type: detail
domain: technology
tags: [new]
phase: [1]
---

Brand new content.`
      );

      // Wait for debounce (500ms) + processing time
      await delay(1000);

      expect(engine.graph.documents.size).toBe(initialCount + 1);
      expect(engine.graph.documents.has("technology/new-doc")).toBe(true);

      // filePathIndex should be updated
      const newDoc = engine.graph.documents.get("technology/new-doc")!;
      expect(engine.graph.filePathIndex.get(newDoc.filePath)).toBe("technology/new-doc");
    });

    it("detects file modification after debounce", async () => {
      engine.watch();
      const audioDoc = engine.graph.documents.get("technology/audio");
      expect(audioDoc).toBeDefined();
      expect(audioDoc!.title).toBe("Audio Processing");

      writeFileSync(
        join(tmpDir, "technology", "audio.md"),
        `---
id: technology/audio
title: Updated Audio Processing
type: detail
domain: technology
tags: [audio, updated]
phase: [1]
---

Updated audio content.`
      );

      await delay(1000);

      const updatedDoc = engine.graph.documents.get("technology/audio");
      expect(updatedDoc).toBeDefined();
      expect(updatedDoc!.title).toBe("Updated Audio Processing");
      expect(updatedDoc!.tags).toContain("updated");
    });

    it("detects file deletion after debounce", async () => {
      engine.watch();
      expect(engine.graph.documents.has("technology/audio")).toBe(true);
      const audioDoc = engine.graph.documents.get("technology/audio")!;
      const filePath = audioDoc.filePath;

      unlinkSync(join(tmpDir, "technology", "audio.md"));

      await delay(1000);

      expect(engine.graph.documents.has("technology/audio")).toBe(false);
      expect(engine.graph.filePathIndex.has(filePath)).toBe(false);
    });

    it("batches rapid changes via debounce", async () => {
      engine.watch();

      // Create multiple files in rapid succession
      for (let i = 0; i < 3; i++) {
        writeFileSync(
          join(tmpDir, "technology", `batch-${i}.md`),
          `---
id: technology/batch-${i}
title: Batch ${i}
type: detail
domain: technology
tags: [batch]
phase: [1]
---

Batch content ${i}.`
        );
      }

      // All should be processed in one batch after debounce
      await delay(1000);

      for (let i = 0; i < 3; i++) {
        expect(engine.graph.documents.has(`technology/batch-${i}`)).toBe(true);
      }
    });
  });
});
