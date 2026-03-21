import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { initKnowledgeDir } from "../src/init.js";

function freshDir(): string {
  const dir = join(tmpdir(), `knowledge-init-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readMcpJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
}

describe("initKnowledgeDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates knowledge dir, config, summary, and .mcp.json on fresh init", () => {
    const knowledgeDir = join(dir, "knowledge");
    initKnowledgeDir(knowledgeDir, dir);

    expect(existsSync(join(knowledgeDir, "knowledge.config.yaml"))).toBe(true);
    expect(existsSync(join(knowledgeDir, "_summary.md"))).toBe(true);

    const mcpJson = readMcpJson(dir);
    expect(mcpJson).toEqual({
      mcpServers: {
        knowledge: {
          type: "stdio",
          command: "npx",
          args: ["knowledge-mcp-server", "--knowledge-dir", "./knowledge"],
        },
      },
    });
  });

  it("creates .mcp.json even if knowledge dir already exists", () => {
    const knowledgeDir = join(dir, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(join(knowledgeDir, "knowledge.config.yaml"), "name: test\n");

    initKnowledgeDir(knowledgeDir, dir);

    const mcpJson = readMcpJson(dir);
    expect(mcpJson.mcpServers).toHaveProperty("knowledge");
  });

  it("merges into existing .mcp.json with other servers", () => {
    const knowledgeDir = join(dir, "knowledge");
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { type: "stdio", command: "other-server", args: [] },
        },
      }),
    );

    initKnowledgeDir(knowledgeDir, dir);

    const mcpJson = readMcpJson(dir) as { mcpServers: Record<string, unknown> };
    expect(mcpJson.mcpServers).toHaveProperty("other");
    expect(mcpJson.mcpServers).toHaveProperty("knowledge");
  });

  it("skips if .mcp.json already has a knowledge entry", () => {
    const knowledgeDir = join(dir, "knowledge");
    const existing = {
      mcpServers: {
        knowledge: { type: "stdio", command: "custom-cmd", args: ["custom"] },
      },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify(existing));

    initKnowledgeDir(knowledgeDir, dir);

    const mcpJson = readMcpJson(dir) as { mcpServers: Record<string, unknown> };
    expect(mcpJson.mcpServers.knowledge).toEqual(existing.mcpServers.knowledge);
  });

  it("uses correct relative path for custom knowledge dir", () => {
    const knowledgeDir = join(dir, "docs", "kb");
    initKnowledgeDir(knowledgeDir, dir);

    const mcpJson = readMcpJson(dir) as { mcpServers: { knowledge: { args: string[] } } };
    expect(mcpJson.mcpServers.knowledge.args).toContain("./docs/kb");
  });

  it("handles malformed .mcp.json gracefully", () => {
    const knowledgeDir = join(dir, "knowledge");
    writeFileSync(join(dir, ".mcp.json"), "not valid json{{{");

    // Should not throw
    initKnowledgeDir(knowledgeDir, dir);

    // .mcp.json should remain unchanged (malformed)
    const raw = readFileSync(join(dir, ".mcp.json"), "utf-8");
    expect(raw).toBe("not valid json{{{");
  });

  it("is idempotent — running twice produces the same .mcp.json", () => {
    const knowledgeDir = join(dir, "knowledge");
    initKnowledgeDir(knowledgeDir, dir);
    const first = readFileSync(join(dir, ".mcp.json"), "utf-8");

    initKnowledgeDir(knowledgeDir, dir);
    const second = readFileSync(join(dir, ".mcp.json"), "utf-8");

    expect(second).toBe(first);
  });
});
