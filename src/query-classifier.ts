import type { KnowledgeConfig } from "./config.js";

export interface QueryClassification {
  domains: string[];
  phases: number[];
  queryType: "broad" | "specific" | "decision";
}

export interface ClassifierConfig {
  domainKeywords: Record<string, string[]>;
  phasePatterns: Array<{ pattern: RegExp; phase: number; dynamic?: boolean }>;
  synonymMap: Record<string, string[]>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a ClassifierConfig from a KnowledgeConfig.
 * When config is null (zero-config mode), returns empty config —
 * search still works via BM25 + embeddings, just without domain pre-filtering.
 */
export function buildClassifierConfig(config: KnowledgeConfig | null): ClassifierConfig {
  const domainKeywords = config?.query_hints ?? {};

  // Always include generic "phase N" pattern (dynamic extraction)
  const phasePatterns: ClassifierConfig["phasePatterns"] = [
    { pattern: /\bphase\s*(\d+)\b/i, phase: 0, dynamic: true },
  ];

  // Add configured phase name + alias patterns
  if (config?.phases) {
    for (const p of config.phases) {
      phasePatterns.push({
        pattern: new RegExp(`\\b${escapeRegex(p.name)}\\b`, "i"),
        phase: p.id,
      });
      if (p.aliases) {
        for (const alias of p.aliases) {
          phasePatterns.push({
            pattern: new RegExp(`\\b${escapeRegex(alias)}\\b`, "i"),
            phase: p.id,
          });
        }
      }
    }
  }

  const synonymMap = config?.synonyms ?? {};

  return { domainKeywords, phasePatterns, synonymMap };
}

// These are linguistically universal — not project-specific
const DECISION_KEYWORDS = [
  "why did we",
  "why do we",
  "decision",
  "chose",
  "choose",
  "trade-off",
  "tradeoff",
  "vs",
  "versus",
  "compared to",
  "alternative",
  "rationale",
];

export function expandSynonyms(query: string, synonymMap: Record<string, string[]>): string {
  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/);
  const expansions: string[] = [];

  for (const token of tokens) {
    const clean = token.replace(/[^a-z0-9-]/g, "");
    const synonyms = synonymMap[clean];
    if (synonyms) {
      expansions.push(...synonyms);
    }
  }

  if (expansions.length === 0) return query;
  return `${query} ${expansions.join(" ")}`;
}

export function classifyQuery(query: string, config: ClassifierConfig): QueryClassification {
  const lower = query.toLowerCase();
  const domains: string[] = [];
  const phases: number[] = [];

  // Domain classification from config keywords
  for (const [domain, keywords] of Object.entries(config.domainKeywords)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        if (!domains.includes(domain)) {
          domains.push(domain);
        }
        break;
      }
    }
  }

  // Phase detection
  for (const { pattern, phase, dynamic } of config.phasePatterns) {
    if (dynamic) {
      // Dynamic "phase N" pattern — extract the number
      const match = pattern.exec(lower);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > 0 && !phases.includes(n)) {
          phases.push(n);
        }
      }
    } else if (pattern.test(lower) && !phases.includes(phase)) {
      phases.push(phase);
    }
  }

  // Query type detection (universal heuristics, not project-specific)
  let queryType: QueryClassification["queryType"] = "specific";
  if (DECISION_KEYWORDS.some((kw) => lower.includes(kw))) {
    queryType = "decision";
  } else if (
    lower.startsWith("how does") ||
    lower.startsWith("what is") ||
    lower.startsWith("overview") ||
    lower.startsWith("explain") ||
    lower.includes("tell me about") ||
    domains.length === 0
  ) {
    queryType = "broad";
  }

  return { domains, phases, queryType };
}
