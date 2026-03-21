import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type KnowledgeDocument, loadDocuments } from "./loader.js";
import { loadEmbeddings, type EmbeddingsStore } from "./embeddings.js";
import { log } from "./logger.js";

export interface TagTaxonomy {
  knownTags: Set<string>;
  aliases: Map<string, string>; // alias → canonical tag
}

export interface KnowledgeGraph {
  documents: Map<string, KnowledgeDocument>;
  embeddings: EmbeddingsStore;
  tagIndex: Map<string, Set<string>>;
  domainIndex: Map<string, Set<string>>;
  phaseIndex: Map<number, Set<string>>;
  typeIndex: Map<string, Set<string>>;
  backlinkIndex: Map<string, Set<string>>; // targetId → set of sourceIds that reference it
  tagTaxonomy: TagTaxonomy | null;
}

function buildTagIndex(docs: Map<string, KnowledgeDocument>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs.values()) {
    for (const tag of doc.tags) {
      const lower = tag.toLowerCase();
      if (!index.has(lower)) index.set(lower, new Set());
      index.get(lower)!.add(doc.id);
    }
  }
  return index;
}

function buildDomainIndex(docs: Map<string, KnowledgeDocument>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs.values()) {
    const domain = doc.domain.toLowerCase();
    if (!index.has(domain)) index.set(domain, new Set());
    index.get(domain)!.add(doc.id);
  }
  return index;
}

function buildPhaseIndex(docs: Map<string, KnowledgeDocument>): Map<number, Set<string>> {
  const index = new Map<number, Set<string>>();
  for (const doc of docs.values()) {
    for (const phase of doc.phase) {
      if (!index.has(phase)) index.set(phase, new Set());
      index.get(phase)!.add(doc.id);
    }
  }
  return index;
}

function buildTypeIndex(docs: Map<string, KnowledgeDocument>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs.values()) {
    if (!index.has(doc.type)) index.set(doc.type, new Set());
    index.get(doc.type)!.add(doc.id);
  }
  return index;
}

function buildBacklinkIndex(docs: Map<string, KnowledgeDocument>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs.values()) {
    for (const targetId of doc.related) {
      if (!index.has(targetId)) index.set(targetId, new Set());
      index.get(targetId)!.add(doc.id);
    }
  }
  return index;
}

export function loadTagTaxonomy(knowledgeDir: string): TagTaxonomy | null {
  const tagsPath = join(knowledgeDir, ".tags.json");
  try {
    const raw = readFileSync(tagsPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      categories?: Record<string, string[]>;
      aliases?: Record<string, string>;
    };

    const knownTags = new Set<string>();
    if (parsed.categories) {
      for (const tags of Object.values(parsed.categories)) {
        for (const tag of tags) {
          knownTags.add(tag);
        }
      }
    }

    const aliases = new Map<string, string>();
    if (parsed.aliases) {
      for (const [alias, canonical] of Object.entries(parsed.aliases)) {
        aliases.set(alias.toLowerCase(), canonical);
      }
    }

    log.info("tag-taxonomy-loaded", { tagCount: knownTags.size, aliasCount: aliases.size });
    return { knownTags, aliases };
  } catch {
    log.debug("tag-taxonomy-skipped", { reason: "No .tags.json found or failed to parse" });
    return null;
  }
}

export function buildGraph(
  knowledgeDir: string,
  validDomains?: string[] | null
): KnowledgeGraph {
  const documents = loadDocuments(knowledgeDir, validDomains);
  const embeddings = loadEmbeddings(knowledgeDir);

  const tagIndex = buildTagIndex(documents);
  const domainIndex = buildDomainIndex(documents);
  const phaseIndex = buildPhaseIndex(documents);
  const typeIndex = buildTypeIndex(documents);
  const backlinkIndex = buildBacklinkIndex(documents);
  const tagTaxonomy = loadTagTaxonomy(knowledgeDir);

  return {
    documents,
    embeddings,
    tagIndex,
    domainIndex,
    phaseIndex,
    typeIndex,
    backlinkIndex,
    tagTaxonomy,
  };
}

export function getAncestors(graph: KnowledgeGraph, docId: string): KnowledgeDocument[] {
  const ancestors: KnowledgeDocument[] = [];
  let currentId = graph.documents.get(docId)?.parentId ?? null;
  while (currentId) {
    const parent = graph.documents.get(currentId);
    if (!parent) break;
    ancestors.unshift(parent);
    currentId = parent.parentId;
  }
  return ancestors;
}

export function getRelated(graph: KnowledgeGraph, docId: string): KnowledgeDocument[] {
  const doc = graph.documents.get(docId);
  if (!doc) return [];

  // Merge forward links + backlinks, deduplicate
  const relatedIds = new Set(doc.related);
  const backlinks = graph.backlinkIndex.get(docId);
  if (backlinks) {
    for (const id of backlinks) relatedIds.add(id);
  }

  return [...relatedIds]
    .map((id) => graph.documents.get(id))
    .filter((d): d is KnowledgeDocument => d !== undefined);
}
