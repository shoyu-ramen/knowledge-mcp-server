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
    return parsed as KnowledgeConfig;
  } catch (err) {
    log.warn("config", {
      error: `Failed to parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
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
