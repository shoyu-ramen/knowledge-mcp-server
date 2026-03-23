import type { KnowledgeDocument } from "../src/loader.js";
import type { KnowledgeGraph } from "../src/graph.js";
import { buildTfIdfIndex, type Bm25Index } from "../src/bm25.js";
import { addToIndices } from "../src/index-ops.js";

let docCounter = 0;

export function makeDoc(overrides?: Partial<KnowledgeDocument>): KnowledgeDocument {
  const id = overrides?.id ?? `test/doc-${++docCounter}`;
  return {
    id,
    title: overrides?.title ?? `Test Document ${docCounter}`,
    type: overrides?.type ?? "detail",
    domain: overrides?.domain ?? "technology",
    subdomain: overrides?.subdomain,
    tags: overrides?.tags ?? ["test"],
    phase: overrides?.phase ?? [1],
    related: overrides?.related ?? [],
    parentId: overrides?.parentId ?? "test",
    childrenIds: overrides?.childrenIds ?? [],
    contentBody: overrides?.contentBody ?? "This is test content for the document.",
    filePath: overrides?.filePath ?? `knowledge/test/${id.split("/").pop()}.md`,
    wordCount: overrides?.wordCount ?? 8,
    status: overrides?.status ?? "active",
    supersededBy: overrides?.supersededBy,
    lastUpdated: overrides?.lastUpdated ?? "2026-03-20",
    decisionStatus: overrides?.decisionStatus,
    alternativesConsidered: overrides?.alternativesConsidered,
    decisionDate: overrides?.decisionDate,
  };
}

export function makeGraph(docs: KnowledgeDocument[]): KnowledgeGraph {
  const documents = new Map<string, KnowledgeDocument>();
  const graph: KnowledgeGraph = {
    documents,
    embeddings: { vectors: new Map(), available: false, normalized: true },
    tagIndex: new Map(),
    domainIndex: new Map(),
    phaseIndex: new Map(),
    typeIndex: new Map(),
    backlinkIndex: new Map(),
    filePathIndex: new Map(),
    loaderWarnings: [],
    tagTaxonomy: null,
  };

  for (const doc of docs) {
    documents.set(doc.id, doc);
    addToIndices(graph, doc);
    graph.filePathIndex.set(doc.filePath, doc.id);
  }

  return graph;
}

export function makeBm25Index(docs: KnowledgeDocument[]): Bm25Index {
  const docMap = new Map<string, KnowledgeDocument>();
  for (const doc of docs) docMap.set(doc.id, doc);
  return buildTfIdfIndex(docMap);
}

export function resetDocCounter(): void {
  docCounter = 0;
}
