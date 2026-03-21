import { describe, it, expect } from "vitest";
import {
  classifyQuery,
  expandSynonyms,
  buildClassifierConfig,
  type ClassifierConfig,
} from "../src/query-classifier.js";

// Guitar-app-specific config (mirrors the old hardcoded constants)
const GUITAR_APP_CONFIG: ClassifierConfig = buildClassifierConfig({
  query_hints: {
    technology: ["crepe", "yin", "pitch", "pipeline", "ml", "audio", "detection"],
    architecture: ["flutter", "riverpod", "drift", "supabase", "tech stack"],
    business: ["pricing", "subscription", "revenue", "churn"],
    competitive: ["yousician", "fender play", "rocksmith"],
  },
  phases: [
    { id: 1, name: "Foundation", aliases: ["launch", "mvp"] },
    { id: 2, name: "Differentiation" },
    { id: 3, name: "Platform" },
  ],
  synonyms: {
    dkt: ["deep knowledge tracing"],
    ml: ["machine learning"],
    ai: ["artificial intelligence"],
  },
});

const EMPTY_CONFIG: ClassifierConfig = buildClassifierConfig(null);

describe("classifyQuery with project config", () => {
  it("detects technology domain from keywords", () => {
    const result = classifyQuery("CREPE pitch detection pipeline", GUITAR_APP_CONFIG);
    expect(result.domains).toContain("technology");
  });

  it("detects multiple domains", () => {
    const result = classifyQuery("pricing for Flutter app", GUITAR_APP_CONFIG);
    expect(result.domains).toContain("business");
    expect(result.domains).toContain("architecture");
  });

  it("detects phase from named pattern", () => {
    const result = classifyQuery("Foundation phase features", GUITAR_APP_CONFIG);
    expect(result.phases).toContain(1);
  });

  it("detects phase from alias", () => {
    const result = classifyQuery("mvp scope", GUITAR_APP_CONFIG);
    expect(result.phases).toContain(1);
  });

  it("classifies specific queries with domain match", () => {
    const result = classifyQuery("CREPE latency benchmarks", GUITAR_APP_CONFIG);
    expect(result.queryType).toBe("specific");
  });
});

describe("classifyQuery generic behavior", () => {
  it("detects generic phase N patterns without config", () => {
    const result = classifyQuery("phase 1 MVP features", EMPTY_CONFIG);
    expect(result.phases).toContain(1);
  });

  it("detects arbitrary phase numbers", () => {
    const result = classifyQuery("phase 5 features", EMPTY_CONFIG);
    expect(result.phases).toContain(5);
  });

  it("classifies decision queries", () => {
    const result = classifyQuery("why did we choose X over Y", EMPTY_CONFIG);
    expect(result.queryType).toBe("decision");
  });

  it("classifies broad queries", () => {
    const result = classifyQuery("what is the tech stack", EMPTY_CONFIG);
    expect(result.queryType).toBe("broad");
  });

  it("returns empty domains when no config", () => {
    const result = classifyQuery("CREPE pitch detection", EMPTY_CONFIG);
    expect(result.domains).toEqual([]);
  });

  it("classifies as broad when no domains matched", () => {
    const result = classifyQuery("CREPE pitch detection", EMPTY_CONFIG);
    expect(result.queryType).toBe("broad");
  });
});

describe("expandSynonyms", () => {
  it("expands acronyms from config", () => {
    const expanded = expandSynonyms("what about DKT", GUITAR_APP_CONFIG.synonymMap);
    expect(expanded).toContain("deep knowledge tracing");
  });

  it("returns original query when no synonyms match", () => {
    const expanded = expandSynonyms("pitch detection", GUITAR_APP_CONFIG.synonymMap);
    expect(expanded).toBe("pitch detection");
  });

  it("expands multiple synonyms", () => {
    const expanded = expandSynonyms("ML and AI in the app", GUITAR_APP_CONFIG.synonymMap);
    expect(expanded).toContain("machine learning");
    expect(expanded).toContain("artificial intelligence");
  });

  it("returns original when synonym map is empty", () => {
    const expanded = expandSynonyms("what about DKT", {});
    expect(expanded).toBe("what about DKT");
  });
});

describe("buildClassifierConfig", () => {
  it("returns empty config when input is null", () => {
    const config = buildClassifierConfig(null);
    expect(config.domainKeywords).toEqual({});
    expect(config.synonymMap).toEqual({});
    // Should still have the generic "phase N" pattern
    expect(config.phasePatterns.length).toBeGreaterThanOrEqual(1);
  });

  it("builds phase patterns from config", () => {
    const config = buildClassifierConfig({
      phases: [
        { id: 1, name: "Alpha", aliases: ["start"] },
        { id: 2, name: "Beta" },
      ],
    });
    // 1 generic + 1 "Alpha" + 1 "start" + 1 "Beta" = 4
    expect(config.phasePatterns).toHaveLength(4);
  });
});
