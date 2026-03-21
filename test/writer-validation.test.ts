import { describe, it, expect } from "vitest";
import { writeDocument } from "../src/writer.js";
import { makeDoc, makeGraph, makeBm25Index } from "./helpers.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setupWriteEnv() {
  const knowledgeDir = join(
    tmpdir(),
    `knowledge-write-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(knowledgeDir, { recursive: true });

  // Create a root-level parent doc so writes can succeed
  const parentDoc = makeDoc({
    id: "technology",
    type: "summary",
    parentId: "root",
    domain: "technology",
  });
  const graph = makeGraph([parentDoc]);
  const index = makeBm25Index([parentDoc]);

  return { knowledgeDir, graph, index, cleanup: () => rmSync(knowledgeDir, { recursive: true, force: true }) };
}

describe("writer validation", () => {
  it("rejects invalid ID format (uppercase)", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "Technology/BadId",
          title: "Test",
          type: "detail",
          domain: "technology",
          tags: [],
          phase: [1],
          content: "Content",
        })
      ).toThrow(/Invalid document ID/);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid domain when validDomains configured", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "Test",
          type: "detail",
          domain: "invalid-domain",
          tags: [],
          phase: [1],
          content: "Content",
        }, ["technology"])
      ).toThrow(/Invalid domain/);
    } finally {
      cleanup();
    }
  });

  it("accepts any domain when validDomains is null", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      // Add a parent for the custom domain
      const customParent = makeDoc({
        id: "custom-anything",
        type: "summary",
        parentId: "root",
        domain: "custom-anything",
      });
      graph.documents.set(customParent.id, customParent);

      const result = writeDocument(graph, index, knowledgeDir, {
        id: "custom-anything/test",
        title: "Test",
        type: "detail",
        domain: "custom-anything",
        tags: [],
        phase: [1],
        content: "Content",
      }, null, null);
      expect(result.status).toBe("created");
    } finally {
      cleanup();
    }
  });

  it("rejects invalid type", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "Test",
          type: "invalid-type",
          domain: "technology",
          tags: [],
          phase: [1],
          content: "Content",
        })
      ).toThrow(/Invalid type/);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid phase value when validPhaseIds configured", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "Test",
          type: "detail",
          domain: "technology",
          tags: [],
          phase: [4],
          content: "Content",
        }, null, [1, 2, 3])
      ).toThrow(/Invalid phase/);
    } finally {
      cleanup();
    }
  });

  it("accepts any positive integer phase when validPhaseIds is null", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      const result = writeDocument(graph, index, knowledgeDir, {
        id: "technology/test",
        title: "Test",
        type: "detail",
        domain: "technology",
        tags: [],
        phase: [7],
        content: "Content",
      }, null, null);
      expect(result.status).toBe("created");
    } finally {
      cleanup();
    }
  });

  it("rejects non-positive phase even when validPhaseIds is null", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "Test",
          type: "detail",
          domain: "technology",
          tags: [],
          phase: [0],
          content: "Content",
        }, null, null)
      ).toThrow(/Invalid phase/);
    } finally {
      cleanup();
    }
  });

  it("rejects empty title", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "  ",
          type: "detail",
          domain: "technology",
          tags: [],
          phase: [1],
          content: "Content",
        })
      ).toThrow(/Title must not be empty/);
    } finally {
      cleanup();
    }
  });

  it("rejects empty content", () => {
    const { knowledgeDir, graph, index, cleanup } = setupWriteEnv();
    try {
      expect(() =>
        writeDocument(graph, index, knowledgeDir, {
          id: "technology/test",
          title: "Test",
          type: "detail",
          domain: "technology",
          tags: [],
          phase: [1],
          content: "  ",
        })
      ).toThrow(/Content must not be empty/);
    } finally {
      cleanup();
    }
  });
});
