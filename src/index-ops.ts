/**
 * Shared index mutation operations for the knowledge graph.
 * Extracted from engine.ts, writer.ts, and test/helpers.ts to eliminate triplication.
 */

import type { KnowledgeDocument } from "./loader.js";
import type { KnowledgeGraph } from "./graph.js";

/** Remove a document from all graph indices (tag, domain, phase, type, backlink). */
export function removeFromIndices(graph: KnowledgeGraph, doc: KnowledgeDocument): void {
  for (const tag of doc.tags) {
    const tagSet = graph.tagIndex.get(tag.toLowerCase());
    if (tagSet) {
      tagSet.delete(doc.id);
      if (tagSet.size === 0) graph.tagIndex.delete(tag.toLowerCase());
    }
  }

  const domainSet = graph.domainIndex.get(doc.domain.toLowerCase());
  if (domainSet) {
    domainSet.delete(doc.id);
    if (domainSet.size === 0) graph.domainIndex.delete(doc.domain.toLowerCase());
  }

  for (const phase of doc.phase) {
    const phaseSet = graph.phaseIndex.get(phase);
    if (phaseSet) {
      phaseSet.delete(doc.id);
      if (phaseSet.size === 0) graph.phaseIndex.delete(phase);
    }
  }

  const typeSet = graph.typeIndex.get(doc.type);
  if (typeSet) {
    typeSet.delete(doc.id);
    if (typeSet.size === 0) graph.typeIndex.delete(doc.type);
  }

  for (const targetId of doc.related) {
    const backlinks = graph.backlinkIndex.get(targetId);
    if (backlinks) {
      backlinks.delete(doc.id);
      if (backlinks.size === 0) graph.backlinkIndex.delete(targetId);
    }
  }
}

/** Add a document to all graph indices (tag, domain, phase, type, backlink). */
export function addToIndices(graph: KnowledgeGraph, doc: KnowledgeDocument): void {
  for (const tag of doc.tags) {
    const lower = tag.toLowerCase();
    if (!graph.tagIndex.has(lower)) graph.tagIndex.set(lower, new Set());
    graph.tagIndex.get(lower)!.add(doc.id);
  }

  const domainLower = doc.domain.toLowerCase();
  if (!graph.domainIndex.has(domainLower)) graph.domainIndex.set(domainLower, new Set());
  graph.domainIndex.get(domainLower)!.add(doc.id);

  if (!graph.typeIndex.has(doc.type)) graph.typeIndex.set(doc.type, new Set());
  graph.typeIndex.get(doc.type)!.add(doc.id);

  for (const phase of doc.phase) {
    if (!graph.phaseIndex.has(phase)) graph.phaseIndex.set(phase, new Set());
    graph.phaseIndex.get(phase)!.add(doc.id);
  }

  for (const targetId of doc.related) {
    if (!graph.backlinkIndex.has(targetId)) graph.backlinkIndex.set(targetId, new Set());
    graph.backlinkIndex.get(targetId)!.add(doc.id);
  }
}
