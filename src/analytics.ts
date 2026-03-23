import type { KnowledgeGraph } from "./graph.js";
import { SIX_MONTHS_MS } from "./constants.js";

export interface ContentQualityItem {
  id: string;
  score: number;
  issues: string[];
}

export interface GraphStats {
  totalDocs: number;
  byType: Map<string, number>;
  byDomain: Map<string, number>;
  byPhase: Map<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  crossLinkDensity: number;
  mostConnected: Array<{ id: string; connections: number }>;
  orphanCount: number;
  embeddingCoverage: { total: number; covered: number; percent: number };
  contentQuality: ContentQualityItem[];
}

export function computeStats(graph: KnowledgeGraph): GraphStats {
  const byType = new Map<string, number>();
  const byDomain = new Map<string, number>();
  const byPhase = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const connectionCounts = new Map<string, number>();
  let totalRelated = 0;
  let orphanCount = 0;

  for (const doc of graph.documents.values()) {
    // By type
    byType.set(doc.type, (byType.get(doc.type) || 0) + 1);

    // By domain
    byDomain.set(doc.domain, (byDomain.get(doc.domain) || 0) + 1);

    // By phase
    for (const p of doc.phase) {
      const key = `phase-${p}`;
      byPhase.set(key, (byPhase.get(key) || 0) + 1);
    }

    // Tag counts
    for (const tag of doc.tags) {
      const lower = tag.toLowerCase();
      tagCounts.set(lower, (tagCounts.get(lower) || 0) + 1);
    }

    // Connection counts (forward related + backlinks)
    const forwardCount = doc.related.length;
    const backlinks = graph.backlinkIndex.get(doc.id);
    const backlinkCount = backlinks ? backlinks.size : 0;
    const total = forwardCount + backlinkCount;
    connectionCounts.set(doc.id, total);
    totalRelated += forwardCount;

    // Orphan: no related links in or out
    if (forwardCount === 0 && backlinkCount === 0) {
      orphanCount++;
    }
  }

  // Top 20 tags by frequency
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  // Most connected docs (top 5)
  const mostConnected = [...connectionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, connections]) => ({ id, connections }));

  // Cross-link density
  const totalDocs = graph.documents.size;
  const crossLinkDensity = totalDocs > 0 ? Math.round((totalRelated / totalDocs) * 100) / 100 : 0;

  // Embedding coverage
  const covered = [...graph.documents.keys()].filter((id) =>
    graph.embeddings.vectors.has(id)
  ).length;

  // Content quality scoring
  const now = Date.now();
  const contentQuality: ContentQualityItem[] = [];
  for (const doc of graph.documents.values()) {
    let score = 100;
    const issues: string[] = [];

    // Freshness: penalize stale docs
    if (doc.lastUpdated) {
      const age = now - new Date(doc.lastUpdated).getTime();
      if (age > SIX_MONTHS_MS) {
        score -= 15;
        issues.push("stale (>6 months)");
      }
    } else {
      score -= 10;
      issues.push("no last_updated date");
    }

    // Completeness: word count vs type expectations
    const minWords = doc.type === "summary" ? 20 : doc.type === "detail" ? 100 : 30;
    if (doc.wordCount < minWords) {
      score -= 20;
      issues.push(`short content (${doc.wordCount} words, expected ${minWords}+)`);
    }

    // Link density
    if (doc.related.length === 0) {
      score -= 10;
      issues.push("no related links");
    }

    // Tags
    if (doc.tags.length === 0) {
      score -= 15;
      issues.push("no tags");
    }

    // Heading structure (for detail/reference docs)
    if ((doc.type === "detail" || doc.type === "reference") && !doc.contentBody.includes("## ")) {
      score -= 10;
      issues.push("no section headings");
    }

    if (score < 100) {
      contentQuality.push({ id: doc.id, score: Math.max(0, score), issues });
    }
  }
  contentQuality.sort((a, b) => a.score - b.score);

  return {
    totalDocs,
    byType,
    byDomain,
    byPhase,
    topTags,
    crossLinkDensity,
    mostConnected,
    orphanCount,
    embeddingCoverage: {
      total: totalDocs,
      covered,
      percent: totalDocs > 0 ? Math.round((covered / totalDocs) * 100) : 0,
    },
    contentQuality,
  };
}

export function formatStats(stats: GraphStats): string {
  const lines: string[] = ["Knowledge Graph Statistics", "=".repeat(26), ""];

  lines.push(`Total documents: ${stats.totalDocs}`);
  lines.push("");

  lines.push("By type:");
  for (const [type, count] of [...stats.byType].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type}: ${count}`);
  }
  lines.push("");

  lines.push("By domain:");
  for (const [domain, count] of [...stats.byDomain].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${domain}: ${count}`);
  }
  lines.push("");

  lines.push("By phase:");
  for (const [phase, count] of [...stats.byPhase].sort()) {
    lines.push(`  ${phase}: ${count}`);
  }
  lines.push("");

  lines.push("Top tags:");
  for (const { tag, count } of stats.topTags) {
    lines.push(`  ${tag}: ${count}`);
  }
  lines.push("");

  lines.push(`Cross-link density: ${stats.crossLinkDensity} related links/doc (avg)`);
  lines.push(`Unlinked documents: ${stats.orphanCount}`);
  lines.push("");

  lines.push("Most connected documents:");
  for (const { id, connections } of stats.mostConnected) {
    lines.push(`  ${id}: ${connections} connections`);
  }
  lines.push("");

  lines.push(
    `Embedding coverage: ${stats.embeddingCoverage.covered}/${stats.embeddingCoverage.total} (${stats.embeddingCoverage.percent}%)`
  );

  if (stats.contentQuality.length > 0) {
    lines.push("");
    lines.push(`Content quality issues: ${stats.contentQuality.length} documents`);
    for (const item of stats.contentQuality.slice(0, 10)) {
      lines.push(`  ${item.id} (score: ${item.score}): ${item.issues.join(", ")}`);
    }
    if (stats.contentQuality.length > 10) {
      lines.push(`  ... and ${stats.contentQuality.length - 10} more`);
    }
  }

  return lines.join("\n");
}
