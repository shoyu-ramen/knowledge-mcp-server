import { describe, it, expect } from "vitest";
import { deriveParentId, loadDocuments } from "../src/loader.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("deriveParentId", () => {
  it("returns parent path for nested ID", () => {
    expect(deriveParentId("technology/audio-detection/pitch")).toBe("technology/audio-detection");
  });

  it('returns "root" for top-level domain ID', () => {
    expect(deriveParentId("technology")).toBe("root");
  });

  it("returns null for root", () => {
    expect(deriveParentId("root")).toBeNull();
  });
});

describe("loadDocuments", () => {
  function createTempKnowledge(): string {
    const dir = join(tmpdir(), `knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("parses frontmatter and body from markdown files", () => {
    const dir = createTempKnowledge();
    try {
      const subdir = join(dir, "technology");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(
        join(subdir, "test-doc.md"),
        `---
id: technology/test-doc
title: Test Document
type: detail
domain: technology
tags: [audio, pitch]
phase: [1, 2]
---

# Test Content

This is the body.`
      );

      const docs = loadDocuments(dir);
      expect(docs.size).toBe(1);
      const doc = docs.get("technology/test-doc")!;
      expect(doc.title).toBe("Test Document");
      expect(doc.type).toBe("detail");
      expect(doc.domain).toBe("technology");
      expect(doc.tags).toEqual(["audio", "pitch"]);
      expect(doc.phase).toEqual([1, 2]);
      expect(doc.contentBody).toContain("# Test Content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles missing frontmatter gracefully", () => {
    const dir = createTempKnowledge();
    try {
      writeFileSync(join(dir, "no-frontmatter.md"), "# Just a heading\n\nSome content.");
      const docs = loadDocuments(dir);
      // No frontmatter means no id, doc is skipped
      expect(docs.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses scalar phase as array", () => {
    const dir = createTempKnowledge();
    try {
      writeFileSync(
        join(dir, "scalar-phase.md"),
        `---
id: test/scalar-phase
title: Scalar Phase Test
type: detail
domain: technology
tags: []
phase: 1
---

Content.`
      );
      const docs = loadDocuments(dir);
      const doc = docs.get("test/scalar-phase")!;
      expect(doc.phase).toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses decision fields from frontmatter", () => {
    const dir = createTempKnowledge();
    try {
      writeFileSync(
        join(dir, "decision.md"),
        `---
id: test/decision
title: Why CREPE
type: decision
domain: technology
tags: [crepe]
phase: [1]
decision_status: finalized
alternatives_considered:
  - YIN
  - SPICE
decision_date: "2026-03-15"
---

We chose CREPE because of real-time performance.`
      );
      const docs = loadDocuments(dir);
      const doc = docs.get("test/decision")!;
      expect(doc.decisionStatus).toBe("finalized");
      expect(doc.alternativesConsidered).toEqual(["YIN", "SPICE"]);
      expect(doc.decisionDate).toBe("2026-03-15");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("populates childrenIds from parent relationships", () => {
    const dir = createTempKnowledge();
    try {
      const subdir = join(dir, "tech");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(
        join(dir, "tech-summary.md"),
        `---
id: tech
title: Technology
type: summary
domain: technology
tags: []
phase: []
---

Overview.`
      );
      writeFileSync(
        join(subdir, "child.md"),
        `---
id: tech/child
title: Child Doc
type: detail
domain: technology
tags: []
phase: [1]
---

Child content.`
      );
      const docs = loadDocuments(dir);
      const parent = docs.get("tech")!;
      expect(parent.childrenIds).toContain("tech/child");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
