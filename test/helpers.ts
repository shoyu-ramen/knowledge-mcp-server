import type { KnowledgeDocument } from "../src/loader.js";
import type { KnowledgeGraph } from "../src/graph.js";
import { buildTfIdfIndex, type Bm25Index } from "../src/embeddings.js";

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
  const tagIndex = new Map<string, Set<string>>();
  const domainIndex = new Map<string, Set<string>>();
  const phaseIndex = new Map<number, Set<string>>();
  const typeIndex = new Map<string, Set<string>>();
  const backlinkIndex = new Map<string, Set<string>>();

  for (const doc of docs) {
    documents.set(doc.id, doc);

    for (const tag of doc.tags) {
      const lower = tag.toLowerCase();
      if (!tagIndex.has(lower)) tagIndex.set(lower, new Set());
      tagIndex.get(lower)!.add(doc.id);
    }

    const domainLower = doc.domain.toLowerCase();
    if (!domainIndex.has(domainLower)) domainIndex.set(domainLower, new Set());
    domainIndex.get(domainLower)!.add(doc.id);

    for (const phase of doc.phase) {
      if (!phaseIndex.has(phase)) phaseIndex.set(phase, new Set());
      phaseIndex.get(phase)!.add(doc.id);
    }

    if (!typeIndex.has(doc.type)) typeIndex.set(doc.type, new Set());
    typeIndex.get(doc.type)!.add(doc.id);

    for (const targetId of doc.related) {
      if (!backlinkIndex.has(targetId)) backlinkIndex.set(targetId, new Set());
      backlinkIndex.get(targetId)!.add(doc.id);
    }
  }

  return {
    documents,
    embeddings: { vectors: new Map(), available: false },
    tagIndex,
    domainIndex,
    phaseIndex,
    typeIndex,
    backlinkIndex,
    tagTaxonomy: null,
  };
}

export function makeBm25Index(docs: KnowledgeDocument[]): Bm25Index {
  const docMap = new Map<string, KnowledgeDocument>();
  for (const doc of docs) docMap.set(doc.id, doc);
  return buildTfIdfIndex(docMap);
}

export function resetDocCounter(): void {
  docCounter = 0;
}
