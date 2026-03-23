import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  discoverDomains,
  getEffectiveDomains,
  getEffectivePhaseIds,
} from "../src/config.js";

function freshDir(): string {
  const dir = join(tmpdir(), `knowledge-config-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when config file is missing", () => {
    expect(loadConfig(dir)).toBeNull();
  });

  it("parses valid YAML with all fields", () => {
    writeFileSync(
      join(dir, "knowledge.config.yaml"),
      `name: "test-project"
domains:
  - technology
  - business
phases:
  - id: 1
    name: "Alpha"
    aliases: ["mvp"]
  - id: 2
    name: "Beta"
query_hints:
  technology: ["api", "database"]
  business: ["pricing", "revenue"]
synonyms:
  ml: ["machine learning"]
  ai: ["artificial intelligence"]
embeddings:
  provider: "voyage"
  model: "voyage-3-lite"
  api_key_env: "VOYAGE_API_KEY"
`
    );

    const config = loadConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.name).toBe("test-project");
    expect(config!.domains).toEqual(["technology", "business"]);
    expect(config!.phases).toHaveLength(2);
    expect(config!.phases![0]).toEqual({ id: 1, name: "Alpha", aliases: ["mvp"] });
    expect(config!.phases![1]).toEqual({ id: 2, name: "Beta" });
    expect(config!.query_hints).toEqual({
      technology: ["api", "database"],
      business: ["pricing", "revenue"],
    });
    expect(config!.synonyms).toEqual({
      ml: ["machine learning"],
      ai: ["artificial intelligence"],
    });
    expect(config!.embeddings).toEqual({
      provider: "voyage",
      model: "voyage-3-lite",
      api_key_env: "VOYAGE_API_KEY",
    });
  });

  it("parses valid YAML with only domains", () => {
    writeFileSync(
      join(dir, "knowledge.config.yaml"),
      `domains:
  - research
  - design
`
    );

    const config = loadConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.domains).toEqual(["research", "design"]);
    expect(config!.phases).toBeUndefined();
    expect(config!.query_hints).toBeUndefined();
    expect(config!.synonyms).toBeUndefined();
  });

  it("throws for malformed YAML", () => {
    writeFileSync(join(dir, "knowledge.config.yaml"), "{{{{invalid yaml content");

    expect(() => loadConfig(dir)).toThrow("Failed to parse knowledge.config.yaml");
  });

  it("returns null for empty file", () => {
    writeFileSync(join(dir, "knowledge.config.yaml"), "");

    const config = loadConfig(dir);
    expect(config).toBeNull();
  });
});

describe("discoverDomains", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns top-level directories sorted alphabetically", () => {
    mkdirSync(join(dir, "technology"));
    mkdirSync(join(dir, "business"));
    mkdirSync(join(dir, "architecture"));

    const domains = discoverDomains(dir);
    expect(domains).toEqual(["architecture", "business", "technology"]);
  });

  it("ignores dotfiles and dot-directories", () => {
    mkdirSync(join(dir, "technology"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".embeddings.json"), "{}");

    const domains = discoverDomains(dir);
    expect(domains).toEqual(["technology"]);
  });

  it("ignores regular files", () => {
    mkdirSync(join(dir, "technology"));
    writeFileSync(join(dir, "_summary.md"), "# Root");
    writeFileSync(join(dir, "knowledge.config.yaml"), "name: test");

    const domains = discoverDomains(dir);
    expect(domains).toEqual(["technology"]);
  });

  it("returns empty array for non-existent directory", () => {
    const domains = discoverDomains(join(dir, "does-not-exist"));
    expect(domains).toEqual([]);
  });
});

describe("getEffectiveDomains", () => {
  it("returns config domains when present", () => {
    const result = getEffectiveDomains({ domains: ["a", "b"] }, "/tmp");
    expect(result).toEqual(["a", "b"]);
  });

  it("returns null when config is null", () => {
    const result = getEffectiveDomains(null, "/tmp");
    expect(result).toBeNull();
  });

  it("returns null when config has no domains", () => {
    const result = getEffectiveDomains({ name: "test" }, "/tmp");
    expect(result).toBeNull();
  });

  it("returns null when config has empty domains array", () => {
    const result = getEffectiveDomains({ domains: [] }, "/tmp");
    expect(result).toBeNull();
  });
});

describe("getEffectivePhaseIds", () => {
  it("returns phase IDs when config has phases", () => {
    const result = getEffectivePhaseIds({
      phases: [
        { id: 1, name: "Alpha" },
        { id: 2, name: "Beta" },
      ],
    });
    expect(result).toEqual([1, 2]);
  });

  it("returns null when config is null", () => {
    expect(getEffectivePhaseIds(null)).toBeNull();
  });

  it("returns null when config has no phases", () => {
    expect(getEffectivePhaseIds({ name: "test" })).toBeNull();
  });

  it("returns null when config has empty phases array", () => {
    expect(getEffectivePhaseIds({ phases: [] })).toBeNull();
  });
});
