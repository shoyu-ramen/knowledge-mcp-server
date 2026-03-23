import type { KnowledgeGraph } from "./graph.js";
import { SIX_MONTHS_MS } from "./constants.js";

export interface ValidationReport {
  orphans: string[];
  brokenRelated: Array<{ doc: string; ref: string }>;
  brokenChildren: Array<{ doc: string; ref: string }>;
  asymmetricRelated: Array<{ doc: string; ref: string }>;
  circularParents: string[];
  noTags: string[];
  emptySummaries: string[];
  staleDocs: string[];
  embeddingCoverage: { total: number; covered: number; percent: number };
  loaderWarnings: string[];
}

export function validateGraph(graph: KnowledgeGraph): ValidationReport {
  const now = Date.now();
  const report: ValidationReport = {
    orphans: [],
    brokenRelated: [],
    brokenChildren: [],
    asymmetricRelated: [],
    circularParents: [],
    noTags: [],
    emptySummaries: [],
    staleDocs: [],
    embeddingCoverage: { total: 0, covered: 0, percent: 0 },
    loaderWarnings: graph.loaderWarnings ?? [],
  };

  for (const doc of graph.documents.values()) {
    // Orphan check: has a parentId that doesn't exist (and isn't a top-level domain doc)
    if (doc.parentId && doc.parentId !== "root" && !graph.documents.has(doc.parentId)) {
      report.orphans.push(doc.id);
    }

    // Broken related references
    for (const ref of doc.related) {
      if (!graph.documents.has(ref)) {
        report.brokenRelated.push({ doc: doc.id, ref });
      }
    }

    // Asymmetric related references: A→B exists but B→A does not
    for (const ref of doc.related) {
      const targetDoc = graph.documents.get(ref);
      if (targetDoc && !targetDoc.related.includes(doc.id)) {
        report.asymmetricRelated.push({ doc: doc.id, ref });
      }
    }

    // Broken children references
    for (const ref of doc.childrenIds) {
      if (!graph.documents.has(ref)) {
        report.brokenChildren.push({ doc: doc.id, ref });
      }
    }

    // Circular parent chain detection
    const visited = new Set<string>();
    let current: string | null = doc.id;
    let circular = false;
    while (current) {
      if (visited.has(current)) {
        circular = true;
        break;
      }
      visited.add(current);
      current = graph.documents.get(current)?.parentId ?? null;
    }
    if (circular) {
      report.circularParents.push(doc.id);
    }

    // Docs with zero tags
    if (doc.tags.length === 0) {
      report.noTags.push(doc.id);
    }

    // Summary nodes without children
    if (doc.type === "summary" && doc.childrenIds.length === 0) {
      report.emptySummaries.push(doc.id);
    }

    // Stale docs (>6 months since last update)
    if (doc.lastUpdated) {
      const docDate = new Date(doc.lastUpdated).getTime();
      if (!isNaN(docDate) && now - docDate > SIX_MONTHS_MS) {
        report.staleDocs.push(doc.id);
      }
    }
  }

  // Embedding coverage
  const total = graph.documents.size;
  const covered = [...graph.documents.keys()].filter((id) =>
    graph.embeddings.vectors.has(id)
  ).length;
  report.embeddingCoverage = {
    total,
    covered,
    percent: total > 0 ? Math.round((covered / total) * 100) : 0,
  };

  return report;
}

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = ["Knowledge Graph Validation Report", "=".repeat(38), ""];

  const addSection = (title: string, items: string[]) => {
    lines.push(`${title}: ${items.length === 0 ? "none" : items.length}`);
    for (const item of items) {
      lines.push(`  - ${item}`);
    }
  };

  addSection("Orphaned documents", report.orphans);
  addSection(
    "Broken related references",
    report.brokenRelated.map((r) => `${r.doc} → ${r.ref}`)
  );
  addSection(
    "Asymmetric related references",
    report.asymmetricRelated.map((r) => `${r.doc} → ${r.ref} (not reciprocated)`)
  );
  addSection(
    "Broken children references",
    report.brokenChildren.map((r) => `${r.doc} → ${r.ref}`)
  );
  addSection("Circular parent chains", report.circularParents);
  addSection("Documents with no tags", report.noTags);
  addSection("Empty summary nodes (no children)", report.emptySummaries);
  addSection("Stale documents (>6 months)", report.staleDocs);

  if (report.loaderWarnings.length > 0) {
    addSection("Loader warnings", report.loaderWarnings);
  }

  lines.push("");
  lines.push(
    `Embedding coverage: ${report.embeddingCoverage.covered}/${report.embeddingCoverage.total} (${report.embeddingCoverage.percent}%)`
  );

  const issueCount =
    report.orphans.length +
    report.brokenRelated.length +
    report.brokenChildren.length +
    report.circularParents.length;
  lines.push("");
  lines.push(
    issueCount === 0 ? "No integrity issues found." : `${issueCount} integrity issue(s) found.`
  );

  return lines.join("\n");
}
