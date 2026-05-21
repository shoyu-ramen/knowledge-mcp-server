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
    `Hybrid BM25 + vector search over the ${engine.config?.name || "project"} knowledge graph. Use for natural-language queries; prefer knowledge_lookup when you know the document ID.`,
    {
      query: z.string().describe("Natural language query"),
      domains: z
        .array(z.string())
        .optional()
        .describe(
          engine.validDomains
            ? `Filter to domains: ${engine.validDomains.join(", ")}`
            : "Filter to domains"
        ),
      phases: z
        .array(z.number())
        .optional()
        .describe(
          engine.validPhaseIds
            ? `Filter to phases: ${engine.validPhaseIds.join(", ")}`
            : "Filter to phases"
        ),
      tags: z.array(z.string()).optional(),
      type: z.enum(["summary", "detail", "decision", "reference"]).optional(),
      max_results: z.number().optional().default(10),
      detail_level: z
        .enum(["compact", "summary", "normal", "full"])
        .optional()
        .default("summary")
        .describe('Content size per result: compact (~200w), summary (default), normal, full'),
      include_drafts: z.boolean().optional().default(false),
      include_ancestors: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include parent summary documents"),
      include_facets: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include domain/type/phase counts"),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include similarity scores, match fields, and file paths"),
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
    "Fetch one or more documents by exact ID (single string or array, max 10).",
    {
      id: z
        .union([z.string(), z.array(z.string())])
        .describe('Document ID or array of IDs, e.g. "technology/audio/pitch-detection"'),
      include_ancestors: z.boolean().optional().default(true),
      include_related: z.boolean().optional().default(false),
      content: z
        .enum(["full", "summary", "compact"])
        .optional()
        .default("full")
        .describe("Content size: full (default), summary, compact (~200w)"),
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
    "Return the graph structure for a subtree. Use for browsing connections; prefer knowledge_search for content.",
    {
      root_id: z.string().optional().default("root"),
      depth: z.number().optional().default(2).describe("Levels to traverse (max 4)"),
      include_related: z.boolean().optional().default(false),
      max_nodes: z.number().optional().default(50),
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
    "List documents (metadata only, no content). Use for browsing/filtering; prefer knowledge_search for content lookup.",
    {
      domain: z.string().optional(),
      type: z.enum(["summary", "detail", "decision", "reference"]).optional(),
      phase: z.number().optional(),
      tags: z.array(z.string()).optional(),
      title_search: z.string().optional().describe("Substring match on title"),
      include_drafts: z.boolean().optional().default(false),
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
    "Create or update a document. Idempotent; document is immediately searchable.",
    {
      id: z.string().describe('Lowercase, hyphens, slashes (e.g. "technology/audio/pitch")'),
      title: z.string(),
      type: z
        .enum(["summary", "detail", "decision", "reference"])
        .describe("summary=overview, detail=analysis, decision=choice, reference=external"),
      domain: z
        .string()
        .describe(
          engine.validDomains ? `One of: ${engine.validDomains.join(", ")}` : "Top-level domain"
        ),
      subdomain: z.string().optional(),
      tags: z.array(z.string()),
      phase: z
        .array(z.number())
        .describe(
          engine.validPhaseIds
            ? `One of: ${engine.validPhaseIds.join(", ")}`
            : "Applicable phase numbers"
        ),
      related: z.array(z.string()).optional().describe("Cross-reference document IDs"),
      children: z.array(z.string()).optional().describe("Only for summary type"),
      content: z.string().describe("Markdown body (no frontmatter)"),
      status: z
        .enum(["active", "draft", "deprecated"])
        .optional()
        .describe("draft excluded from search; deprecated ranked lower"),
      superseded_by: z.string().optional(),
      decision_status: z
        .enum(["proposed", "accepted", "deprecated", "superseded", "finalized"])
        .optional()
        .describe("Decision type only"),
      alternatives_considered: z.array(z.string()).optional().describe("Decision type only"),
      decision_date: z.string().optional().describe("ISO date, decision type only"),
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
    "Delete a document. Warns about orphaned children and broken cross-references.",
    {
      id: z.string(),
      dry_run: z.boolean().optional().default(false).describe("Preview impact without deleting"),
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
    "Check graph integrity: orphans, broken references, circular parents, stale docs, embedding coverage.",
    {},
    { readOnlyHint: true },
    async () => ({
      content: [{ type: "text" as const, text: formatValidationReport(engine.validate()) }],
    })
  );

  // Tool 8: knowledge_stats
  server.tool(
    "knowledge_stats",
    "Graph metrics: counts by type/domain/phase, tag distribution, cross-link density, embedding coverage.",
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
