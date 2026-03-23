/**
 * Search analytics — logs queries to a .jsonl file for insight into usage patterns.
 */

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

export interface QueryLogEntry {
  query: string;
  timestamp: string;
  method: string;
  resultCount: number;
  confidence: string;
  topDocId: string | null;
  ms: number;
}

const ANALYTICS_FILENAME = ".search-analytics.jsonl";

/** Append a query log entry to the analytics file. Best-effort, never throws. */
export function logQuery(knowledgeDir: string, entry: QueryLogEntry): void {
  try {
    const filePath = join(knowledgeDir, ANALYTICS_FILENAME);
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.debug("analytics_log_error", { error: String(err) });
  }
}

/** Load all analytics entries. Returns empty array if file missing or corrupt. */
export function loadAnalytics(knowledgeDir: string): QueryLogEntry[] {
  const filePath = join(knowledgeDir, ANALYTICS_FILENAME);
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const entries: QueryLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as QueryLogEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Format analytics summary for CLI output. */
export function formatAnalytics(entries: QueryLogEntry[]): string {
  if (entries.length === 0) return "No search analytics recorded yet.";

  const lines: string[] = [`Search Analytics: ${entries.length} queries recorded`, ""];

  // Top queries by frequency
  const queryCounts = new Map<string, number>();
  for (const e of entries) {
    const q = e.query.toLowerCase().trim();
    queryCounts.set(q, (queryCounts.get(q) || 0) + 1);
  }
  const topQueries = [...queryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  lines.push("Top queries:");
  for (const [query, count] of topQueries) {
    lines.push(`  ${count}x  "${query}"`);
  }

  // Confidence distribution
  const confCounts = { high: 0, medium: 0, low: 0 };
  for (const e of entries) {
    if (e.confidence in confCounts) {
      confCounts[e.confidence as keyof typeof confCounts]++;
    }
  }
  lines.push("");
  lines.push(
    `Confidence: high=${confCounts.high} medium=${confCounts.medium} low=${confCounts.low}`
  );

  // Average response time
  const avgMs = entries.reduce((sum, e) => sum + e.ms, 0) / entries.length;
  lines.push(`Average response time: ${Math.round(avgMs)}ms`);

  // Zero-result queries
  const zeroResults = entries.filter((e) => e.resultCount === 0).length;
  if (zeroResults > 0) {
    lines.push(
      `Zero-result queries: ${zeroResults} (${Math.round((zeroResults / entries.length) * 100)}%)`
    );
  }

  return lines.join("\n");
}
