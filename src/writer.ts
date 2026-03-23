import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { deriveParentId, type DocumentStatus } from "./loader.js";
import { embedSingleDocument, removeEmbedding } from "./embeddings.js";
import { updateBm25Index, bm25Score, type Bm25Index } from "./bm25.js";
import type { KnowledgeDocument } from "./loader.js";
import type { KnowledgeGraph, TagTaxonomy } from "./graph.js";
import { addToIndices, removeFromIndices } from "./index-ops.js";
import { ID_PATTERN, VALID_TYPES } from "./constants.js";
import { log } from "./logger.js";

// Re-export for backward compatibility
export type TfIdfIndex = Bm25Index;

export interface WriteParams {
  id: string;
  title: string;
  type: string;
  domain: string;
  subdomain?: string;
  tags: string[];
  phase: number[];
  related?: string[];
  children?: string[];
  content: string;
  status?: DocumentStatus;
  superseded_by?: string;
  decision_status?: "proposed" | "accepted" | "deprecated" | "superseded" | "finalized";
  alternatives_considered?: string[];
  decision_date?: string;
}

export interface WriteResult {
  id: string;
  filePath: string;
  parentId: string | null;
  status: "created" | "updated";
  tfidfIndex: Bm25Index;
  warnings: string[];
  suggestions: Array<{ id: string; title: string; score: number }>;
}

export interface DeleteResult {
  id: string;
  warnings: string[];
  tfidfIndex: Bm25Index;
}

function validateWriteParams(
  params: WriteParams,
  validDomains: string[] | null,
  validPhaseIds: number[] | null
): void {
  if (!ID_PATTERN.test(params.id)) {
    throw new Error(
      `Invalid document ID "${params.id}". Must match pattern: lowercase letters, digits, hyphens, separated by slashes.`
    );
  }

  if (validDomains && !validDomains.includes(params.domain)) {
    throw new Error(
      `Invalid domain "${params.domain}". Must be one of: ${validDomains.join(", ")}`
    );
  }

  if (!(VALID_TYPES as readonly string[]).includes(params.type)) {
    throw new Error(`Invalid type "${params.type}". Must be one of: ${VALID_TYPES.join(", ")}`);
  }

  for (const p of params.phase) {
    if (validPhaseIds) {
      if (!validPhaseIds.includes(p)) {
        throw new Error(`Invalid phase value ${p}. Must be one of: ${validPhaseIds.join(", ")}`);
      }
    } else if (p < 1 || !Number.isInteger(p)) {
      throw new Error(`Invalid phase value ${p}. Must be a positive integer.`);
    }
  }

  if (!params.title.trim()) {
    throw new Error("Title must not be empty.");
  }

  if (!params.content.trim()) {
    throw new Error("Content must not be empty.");
  }
}

function findClosestTag(tag: string, knownTags: Set<string>): string | null {
  const lower = tag.toLowerCase();
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const known of knownTags) {
    const knownLower = known.toLowerCase();

    // Exact case-insensitive match
    if (knownLower === lower) return known;

    // Substring containment: tag is part of known or known is part of tag
    if (knownLower.includes(lower) || lower.includes(knownLower)) {
      const score =
        Math.min(lower.length, knownLower.length) / Math.max(lower.length, knownLower.length);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = known;
      }
    }
  }

  // Only suggest if the match is reasonably close (>40% overlap ratio)
  return bestScore > 0.4 ? bestMatch : null;
}

function validateTags(tags: string[], taxonomy: TagTaxonomy, warnings: string[]): string[] {
  const correctedTags: string[] = [];

  for (const tag of tags) {
    const lower = tag.toLowerCase();

    // Check alias map first
    const aliasTarget = taxonomy.aliases.get(lower);
    if (aliasTarget) {
      correctedTags.push(aliasTarget);
      warnings.push(`Tag "${tag}" auto-corrected to "${aliasTarget}" (known alias).`);
      continue;
    }

    // Check if it's a known tag
    if (taxonomy.knownTags.has(tag)) {
      correctedTags.push(tag);
      continue;
    }

    // Unknown tag — find closest match and warn
    const closest = findClosestTag(tag, taxonomy.knownTags);
    if (closest) {
      warnings.push(`Tag "${tag}" is not in the taxonomy. Did you mean "${closest}"?`);
    } else {
      warnings.push(`Tag "${tag}" is not in the taxonomy. Consider adding it to .tags.json.`);
    }
    correctedTags.push(tag);
  }

  return correctedTags;
}

export function writeDocument(
  graph: KnowledgeGraph,
  tfidfIndex: Bm25Index,
  knowledgeDir: string,
  params: WriteParams,
  validDomains?: string[] | null,
  validPhaseIds?: number[] | null
): WriteResult {
  validateWriteParams(params, validDomains ?? null, validPhaseIds ?? null);

  // Validate and auto-correct tags against taxonomy (warnings only)
  const tagWarnings: string[] = [];
  if (graph.tagTaxonomy) {
    params.tags = validateTags(params.tags, graph.tagTaxonomy, tagWarnings);
  }

  const parentId = deriveParentId(params.id);
  const warnings: string[] = [...tagWarnings];

  // Parent must exist (unless this is a top-level domain doc whose parent is "root")
  if (parentId && !graph.documents.has(parentId)) {
    throw new Error(
      `Parent document "${parentId}" does not exist. Create parent summary documents first.`
    );
  }

  // Validate related references (warn, not error)
  if (params.related) {
    for (const relId of params.related) {
      if (!graph.documents.has(relId)) {
        warnings.push(`Related reference "${relId}" does not exist in the knowledge graph.`);
      }
    }
  }

  // Derive file path: summary type uses _summary.md, others use {last-segment}.md
  const segments = params.id.split("/");
  const isSummary = params.type === "summary";
  const fileName = isSummary ? "_summary.md" : `${segments[segments.length - 1]}.md`;
  const dirPath = isSummary
    ? join(knowledgeDir, ...segments)
    : join(knowledgeDir, ...segments.slice(0, -1));
  const filePath = join(dirPath, fileName);

  const isUpdate = graph.documents.has(params.id);

  // If updating, remove old entries from all indices
  if (isUpdate) {
    const oldDoc = graph.documents.get(params.id)!;
    removeFromIndices(graph, oldDoc);
  }

  // For summary updates, merge provided children with existing auto-discovered children
  let childrenIds: string[] = [];
  if (isUpdate && isSummary) {
    const existingDoc = graph.documents.get(params.id)!;
    const existingChildren = new Set(existingDoc.childrenIds);
    if (params.children) {
      for (const c of params.children) existingChildren.add(c);
    }
    childrenIds = [...existingChildren];
  } else if (params.children) {
    childrenIds = params.children;
  }

  const wordCount = params.content.split(/\s+/).filter(Boolean).length;

  // Build frontmatter
  const frontmatter: Record<string, unknown> = {
    id: params.id,
    title: params.title,
    type: params.type,
    domain: params.domain,
  };
  if (params.subdomain) frontmatter.subdomain = params.subdomain;
  frontmatter.tags = params.tags;
  frontmatter.phase = params.phase;
  if (params.related && params.related.length > 0) frontmatter.related = params.related;
  if (childrenIds.length > 0 && isSummary) frontmatter.children = childrenIds;
  const docStatus = params.status || "active";
  if (docStatus !== "active") frontmatter.status = docStatus;
  if (params.superseded_by) frontmatter.superseded_by = params.superseded_by;
  if (params.type === "decision") {
    if (params.decision_status) frontmatter.decision_status = params.decision_status;
    if (params.alternatives_considered && params.alternatives_considered.length > 0)
      frontmatter.alternatives_considered = params.alternatives_considered;
    if (params.decision_date) frontmatter.decision_date = params.decision_date;
  }
  frontmatter.word_count = wordCount;
  frontmatter.last_updated = new Date().toISOString().split("T")[0];

  const fileContent = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${params.content}`;

  // Write file (create directories as needed)
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(filePath, fileContent, "utf-8");

  const lastUpdated = frontmatter.last_updated as string;

  // Build the in-memory document
  const doc: KnowledgeDocument = {
    id: params.id,
    title: params.title,
    type: params.type as KnowledgeDocument["type"],
    domain: params.domain,
    subdomain: params.subdomain,
    tags: params.tags,
    phase: params.phase,
    related: params.related || [],
    parentId,
    childrenIds,
    contentBody: params.content,
    filePath: relative(join(knowledgeDir, ".."), filePath),
    wordCount,
    status: docStatus,
    supersededBy: params.superseded_by,
    lastUpdated,
    decisionStatus: params.decision_status,
    alternativesConsidered: params.alternatives_considered,
    decisionDate: params.decision_date,
  };

  // Update in-memory graph
  graph.documents.set(params.id, doc);
  addToIndices(graph, doc);

  // Update parent's childrenIds
  if (parentId) {
    const parent = graph.documents.get(parentId);
    if (parent && !parent.childrenIds.includes(doc.id)) {
      parent.childrenIds.push(doc.id);
    }
  }

  // Incremental BM25 index update (no full rebuild)
  updateBm25Index(tfidfIndex, doc.id, doc);

  // Fire-and-forget inline embedding
  embedSingleDocument(graph.embeddings, knowledgeDir, doc).catch((err) => {
    log.warn("embed_doc_fire_and_forget", { id: doc.id, error: String(err) });
  });

  // Auto-linking suggestions: BM25-search new content against corpus
  const suggestions: Array<{ id: string; title: string; score: number }> = [];
  const relatedSet = new Set(doc.related);
  const query = `${doc.title} ${doc.tags.join(" ")}`;
  for (const [candidateId, candidateDoc] of graph.documents) {
    if (candidateId === doc.id || relatedSet.has(candidateId)) continue;
    if (candidateDoc.parentId === doc.id || doc.parentId === candidateId) continue;
    const score = bm25Score(query, candidateId, tfidfIndex);
    if (score > 0) {
      suggestions.push({ id: candidateId, title: candidateDoc.title, score });
    }
  }
  suggestions.sort((a, b) => b.score - a.score);

  return {
    id: params.id,
    filePath: relative(join(knowledgeDir, ".."), filePath),
    parentId,
    status: isUpdate ? "updated" : "created",
    tfidfIndex,
    warnings,
    suggestions: suggestions.slice(0, 5),
  };
}

/** Preview the impact of deleting a document without actually deleting it */
export function previewDelete(graph: KnowledgeGraph, id: string): { warnings: string[] } {
  const doc = graph.documents.get(id);
  if (!doc) {
    throw new Error(`Document not found: "${id}".`);
  }

  const warnings: string[] = [`DRY RUN — document "${id}" would be deleted.`];

  if (doc.childrenIds.length > 0) {
    warnings.push(
      `Document has ${doc.childrenIds.length} children that would be orphaned: ${doc.childrenIds.join(", ")}`
    );
  }

  const backlinks = graph.backlinkIndex.get(id);
  if (backlinks) {
    for (const sourceId of backlinks) {
      warnings.push(`Document "${sourceId}" has a related reference to this document.`);
    }
  }

  return { warnings };
}

export function deleteDocument(
  graph: KnowledgeGraph,
  tfidfIndex: Bm25Index,
  knowledgeDir: string,
  id: string
): DeleteResult {
  const doc = graph.documents.get(id);
  if (!doc) {
    throw new Error(`Document not found: "${id}".`);
  }

  const warnings: string[] = [];

  // Warn about children
  if (doc.childrenIds.length > 0) {
    warnings.push(
      `Document has ${doc.childrenIds.length} children that will be orphaned: ${doc.childrenIds.join(", ")}`
    );
  }

  // Warn about documents that reference this one (via backlink index)
  const backlinks = graph.backlinkIndex.get(id);
  if (backlinks) {
    for (const sourceId of backlinks) {
      warnings.push(`Document "${sourceId}" has a related reference to this document.`);
    }
  }

  // Remove from all indices
  removeFromIndices(graph, doc);

  // Remove from parent's childrenIds
  if (doc.parentId) {
    const parent = graph.documents.get(doc.parentId);
    if (parent) {
      parent.childrenIds = parent.childrenIds.filter((c) => c !== id);
    }
  }

  // Remove backlink entry for this doc (inbound links from other docs)
  graph.backlinkIndex.delete(id);

  // Remove from documents map
  graph.documents.delete(id);

  // Delete file from disk
  const fullPath = join(knowledgeDir, "..", doc.filePath);
  try {
    unlinkSync(fullPath);
  } catch {
    warnings.push(`Could not delete file: ${doc.filePath}`);
  }

  // Incremental BM25 index update (remove doc, no full rebuild)
  updateBm25Index(tfidfIndex, id, null);

  // Remove stale embedding
  removeEmbedding(graph.embeddings, knowledgeDir, id);

  return { id, warnings, tfidfIndex };
}
