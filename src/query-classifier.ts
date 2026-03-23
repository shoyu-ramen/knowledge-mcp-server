import type { KnowledgeConfig } from "./config.js";

export interface QueryClassification {
  domains: string[];
  phases: number[];
  queryType: "broad" | "specific" | "decision" | "procedural" | "troubleshooting";
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

  // Build bidirectional synonym map from config
  const rawSynonyms = config?.synonyms ?? {};
  const synonymMap: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(rawSynonyms)) {
    // Forward: key → values
    if (!synonymMap[key]) synonymMap[key] = [];
    for (const v of values) {
      if (!synonymMap[key].includes(v)) synonymMap[key].push(v);
    }
    // Reverse: each value → [key, ...other values]
    for (const v of values) {
      const vLower = v.toLowerCase();
      if (!synonymMap[vLower]) synonymMap[vLower] = [];
      if (!synonymMap[vLower].includes(key)) synonymMap[vLower].push(key);
      for (const other of values) {
        if (other.toLowerCase() !== vLower && !synonymMap[vLower].includes(other)) {
          synonymMap[vLower].push(other);
        }
      }
    }
  }

  return { domainKeywords, phasePatterns, synonymMap };
}

// These are linguistically universal — not project-specific
const DECISION_KEYWORDS = [
  "why did we",
  "why do we",
  "why not",
  "decision",
  "chose",
  "choose",
  "trade-off",
  "tradeoff",
  "vs",
  "versus",
  "compared to",
  "compared with",
  "alternative",
  "rationale",
  "reason for",
  "how did we decide",
  "pros and cons",
];

const PROCEDURAL_KEYWORDS = [
  "how to",
  "how do i",
  "how do you",
  "steps to",
  "guide for",
  "guide to",
  "tutorial",
  "walkthrough",
  "instructions for",
  "setup",
  "set up",
  "configure",
  "install",
];

const TROUBLESHOOTING_KEYWORDS = [
  "error",
  "fix for",
  "fix the",
  "broken",
  "issue with",
  "problem with",
  "debug",
  "doesn't work",
  "does not work",
  "fails",
  "failing",
  "crash",
  "not working",
  "troubleshoot",
  "resolve",
];

export function expandSynonyms(query: string, synonymMap: Record<string, string[]>): string {
  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/);
  const expansions: string[] = [];

  // Bigram pass: check two-token phrases first (e.g., "tech stack")
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i].replace(/[^a-z0-9-]/g, "")} ${tokens[i + 1].replace(/[^a-z0-9-]/g, "")}`;
    const synonyms = synonymMap[bigram];
    if (synonyms) {
      expansions.push(...synonyms);
    }
  }

  // Single-token pass
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
  } else if (PROCEDURAL_KEYWORDS.some((kw) => lower.includes(kw))) {
    queryType = "procedural";
  } else if (TROUBLESHOOTING_KEYWORDS.some((kw) => lower.includes(kw))) {
    queryType = "troubleshooting";
  } else if (
    lower.startsWith("how does") ||
    lower.startsWith("what is") ||
    lower.startsWith("overview") ||
    lower.startsWith("explain") ||
    lower.includes("tell me about")
  ) {
    queryType = "broad";
  }

  return { domains, phases, queryType };
}
