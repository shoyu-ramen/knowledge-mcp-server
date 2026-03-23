/**
 * Graph export to Mermaid and DOT/Graphviz formats.
 */

import type { KnowledgeGraph } from "./graph.js";

function escapeLabel(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}

function mermaidId(id: string): string {
  // Mermaid node IDs can't contain slashes — replace with underscores
  return id.replace(/\//g, "_");
}

/**
 * Export the knowledge graph as a Mermaid flowchart.
 * If rootId is provided, only exports the subtree rooted there.
 */
export function exportMermaid(graph: KnowledgeGraph, rootId?: string): string {
  const lines: string[] = ["graph TD"];
  const visited = new Set<string>();

  const walk = (id: string, depth: number) => {
    if (visited.has(id) || depth > 4) return;
    visited.add(id);

    const doc = graph.documents.get(id);
    if (!doc) return;

    const mid = mermaidId(id);
    const label = escapeLabel(doc.title);
    const shape =
      doc.type === "summary"
        ? `${mid}[["${label}"]]`
        : doc.type === "decision"
          ? `${mid}{{"${label}"}}`
          : `${mid}["${label}"]`;
    lines.push(`  ${shape}`);

    for (const childId of doc.childrenIds) {
      lines.push(`  ${mid} --> ${mermaidId(childId)}`);
      walk(childId, depth + 1);
    }

    for (const relId of doc.related) {
      if (graph.documents.has(relId)) {
        lines.push(`  ${mid} -.-> ${mermaidId(relId)}`);
      }
    }
  };

  if (rootId) {
    walk(rootId, 0);
  } else {
    // Start from root, then any orphaned top-level docs
    if (graph.documents.has("root")) {
      walk("root", 0);
    }
    for (const doc of graph.documents.values()) {
      if (!visited.has(doc.id)) {
        walk(doc.id, 0);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Export the knowledge graph as DOT (Graphviz) format.
 * If rootId is provided, only exports the subtree rooted there.
 */
export function exportDot(graph: KnowledgeGraph, rootId?: string): string {
  const lines: string[] = ["digraph knowledge {", "  rankdir=TB;", "  node [shape=box];"];
  const visited = new Set<string>();
  const edges: string[] = [];

  const walk = (id: string, depth: number) => {
    if (visited.has(id) || depth > 4) return;
    visited.add(id);

    const doc = graph.documents.get(id);
    if (!doc) return;

    const shape =
      doc.type === "summary"
        ? "folder"
        : doc.type === "decision"
          ? "diamond"
          : doc.type === "reference"
            ? "note"
            : "box";
    lines.push(`  "${id}" [label="${escapeLabel(doc.title)}" shape=${shape}];`);

    for (const childId of doc.childrenIds) {
      edges.push(`  "${id}" -> "${childId}";`);
      walk(childId, depth + 1);
    }

    for (const relId of doc.related) {
      if (graph.documents.has(relId)) {
        edges.push(`  "${id}" -> "${relId}" [style=dashed];`);
      }
    }
  };

  if (rootId) {
    walk(rootId, 0);
  } else {
    if (graph.documents.has("root")) {
      walk("root", 0);
    }
    for (const doc of graph.documents.values()) {
      if (!visited.has(doc.id)) {
        walk(doc.id, 0);
      }
    }
  }

  lines.push(...edges);
  lines.push("}");
  return lines.join("\n");
}
