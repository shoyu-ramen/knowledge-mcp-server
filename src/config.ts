import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { log } from "./logger.js";

export interface PhaseConfig {
  id: number;
  name: string;
  aliases?: string[];
}

export interface KnowledgeConfig {
  name?: string;
  domains?: string[];
  phases?: PhaseConfig[];
  query_hints?: Record<string, string[]>;
  synonyms?: Record<string, string[]>;
  embeddings?: {
    provider?: string;
    model?: string;
    api_key_env?: string;
    cache_dir?: string;
  };
  bm25?: {
    k1?: number;
    b?: number;
  };
}

const CONFIG_FILENAME = "knowledge.config.yaml";

/**
 * Load knowledge.config.yaml from the knowledge directory root.
 * Returns null if the file is missing or invalid.
 */
export function loadConfig(knowledgeDir: string): KnowledgeConfig | null {
  const configPath = join(knowledgeDir, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist — zero-config mode
    return null;
  }

  try {
    const parsed = parseYaml(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      log.warn("config", { error: "Config file is empty or not an object" });
      return null;
    }
    const { config, warnings } = validateConfig(parsed as Record<string, unknown>);
    for (const w of warnings) {
      log.warn("config_validation", { warning: w });
    }
    return config;
  } catch (err) {
    const message = `Failed to parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`;
    log.error("config", { error: message });
    throw new Error(message, { cause: err });
  }
}

/**
 * Discover domains by scanning top-level directories in the knowledge directory.
 * Excludes directories starting with ".".
 */
export function discoverDomains(knowledgeDir: string): string[] {
  try {
    return readdirSync(knowledgeDir)
      .filter((entry) => {
        if (entry.startsWith(".")) return false;
        try {
          return statSync(join(knowledgeDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Return the effective domain list for validation.
 * - If config specifies domains, return them (strict validation).
 * - Otherwise return null (permissive — accept any domain).
 */
export function getEffectiveDomains(
  config: KnowledgeConfig | null,
  _knowledgeDir: string
): string[] | null {
  if (config?.domains && config.domains.length > 0) {
    return config.domains;
  }
  return null;
}

/**
 * Return the effective phase IDs for validation.
 * - If config specifies phases, return their IDs (strict validation).
 * - Otherwise return null (permissive — accept any positive integer).
 */
export function getEffectivePhaseIds(config: KnowledgeConfig | null): number[] | null {
  if (config?.phases && config.phases.length > 0) {
    return config.phases.map((p) => p.id);
  }
  return null;
}

// --- Structural config validation ---

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "name",
  "domains",
  "phases",
  "query_hints",
  "synonyms",
  "embeddings",
  "bm25",
]);

/**
 * Validate the structure of a parsed config object.
 * Returns the config and any non-fatal warnings.
 */
export function validateConfig(parsed: Record<string, unknown>): {
  config: KnowledgeConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Warn on unknown top-level keys
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown config key "${key}" — will be ignored.`);
    }
  }

  // Validate domains
  if (parsed.domains !== undefined) {
    if (!Array.isArray(parsed.domains)) {
      warnings.push(`"domains" must be an array of strings.`);
    } else if (parsed.domains.some((d: unknown) => typeof d !== "string")) {
      warnings.push(`"domains" contains non-string values.`);
    }
  }

  // Validate phases
  if (parsed.phases !== undefined) {
    if (!Array.isArray(parsed.phases)) {
      warnings.push(`"phases" must be an array of { id, name } objects.`);
    } else {
      for (const p of parsed.phases as unknown[]) {
        if (!p || typeof p !== "object" || !("id" in p) || !("name" in p)) {
          warnings.push(`Each phase must have "id" (number) and "name" (string) fields.`);
          break;
        }
      }
    }
  }

  // Validate embeddings
  if (parsed.embeddings !== undefined) {
    if (!parsed.embeddings || typeof parsed.embeddings !== "object") {
      warnings.push(`"embeddings" must be an object.`);
    } else {
      const emb = parsed.embeddings as Record<string, unknown>;
      if (emb.provider !== undefined && emb.provider !== "local" && emb.provider !== "voyage") {
        warnings.push(`"embeddings.provider" must be "local" or "voyage".`);
      }
    }
  }

  // Validate bm25
  if (parsed.bm25 !== undefined) {
    if (!parsed.bm25 || typeof parsed.bm25 !== "object") {
      warnings.push(`"bm25" must be an object with optional k1/b numbers.`);
    } else {
      const bm25 = parsed.bm25 as Record<string, unknown>;
      if (bm25.k1 !== undefined && typeof bm25.k1 !== "number") {
        warnings.push(`"bm25.k1" must be a number.`);
      }
      if (bm25.b !== undefined && typeof bm25.b !== "number") {
        warnings.push(`"bm25.b" must be a number.`);
      }
    }
  }

  return { config: parsed as KnowledgeConfig, warnings };
}
