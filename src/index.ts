import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatLookupResult,
  formatBatchLookupResult,
  formatGraphResult,
  formatWriteResult,
  formatDeleteResult,
  formatListResult,
} from "./formatter.js";
import { formatValidationReport } from "./validator.js";
import { formatStats } from "./analytics.js";
import { KnowledgeEngine } from "./engine.js";
import type { KnowledgeGraph } from "./graph.js";
import type { KnowledgeConfig } from "./config.js";
import type { TfIdfIndex } from "./search.js";
import { VERSION } from "./constants.js";

export interface KnowledgeServerResult {
  server: McpServer;
  engine: KnowledgeEngine;
  /** @deprecated Use engine.graph */
  graph: KnowledgeGraph;
  /** @deprecated Use engine.bm25Index */
  tfidfIndex: TfIdfIndex;
  config: KnowledgeConfig | null;
}

export function createKnowledgeServer(knowledgeDir: string): KnowledgeServerResult {
  const engine = new KnowledgeEngine(knowledgeDir);

  const server = new McpServer({
    name: "knowledge",
    version: VERSION,
  });

  // Tool 1: knowledge_search
  server.tool(
    "knowledge_search",
    `Semantic hybrid search (BM25 + vector) over the ${engine.config?.name || "project"} knowledge graph. Use this as your primary entry point for any question — it handles natural language queries and automatically includes parent context. Prefer knowledge_lookup when you already know the exact document ID.`,
    {
      query: z.string().describe("Natural language query"),
      domains: z
        .array(z.string())
        .optional()
        .describe(
          engine.validDomains
            ? `Pre-filter to specific domains: ${engine.validDomains.join(", ")}`
            : "Pre-filter to specific domains (auto-discovered from directory structure)"
        ),
      phases: z
        .array(z.number())
        .optional()
        .describe(
          engine.validPhaseIds
            ? `Pre-filter to specific phases: ${engine.validPhaseIds.join(", ")}`
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
        .enum(["compact", "summary", "normal", "full"])
        .optional()
        .default("summary")
        .describe(
          'Content detail level: "compact" (~200 words, metadata only for ancestors/related), "summary" (~40-500 words, default), "normal" (~80-1500 words), "full" (no truncation)'
        ),
      include_drafts: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include draft documents in results (default false)"),
      include_ancestors: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include ancestor (parent summary) documents in results (default false)"),
      include_facets: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include facet counts (domain/type/phase distribution) in results (default false)"
        ),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include debug metadata (similarity scores, match fields, file paths) in results (default false)"
        ),
    },
    { readOnlyHint: true },
    async ({
      query,
      domains,
      phases,
      tags,
      type,
      max_results,
      detail_level,
      include_drafts,
      include_ancestors,
      include_facets,
      verbose,
    }) => {
      const result = await engine.search({
        query,
        domains,
        phases,
        tags,
        type,
        maxResults: max_results,
        detailLevel: detail_level,
        includeDrafts: include_drafts,
        includeAncestors: include_ancestors,
        includeFacets: include_facets,
        verbose,
      });
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // Tool 2: knowledge_lookup
  server.tool(
    "knowledge_lookup",
    "Retrieve one or more documents by exact ID. Use this when you know the document ID. Accepts a single ID string or an array of IDs (max 10). Returns full document content with optional ancestor summaries and related documents.",
    {
      id: z
        .union([z.string(), z.array(z.string())])
        .describe(
          'Document ID or array of IDs, e.g., "technology/audio-detection/pitch-detection" or ["technology/a", "technology/b"]'
        ),
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
        .enum(["full", "summary", "compact"])
        .optional()
        .default("full")
        .describe(
          'Content level: "full" (complete content, default), "summary" (truncated), or "compact" (~200 words, metadata only for ancestors)'
        ),
    },
    { readOnlyHint: true },
    async ({ id, include_ancestors, include_related, content }) => {
      const lookupIds = (Array.isArray(id) ? id : [id]).slice(0, 10);
      const result = engine.lookup(lookupIds, {
        includeAncestors: include_ancestors,
        includeRelated: include_related,
      });

      // Single doc: use fuzzy matching on miss
      if (lookupIds.length === 1 && result.found.length === 0) {
        const docId = lookupIds[0];
        const suggestions = engine.fuzzyMatchId(docId);
        const hint =
          suggestions.length > 0
            ? `\n\nDid you mean:\n${suggestions.map((s) => `  - ${s.id} ("${s.title}")`).join("\n")}`
            : "\n\nUse knowledge_graph to browse available documents.";
        return {
          content: [{ type: "text" as const, text: `Document not found: "${docId}".${hint}` }],
        };
      }

      // Single doc found
      if (lookupIds.length === 1 && result.found.length === 1) {
        const { doc, ancestors, related } = result.found[0];
        return {
          content: [
            { type: "text" as const, text: formatLookupResult(doc, ancestors, related, content) },
          ],
        };
      }

      // Batch: deduplicate ancestors/related across all found docs
      const seen = new Set<string>();
      const allAncestors = [];
      const allRelated = [];
      const allPrimary = [];

      for (const { doc, ancestors, related } of result.found) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          allPrimary.push(doc);
        }
        for (const a of ancestors) {
          if (!seen.has(a.id)) {
            seen.add(a.id);
            allAncestors.push(a);
          }
        }
        for (const r of related) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            allRelated.push(r);
          }
        }
      }

      const parts: string[] = [];
      if (result.notFound.length > 0) {
        parts.push(`Documents not found: ${result.notFound.join(", ")}`);
      }
      if (allPrimary.length > 0) {
        parts.push(formatBatchLookupResult(allPrimary, allAncestors, allRelated, content));
      }
      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    }
  );

  // Tool 3: knowledge_graph
  server.tool(
    "knowledge_graph",
    "Returns the graph structure for a subtree. Use this to understand how documents are organized and connected. Prefer knowledge_search for finding specific information.",
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
    { readOnlyHint: true },
    async ({ root_id, depth, include_related, max_nodes }) => {
      const result = engine.graphView(root_id, depth, include_related, max_nodes);
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Document not found: "${root_id}". Available root domains: ${[...engine.graph.domainIndex.keys()].join(", ")}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: formatGraphResult(
              result.nodes,
              result.edges,
              engine.graph.documents.size,
              root_id
            ),
          },
        ],
      };
    }
  );

  // Tool 4: knowledge_list
  server.tool(
    "knowledge_list",
    "List documents with metadata only (no content). Use this to browse and filter the knowledge base by domain, type, phase, or tags. Prefer knowledge_search when looking for specific information.",
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
    { readOnlyHint: true },
    async ({ domain, type, phase, tags, title_search, include_drafts }) => {
      const result = engine.list({
        domain,
        type,
        phase,
        tags,
        titleSearch: title_search,
        includeDrafts: include_drafts,
      });
      return {
        content: [{ type: "text" as const, text: formatListResult(result.docs, result.totalDocs) }],
      };
    }
  );

  // Tool 5: knowledge_write
  server.tool(
    "knowledge_write",
    "Create or update a document in the knowledge graph. Validates inputs, writes to disk, and updates in-memory indices so the document is immediately searchable. Writing the same content twice is safe (idempotent).",
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
          engine.validDomains
            ? `Top-level domain: ${engine.validDomains.join(", ")}`
            : "Top-level domain (any valid domain directory)"
        ),
      subdomain: z.string().optional().describe("Optional subdomain within the domain"),
      tags: z.array(z.string()).describe("Searchable tags"),
      phase: z
        .array(z.number())
        .describe(
          engine.validPhaseIds
            ? `Applicable phases: ${engine.validPhaseIds.join(", ")}`
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
    { idempotentHint: true },
    async (params) => {
      try {
        const result = await engine.write(params);
        return { content: [{ type: "text" as const, text: formatWriteResult(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool 6: knowledge_delete
  server.tool(
    "knowledge_delete",
    "Delete a document from the knowledge graph. Removes from disk and all in-memory indices. Warns about orphaned children and broken cross-references. Use dry_run=true to preview impact without deleting.",
    {
      id: z.string().describe("Document ID to delete"),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview deletion impact without actually deleting (default false)"),
    },
    { destructiveHint: true },
    async ({ id, dry_run }) => {
      try {
        if (dry_run) {
          const result = engine.previewDelete(id);
          return {
            content: [
              {
                type: "text" as const,
                text: formatDeleteResult({ id, warnings: result.warnings }),
              },
            ],
          };
        }
        const result = await engine.delete(id);
        return { content: [{ type: "text" as const, text: formatDeleteResult(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool 7: knowledge_validate
  server.tool(
    "knowledge_validate",
    "Run graph integrity checks. Call this before a large editing session to identify issues. Reports orphaned documents, broken references, circular parents, missing tags, empty summaries, stale documents, and embedding coverage.",
    {},
    { readOnlyHint: true },
    async () => ({
      content: [{ type: "text" as const, text: formatValidationReport(engine.validate()) }],
    })
  );

  // Tool 8: knowledge_stats
  server.tool(
    "knowledge_stats",
    "Returns metrics about the knowledge graph. Call this to understand the size and shape of the knowledge base before searching. Shows document counts by type/domain/phase, tag distribution, cross-link density, most-connected documents, and embedding coverage.",
    {},
    { readOnlyHint: true },
    async () => ({
      content: [{ type: "text" as const, text: formatStats(engine.stats()) }],
    })
  );

  // MCP Resources: expose documents as knowledge:// URIs
  server.resource(
    "knowledge-document",
    new ResourceTemplate("knowledge://documents/{docId}", {
      list: async () => {
        const resources = [];
        for (const doc of engine.graph.documents.values()) {
          resources.push({
            uri: `knowledge://documents/${encodeURIComponent(doc.id)}`,
            name: doc.title,
            mimeType: "text/markdown",
            description: `[${doc.type}] ${doc.domain}${doc.subdomain ? "/" + doc.subdomain : ""} — ${doc.tags.join(", ")}`,
          });
        }
        return { resources };
      },
    }),
    { description: "Knowledge graph documents as Markdown" },
    async (uri, variables) => {
      const docId = decodeURIComponent(variables.docId as string);
      const doc = engine.graph.documents.get(docId);
      if (!doc) {
        return {
          contents: [
            { uri: uri.href, mimeType: "text/plain", text: `Document not found: ${docId}` },
          ],
        };
      }
      // Return full document content as markdown
      const header = `# ${doc.title}\n\n**ID:** ${doc.id}  \n**Type:** ${doc.type}  \n**Domain:** ${doc.domain}  \n**Tags:** ${doc.tags.join(", ")}  \n**Phase:** ${doc.phase.join(", ")}  \n\n---\n\n`;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: header + doc.contentBody,
          },
        ],
      };
    }
  );

  // Start watching for external file changes
  engine.watch();

  // Clean up file watchers on server close
  server.server.onclose = () => {
    engine.close();
  };

  return {
    server,
    engine,
    graph: engine.graph,
    tfidfIndex: engine.bm25Index,
    config: engine.config,
  };
}

// Re-export key types for programmatic consumers
export { KnowledgeEngine } from "./engine.js";
export type { KnowledgeGraph } from "./graph.js";
export type { KnowledgeDocument } from "./loader.js";
export type { KnowledgeConfig } from "./config.js";
