import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildGraph, getAncestors, getRelated } from "./graph.js";
import { knowledgeSearch, type TfIdfIndex } from "./search.js";
import { buildTfIdfIndex } from "./embeddings.js";
import {
  formatLookupResult,
  formatGraphResult,
  formatWriteResult,
  formatDeleteResult,
  formatListResult,
} from "./formatter.js";
import { writeDocument, deleteDocument } from "./writer.js";
import { validateGraph, formatValidationReport } from "./validator.js";
import { computeStats, formatStats } from "./analytics.js";
import type { KnowledgeGraph } from "./graph.js";
import type { KnowledgeDocument } from "./loader.js";
import { log } from "./logger.js";
import { loadConfig, getEffectiveDomains, getEffectivePhaseIds, type KnowledgeConfig } from "./config.js";
import { buildClassifierConfig } from "./query-classifier.js";
import { initEmbeddingProvider } from "./embedding-provider.js";

// --- Fuzzy ID matching for knowledge_lookup ---
function fuzzyMatchId(
  g: KnowledgeGraph,
  query: string
): Array<{ id: string; title: string; score: number }> {
  const lower = query.toLowerCase();
  const queryTokens = lower.split(/[\s\-/]+/).filter(Boolean);
  const candidates: Array<{ id: string; title: string; score: number }> = [];

  for (const doc of g.documents.values()) {
    let score = 0;
    const idLower = doc.id.toLowerCase();
    const titleLower = doc.title.toLowerCase();

    // Substring match on ID
    if (idLower.includes(lower)) score += 3;
    else if (lower.includes(idLower)) score += 2;

    // Substring match on title
    if (titleLower.includes(lower)) score += 2;

    // Token overlap
    const idTokens = idLower.split(/[-/]+/);
    const titleTokens = titleLower.split(/\s+/);
    for (const qt of queryTokens) {
      if (idTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
      if (titleTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
    }

    if (score > 0) candidates.push({ id: doc.id, title: doc.title, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

export interface KnowledgeServerResult {
  server: McpServer;
  graph: KnowledgeGraph;
  tfidfIndex: TfIdfIndex;
  config: KnowledgeConfig | null;
}

export function createKnowledgeServer(knowledgeDir: string): KnowledgeServerResult {
  const start = Date.now();
  const config = loadConfig(knowledgeDir);
  initEmbeddingProvider(config?.embeddings);
  const validDomains = getEffectiveDomains(config, knowledgeDir);
  const validPhaseIds = getEffectivePhaseIds(config);
  const graph = buildGraph(knowledgeDir, validDomains);
  let tfidfIndex = buildTfIdfIndex(graph.documents);
  const classifierConfig = buildClassifierConfig(config);
  const elapsed = Date.now() - start;
  log.info("startup", {
    docs: graph.documents.size,
    embeddings: graph.embeddings.vectors.size,
    embeddingsAvailable: graph.embeddings.available,
    ms: elapsed,
  });

  // --- Write serialization queue (prevents concurrent index corruption) ---
  let writeQueue: Promise<unknown> = Promise.resolve();
  function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(fn);
    writeQueue = result.catch(() => {});
    return result;
  }

  const server = new McpServer({
    name: "knowledge",
    version: "1.0.0",
  });

  // Tool 1: knowledge_search
  server.tool(
    "knowledge_search",
    `Semantic search over the ${config?.name || "project"} knowledge graph. Returns relevant documents with ancestor context and cross-references, formatted as XML.`,
    {
      query: z.string().describe("Natural language query"),
      domains: z
        .array(z.string())
        .optional()
        .describe(
          validDomains
            ? `Pre-filter to specific domains: ${validDomains.join(", ")}`
            : "Pre-filter to specific domains (auto-discovered from directory structure)"
        ),
      phases: z
        .array(z.number())
        .optional()
        .describe(
          validPhaseIds
            ? `Pre-filter to specific phases: ${validPhaseIds.join(", ")}`
            : "Pre-filter to specific phases (positive integers)"
        ),
      tags: z.array(z.string()).optional().describe("Require specific tags"),
      type: z
        .enum(["summary", "detail", "decision", "reference"])
        .optional()
        .describe("Filter by document type"),
      max_results: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of documents to return (default 10)"),
      detail_level: z
        .enum(["summary", "normal", "full"])
        .optional()
        .default("normal")
        .describe(
          'Content detail level: "summary" (~40-500 words per doc), "normal" (~80-1500 words, default), "full" (no truncation)'
        ),
      include_drafts: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include draft documents in results (default false)"),
    },
    async ({ query, domains, phases, tags, type, max_results, detail_level, include_drafts }) => {
      const result = await knowledgeSearch(graph, tfidfIndex, {
        query,
        domains,
        phases,
        tags,
        type,
        maxResults: max_results,
        detailLevel: detail_level,
        includeDrafts: include_drafts,
      }, classifierConfig);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // Tool 2: knowledge_lookup
  server.tool(
    "knowledge_lookup",
    "Retrieve one or more documents by ID. Accepts a single `id` string or an `ids` array (max 10). Returns documents with optional ancestor summaries and related documents.",
    {
      id: z
        .string()
        .optional()
        .describe(
          'Single document ID, e.g., "business/pricing-tiers" or "technology/audio-detection/pitch-detection"'
        ),
      ids: z
        .array(z.string())
        .optional()
        .describe("Array of document IDs for batch retrieval (max 10)"),
      include_ancestors: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include parent summary documents (default true)"),
      include_related: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include related documents (default false)"),
      content: z
        .enum(["full", "summary"])
        .optional()
        .default("full")
        .describe('Content level: "full" (complete content, default) or "summary" (truncated)'),
    },
    async ({ id, ids, include_ancestors, include_related, content }) => {
      // Resolve list of IDs (single or batch)
      const lookupIds = ids ? ids.slice(0, 10) : id ? [id] : [];

      if (lookupIds.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "Error: provide either `id` or `ids` parameter." },
          ],
          isError: true,
        };
      }

      // Single document lookup (original behavior with fuzzy matching)
      if (lookupIds.length === 1) {
        const docId = lookupIds[0];
        const doc = graph.documents.get(docId);
        if (!doc) {
          const suggestions = fuzzyMatchId(graph, docId);
          const hint =
            suggestions.length > 0
              ? `\n\nDid you mean:\n${suggestions.map((s) => `  - ${s.id} ("${s.title}")`).join("\n")}`
              : "\n\nUse knowledge_graph to browse available documents.";
          return {
            content: [
              {
                type: "text" as const,
                text: `Document not found: "${docId}".${hint}`,
              },
            ],
          };
        }

        const ancestors = include_ancestors ? getAncestors(graph, docId) : [];
        const related = include_related ? getRelated(graph, docId) : [];

        const result = formatLookupResult(doc, ancestors, related, content);
        return { content: [{ type: "text" as const, text: result }] };
      }

      // Batch lookup: collect all docs, deduplicate ancestors/related
      const seen = new Set<string>();
      const allAncestors: KnowledgeDocument[] = [];
      const allPrimary: KnowledgeDocument[] = [];
      const allRelated: KnowledgeDocument[] = [];
      const notFound: string[] = [];

      for (const docId of lookupIds) {
        const doc = graph.documents.get(docId);
        if (!doc) {
          notFound.push(docId);
          continue;
        }

        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          allPrimary.push(doc);
        }

        if (include_ancestors) {
          for (const a of getAncestors(graph, docId)) {
            if (!seen.has(a.id)) {
              seen.add(a.id);
              allAncestors.push(a);
            }
          }
        }

        if (include_related) {
          for (const r of getRelated(graph, docId)) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              allRelated.push(r);
            }
          }
        }
      }

      // Format as combined lookup (first primary doc is the "main", rest are related-style)
      const parts: string[] = [];
      if (notFound.length > 0) {
        parts.push(`Documents not found: ${notFound.join(", ")}`);
      }
      // Use first primary as the main doc, rest as additional
      if (allPrimary.length > 0) {
        const result = formatLookupResult(
          allPrimary[0],
          allAncestors,
          [...allPrimary.slice(1), ...allRelated],
          content
        );
        parts.push(result);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    }
  );

  // Tool 3: knowledge_graph
  server.tool(
    "knowledge_graph",
    "Returns the graph structure for a subtree. Useful for understanding document relationships and navigating the knowledge base.",
    {
      root_id: z.string().optional().default("root").describe('Starting node ID (default "root")'),
      depth: z
        .number()
        .optional()
        .default(2)
        .describe("Levels deep to traverse (default 2, max 4)"),
      include_related: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include related edges (default false)"),
      max_nodes: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of nodes to return (default 50)"),
    },
    async ({ root_id, depth, include_related, max_nodes }) => {
      const rootDoc = graph.documents.get(root_id);
      if (!rootDoc) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Document not found: "${root_id}". Available root domains: ${[...graph.domainIndex.keys()].join(", ")}`,
            },
          ],
        };
      }

      // Cap depth at 4
      const effectiveDepth = Math.min(depth, 4);

      const nodes: Array<{
        id: string;
        title: string;
        type: string;
        domain: string;
        wordCount: number;
        childrenCount: number;
      }> = [];
      const edges: Array<{
        source: string;
        target: string;
        type: "child" | "related";
      }> = [];
      const visited = new Set<string>();

      function walk(id: string, currentDepth: number) {
        if (visited.has(id) || currentDepth > effectiveDepth || nodes.length >= max_nodes) return;
        visited.add(id);

        const doc = graph.documents.get(id);
        if (!doc) return;

        nodes.push({
          id: doc.id,
          title: doc.title,
          type: doc.type,
          domain: doc.domain,
          wordCount: doc.wordCount,
          childrenCount: doc.childrenIds.length,
        });

        // Child edges
        for (const childId of doc.childrenIds) {
          if (nodes.length >= max_nodes) break;
          edges.push({ source: id, target: childId, type: "child" });
          walk(childId, currentDepth + 1);
        }

        // Related edges (non-recursive)
        if (include_related) {
          for (const relatedId of doc.related) {
            if (graph.documents.has(relatedId)) {
              edges.push({
                source: id,
                target: relatedId,
                type: "related",
              });
              // Add related node if not visited (but don't recurse into it)
              if (!visited.has(relatedId) && nodes.length < max_nodes) {
                const relDoc = graph.documents.get(relatedId)!;
                nodes.push({
                  id: relDoc.id,
                  title: relDoc.title,
                  type: relDoc.type,
                  domain: relDoc.domain,
                  wordCount: relDoc.wordCount,
                  childrenCount: relDoc.childrenIds.length,
                });
                visited.add(relatedId);
              }
            }
          }
        }
      }

      walk(root_id, 0);

      const result = formatGraphResult(nodes, edges, graph.documents.size, root_id);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // Tool 4: knowledge_list
  server.tool(
    "knowledge_list",
    "List documents in the knowledge graph with metadata only (no content). Supports filtering by domain, type, phase, tags, and title search.",
    {
      domain: z.string().optional().describe("Filter by domain"),
      type: z
        .enum(["summary", "detail", "decision", "reference"])
        .optional()
        .describe("Filter by document type"),
      phase: z.number().optional().describe("Filter by phase (1, 2, or 3)"),
      tags: z.array(z.string()).optional().describe("Require specific tags"),
      title_search: z.string().optional().describe("Substring search on document titles"),
      include_drafts: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include draft documents (default false)"),
    },
    async ({ domain, type, phase, tags, title_search, include_drafts }) => {
      const results: Array<{
        id: string;
        title: string;
        type: string;
        domain: string;
        tags: string[];
        wordCount: number;
        status: string;
        lastUpdated?: string;
      }> = [];

      for (const doc of graph.documents.values()) {
        // Apply filters
        if (!include_drafts && doc.status === "draft") continue;
        if (domain && doc.domain.toLowerCase() !== domain.toLowerCase()) continue;
        if (type && doc.type !== type) continue;
        if (phase && !doc.phase.includes(phase)) continue;
        if (tags && tags.length > 0) {
          const docTagsLower = new Set(doc.tags.map((t) => t.toLowerCase()));
          if (!tags.every((t) => docTagsLower.has(t.toLowerCase()))) continue;
        }
        if (title_search && !doc.title.toLowerCase().includes(title_search.toLowerCase())) continue;

        results.push({
          id: doc.id,
          title: doc.title,
          type: doc.type,
          domain: doc.domain,
          tags: doc.tags,
          wordCount: doc.wordCount,
          status: doc.status,
          lastUpdated: doc.lastUpdated,
        });
      }

      // Sort by domain, then ID
      results.sort((a, b) => a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));

      const result = formatListResult(results, graph.documents.size);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // Tool 5: knowledge_write
  server.tool(
    "knowledge_write",
    "Create or update a document in the knowledge graph. Validates inputs, writes to disk, and updates in-memory indices so the document is immediately searchable.",
    {
      id: z
        .string()
        .describe(
          'Document ID, e.g., "technology/audio-detection/pitch-detection". Lowercase, hyphens, slashes only.'
        ),
      title: z.string().describe("Human-readable document title"),
      type: z
        .enum(["summary", "detail", "decision", "reference"])
        .describe(
          "Document type: summary (domain/subdomain overview), detail (deep analysis), decision (choice with alternatives), reference (external tools/datasets)"
        ),
      domain: z
        .string()
        .describe(
          validDomains
            ? `Top-level domain: ${validDomains.join(", ")}`
            : "Top-level domain (any valid domain directory)"
        ),
      subdomain: z.string().optional().describe("Optional subdomain within the domain"),
      tags: z.array(z.string()).describe("Searchable tags"),
      phase: z
        .array(z.number())
        .describe(
          validPhaseIds
            ? `Applicable phases: ${validPhaseIds.join(", ")}`
            : "Applicable phases (positive integers)"
        ),
      related: z
        .array(z.string())
        .optional()
        .describe("IDs of related documents for cross-referencing"),
      children: z
        .array(z.string())
        .optional()
        .describe("Child document IDs (only for summary type)"),
      content: z.string().describe("Markdown body content (no frontmatter)"),
      status: z
        .enum(["active", "draft", "deprecated"])
        .optional()
        .describe(
          'Document status: "active" (default), "draft" (excluded from search), "deprecated" (ranked lower)'
        ),
      superseded_by: z
        .string()
        .optional()
        .describe("ID of document that supersedes this one (for deprecated docs)"),
      decision_status: z
        .enum(["proposed", "accepted", "deprecated", "superseded", "finalized"])
        .optional()
        .describe("Decision status (only for decision type)"),
      alternatives_considered: z
        .array(z.string())
        .optional()
        .describe("List of alternatives that were considered (only for decision type)"),
      decision_date: z
        .string()
        .optional()
        .describe("Date when decision was made, ISO format (only for decision type)"),
    },
    async ({
      id,
      title,
      type,
      domain,
      subdomain,
      tags,
      phase,
      related,
      children,
      content,
      status,
      superseded_by,
      decision_status,
      alternatives_considered,
      decision_date,
    }) =>
      enqueueWrite(async () => {
        try {
          const result = writeDocument(graph, tfidfIndex, knowledgeDir, {
            id,
            title,
            type,
            domain,
            subdomain,
            tags,
            phase,
            related,
            children,
            content,
            status,
            superseded_by,
            decision_status,
            alternatives_considered,
            decision_date,
          }, validDomains, validPhaseIds);
          tfidfIndex = result.tfidfIndex;
          log.info("write", { id, status: result.status });
          return {
            content: [{ type: "text" as const, text: formatWriteResult(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("write_error", { id, error: message });
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      })
  );

  // Tool 6: knowledge_delete
  server.tool(
    "knowledge_delete",
    "Delete a document from the knowledge graph. Removes from disk and all in-memory indices. Warns about orphaned children and broken cross-references.",
    {
      id: z.string().describe("Document ID to delete"),
    },
    async ({ id }) =>
      enqueueWrite(async () => {
        try {
          const result = deleteDocument(graph, tfidfIndex, knowledgeDir, id);
          tfidfIndex = result.tfidfIndex;
          log.info("delete", { id });
          return {
            content: [{ type: "text" as const, text: formatDeleteResult(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("delete_error", { id, error: message });
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      })
  );

  // Tool 7: knowledge_validate
  server.tool(
    "knowledge_validate",
    "Run graph integrity checks. Reports orphaned documents, broken references, circular parents, missing tags, empty summaries, stale documents, and embedding coverage.",
    {},
    async () => {
      const report = validateGraph(graph);
      return {
        content: [{ type: "text" as const, text: formatValidationReport(report) }],
      };
    }
  );

  // Tool 8: knowledge_stats
  server.tool(
    "knowledge_stats",
    "Returns read-only metrics about the knowledge graph: document counts by type/domain/phase, tag distribution, cross-link density, most-connected documents, and embedding coverage.",
    {},
    async () => {
      const stats = computeStats(graph);
      return {
        content: [{ type: "text" as const, text: formatStats(stats) }],
      };
    }
  );

  return { server, graph, tfidfIndex, config };
}

// Re-export key types for programmatic consumers
export type { KnowledgeGraph } from "./graph.js";
export type { KnowledgeDocument } from "./loader.js";
export type { KnowledgeConfig } from "./config.js";
