import type { KnowledgeGraph } from "./graph.js";
import { getAncestors, getRelated } from "./graph.js";
import { classifyQuery, expandSynonyms, type ClassifierConfig } from "./query-classifier.js";
import { cosineSimilarity, dotProduct, embedQuery } from "./embeddings.js";
import { bm25Score, type Bm25Index } from "./bm25.js";
import { tokenize } from "./text.js";
import {
  formatSearchResults,
  type FormattedDoc,
  type DetailLevel,
  type FacetCounts,
} from "./formatter.js";
import type { KnowledgeDocument } from "./loader.js";
import { rerank, mmrDiversify } from "./reranker.js";
import { log } from "./logger.js";
import { logQuery } from "./search-analytics.js";

// Re-export for backward compatibility
export type TfIdfIndex = Bm25Index;

export interface SearchOptions {
  query: string;
  domains?: string[];
  phases?: number[];
  tags?: string[];
  type?: string;
  maxResults?: number;
  detailLevel?: DetailLevel;
  includeDrafts?: boolean;
  includeAncestors?: boolean;
  includeFacets?: boolean;
  verbose?: boolean;
}

interface ScoredDoc {
  doc: KnowledgeDocument;
  score: number;
}

// Stage 1: Query classification (rule-based)
function classifyAndMerge(
  options: SearchOptions,
  classifierConfig: ClassifierConfig
): {
  domains: string[];
  phases: number[];
  queryType: "broad" | "specific" | "decision" | "procedural" | "troubleshooting";
} {
  const classification = classifyQuery(options.query, classifierConfig);

  // Merge explicit filters with classified ones
  const domains = options.domains?.length ? options.domains : classification.domains;
  const phases = options.phases?.length ? options.phases : classification.phases;

  return { domains, phases, queryType: classification.queryType };
}

// Stage 2: Metadata pre-filter (uses phaseIndex for O(1) phase lookups)
function metadataFilter(
  graph: KnowledgeGraph,
  domains: string[],
  phases: number[],
  tags?: string[],
  type?: string
): Set<string> {
  let candidates: Set<string> | null = null;

  // Domain filter
  if (domains.length > 0) {
    candidates = new Set<string>();
    for (const domain of domains) {
      const domainDocs = graph.domainIndex.get(domain.toLowerCase());
      if (domainDocs) {
        for (const id of domainDocs) candidates.add(id);
      }
    }
  }

  // Phase filter (using phaseIndex instead of iterating all documents)
  if (phases.length > 0) {
    const phaseFiltered = new Set<string>();
    for (const phase of phases) {
      const phaseDocs = graph.phaseIndex.get(phase);
      if (phaseDocs) {
        for (const id of phaseDocs) phaseFiltered.add(id);
      }
    }
    if (candidates) {
      candidates = new Set([...candidates].filter((id) => phaseFiltered.has(id)));
    } else {
      candidates = phaseFiltered;
    }
  }

  // Tag filter
  if (tags && tags.length > 0) {
    const tagFiltered = new Set<string>();
    for (const tag of tags) {
      const tagDocs = graph.tagIndex.get(tag.toLowerCase());
      if (tagDocs) {
        for (const id of tagDocs) tagFiltered.add(id);
      }
    }
    if (candidates) {
      candidates = new Set([...candidates].filter((id) => tagFiltered.has(id)));
    } else {
      candidates = tagFiltered;
    }
  }

  // Type filter
  if (type) {
    const typeDocs = graph.typeIndex.get(type);
    const typeFiltered = typeDocs ? new Set(typeDocs) : new Set<string>();
    if (candidates) {
      candidates = new Set([...candidates].filter((id) => typeFiltered.has(id)));
    } else {
      candidates = typeFiltered;
    }
  }

  // No filters → all documents
  if (!candidates) {
    candidates = new Set(graph.documents.keys());
  }

  return candidates;
}

// Determine which fields a query matched against
function detectMatchedOn(query: string, doc: KnowledgeDocument): string {
  const queryTokens = new Set(tokenize(query));
  const parts: string[] = [];
  const titleTokens = tokenize(doc.title);
  if (titleTokens.some((t) => queryTokens.has(t))) parts.push("title");
  const tagTokens = doc.tags.flatMap((t) => tokenize(t));
  if (tagTokens.some((t) => queryTokens.has(t))) parts.push("tags");
  const bodyTokens = tokenize(doc.contentBody.slice(0, 2000));
  if (bodyTokens.some((t) => queryTokens.has(t))) parts.push("body");
  return parts.length > 0 ? parts.join("+") : "semantic";
}

// Stage 3: Hybrid scoring — vector + BM25 merged via RRF when embeddings available
async function scoreDocuments(
  graph: KnowledgeGraph,
  candidates: Set<string>,
  query: string,
  bm25Index: Bm25Index,
  synonymMap: Record<string, string[]>
): Promise<{ scored: ScoredDoc[]; queryVector: number[] | null; searchMethod: string }> {
  let queryVector: number[] | null = null;

  // Expand synonyms for BM25 (vector embeddings handle semantic similarity natively)
  const expandedQuery = expandSynonyms(query, synonymMap);

  // Always compute BM25 scores (using synonym-expanded query)
  const bm25Scored: ScoredDoc[] = [];
  for (const id of candidates) {
    const doc = graph.documents.get(id);
    if (!doc) continue;
    const score = bm25Score(expandedQuery, id, bm25Index);
    bm25Scored.push({ doc, score });
  }
  bm25Scored.sort((a, b) => b.score - a.score);

  // Try vector similarity
  if (graph.embeddings.available) {
    queryVector = await embedQuery(query);
  }

  if (queryVector) {
    // Adaptive RRF k: smaller for small corpora, capped at 60
    const rrfK = Math.min(60, Math.max(5, Math.floor(candidates.size / 5)));

    // Hybrid: compute vector scores only for docs with embeddings
    const similarityFn = graph.embeddings.normalized ? dotProduct : cosineSimilarity;
    const vectorScored: ScoredDoc[] = [];
    for (const id of candidates) {
      const docVector = graph.embeddings.vectors.get(id);
      const doc = graph.documents.get(id);
      if (!doc) continue;
      // Skip unembedded docs from vector ranking to avoid distorting RRF
      if (docVector) {
        const score = similarityFn(queryVector, docVector);
        vectorScored.push({ doc, score });
      }
    }
    vectorScored.sort((a, b) => b.score - a.score);

    // Build rank maps
    const vectorRank = new Map<string, number>();
    const bm25Rank = new Map<string, number>();
    for (let i = 0; i < vectorScored.length; i++) {
      vectorRank.set(vectorScored[i].doc.id, i + 1);
    }
    for (let i = 0; i < bm25Scored.length; i++) {
      bm25Rank.set(bm25Scored[i].doc.id, i + 1);
    }

    // Merge via RRF — docs without vector rank only get BM25 contribution
    const merged: ScoredDoc[] = [];
    const allIds = new Set([...vectorRank.keys(), ...bm25Rank.keys()]);
    for (const id of allIds) {
      const doc = graph.documents.get(id);
      if (!doc) continue;
      const br = bm25Rank.get(id) ?? bm25Scored.length + 1;
      let score = 1 / (rrfK + br);
      const vr = vectorRank.get(id);
      if (vr !== undefined) {
        score += 1 / (rrfK + vr);
      }
      merged.push({ doc, score });
    }
    merged.sort((a, b) => b.score - a.score);
    return { scored: merged, queryVector, searchMethod: "vector+bm25" };
  }

  // BM25-only fallback
  return { scored: bm25Scored, queryVector, searchMethod: "bm25_fallback" };
}

// Stage 4: Hierarchical expansion + graph walk
function expandResults(
  graph: KnowledgeGraph,
  topResults: ScoredDoc[],
  maxTotal: number,
  bm25Index: Bm25Index,
  queryVector: number[] | null,
  query: string,
  maxRelated: number,
  searchMethod: string,
  includeAncestors: boolean
): FormattedDoc[] {
  const seen = new Set<string>();
  const formattedDocs: FormattedDoc[] = [];

  // 4a: Collect unique ancestors (opt-in)
  if (includeAncestors) {
    const ancestorDocs: KnowledgeDocument[] = [];
    for (const { doc } of topResults) {
      const ancestors = getAncestors(graph, doc.id);
      for (const a of ancestors) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          ancestorDocs.push(a);
        }
      }
    }

    for (const a of ancestorDocs) {
      formattedDocs.push({ doc: a, relevance: "ancestor" });
    }
  }

  // Primary results (with annotations)
  for (const { doc, score } of topResults) {
    if (!seen.has(doc.id)) {
      seen.add(doc.id);
      formattedDocs.push({
        doc,
        relevance: "primary",
        similarity: score,
        matchedOn: detectMatchedOn(query, doc),
        scoringMethod: searchMethod,
      });
    }
  }

  // 4b: Related-link expansion (skip if maxRelated is 0)
  if (maxRelated <= 0) return formattedDocs;

  // Compute median primary score for BM25 threshold
  const primaryScores = topResults.map((r) => r.score).sort((a, b) => a - b);
  const medianPrimaryScore =
    primaryScores.length > 0 ? primaryScores[Math.floor(primaryScores.length / 2)] : 0;

  const relatedCandidates: Array<ScoredDoc & { sourceId: string }> = [];
  const topForExpansion = topResults.slice(0, 4);

  for (const { doc } of topForExpansion) {
    const related = getRelated(graph, doc.id);
    for (const r of related) {
      if (!seen.has(r.id)) {
        // Score the related doc — use embeddings if available, BM25 fallback
        let score: number;
        let useVector = false;
        const docVector = queryVector ? graph.embeddings.vectors.get(r.id) : undefined;
        if (queryVector && docVector) {
          score = cosineSimilarity(queryVector, docVector);
          useVector = true;
        } else {
          score = bm25Score(query, r.id, bm25Index);
        }

        // Score threshold: filter out low-relevance related docs
        const minScore = useVector ? 0.3 : 0.4 * medianPrimaryScore;
        if (score >= minScore) {
          relatedCandidates.push({ doc: r, score, sourceId: doc.id });
        }
      }
    }
  }

  // Deduplicate relatedCandidates by ID, keeping highest-scoring occurrence
  const bestRelated = new Map<string, (typeof relatedCandidates)[0]>();
  for (const rc of relatedCandidates) {
    const existing = bestRelated.get(rc.doc.id);
    if (!existing || rc.score > existing.score) bestRelated.set(rc.doc.id, rc);
  }
  const dedupedRelated = [...bestRelated.values()].sort((a, b) => b.score - a.score);

  // Take up to budget
  const budget = maxTotal - formattedDocs.length;
  const relatedToAdd = dedupedRelated.slice(0, Math.min(maxRelated, budget));

  for (const { doc, score, sourceId } of relatedToAdd) {
    if (!seen.has(doc.id)) {
      seen.add(doc.id);
      formattedDocs.push({
        doc,
        relevance: "graph-expanded",
        similarity: score > 0 ? score : undefined,
        expandedFrom: sourceId,
        scoringMethod: searchMethod,
      });
    }
  }

  return formattedDocs;
}

/** Structured search result for programmatic consumers. */
export interface SearchResult {
  query: string;
  queryType: string;
  searchMethod: string;
  confidence: "high" | "medium" | "low";
  results: FormattedDoc[];
  facets?: FacetCounts;
  ms: number;
}

/** Search returning structured data for programmatic use. */
export async function knowledgeSearchStructured(
  graph: KnowledgeGraph,
  bm25Index: Bm25Index,
  options: SearchOptions,
  classifierConfig: ClassifierConfig,
  knowledgeDir?: string
): Promise<SearchResult> {
  return searchCore(graph, bm25Index, options, classifierConfig, knowledgeDir);
}

export async function knowledgeSearch(
  graph: KnowledgeGraph,
  bm25Index: Bm25Index,
  options: SearchOptions,
  classifierConfig: ClassifierConfig,
  knowledgeDir?: string
): Promise<string> {
  const result = await searchCore(graph, bm25Index, options, classifierConfig, knowledgeDir);
  return formatSearchResults(
    result.query,
    result.results,
    options.detailLevel || "summary",
    result.searchMethod,
    result.facets,
    result.confidence,
    options.verbose ?? false
  );
}

async function searchCore(
  graph: KnowledgeGraph,
  bm25Index: Bm25Index,
  options: SearchOptions,
  classifierConfig: ClassifierConfig,
  knowledgeDir?: string
): Promise<SearchResult> {
  const maxResults = options.maxResults || 10;
  const _detailLevel = options.detailLevel || "summary";
  const searchStart = Date.now();

  // Stage 1: Classify query
  const { domains, phases, queryType } = classifyAndMerge(options, classifierConfig);

  // Stage 2: Metadata pre-filter
  const candidates = metadataFilter(graph, domains, phases, options.tags, options.type);

  // Stage 3: Score documents
  const {
    scored: rawScored,
    queryVector,
    searchMethod,
  } = await scoreDocuments(
    graph,
    candidates,
    options.query,
    bm25Index,
    classifierConfig.synonymMap
  );

  // Re-rank top candidates (title match, decision boost, staleness, exact phrase)
  const reranked = rerank(rawScored.slice(0, 20), options.query, queryType);
  const remaining = rawScored.slice(20);

  // Filter drafts (unless explicitly included), penalize deprecated (0.5x score)
  const scored = [...reranked, ...remaining]
    .filter((s) => options.includeDrafts || s.doc.status !== "draft")
    .map((s) => (s.doc.status === "deprecated" ? { ...s, score: s.score * 0.5 } : s));
  scored.sort((a, b) => b.score - a.score);

  // Adaptive top-N based on query type
  let topN: number;
  let maxRelated: number;
  switch (queryType) {
    case "broad":
      topN = Math.min(4, scored.length);
      maxRelated = 1;
      break;
    case "decision":
      topN = Math.min(3, scored.length);
      maxRelated = 0;
      break;
    case "procedural":
      topN = Math.min(5, scored.length);
      maxRelated = 1;
      break;
    case "troubleshooting":
      topN = Math.min(5, scored.length);
      maxRelated = 0;
      break;
    case "specific":
    default:
      topN = Math.min(6, scored.length);
      maxRelated = 1;
      break;
  }

  // Apply MMR diversification to reduce near-duplicate results
  const topResults = mmrDiversify(scored, graph.embeddings, 0.7, topN);

  // Stage 4: Expand with ancestors + related
  const formatted = expandResults(
    graph,
    topResults,
    maxResults,
    bm25Index,
    queryVector,
    options.query,
    maxRelated,
    searchMethod,
    options.includeAncestors ?? false
  );

  // Compute facets from all scored candidates (opt-in)
  let facets: FacetCounts | undefined;
  if (options.includeFacets) {
    facets = {
      domains: new Map(),
      types: new Map(),
      phases: new Map(),
    };
    for (const { doc } of scored) {
      facets.domains.set(doc.domain, (facets.domains.get(doc.domain) || 0) + 1);
      facets.types.set(doc.type, (facets.types.get(doc.type) || 0) + 1);
      for (const p of doc.phase) {
        const key = `phase-${p}`;
        facets.phases.set(key, (facets.phases.get(key) || 0) + 1);
      }
    }
  }

  const ms = Date.now() - searchStart;

  log.info("search", {
    query: options.query,
    queryType,
    method: searchMethod,
    candidates: candidates.size,
    results: formatted.length,
    ms,
  });

  // Self-calibrating confidence based on score distribution
  let confidence: "high" | "medium" | "low";
  if (scored.length === 0) {
    confidence = "low";
  } else {
    const topScore = topResults.length > 0 ? topResults[0].score : 0;
    const scores = scored.slice(0, Math.min(20, scored.length)).map((s) => s.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stddev = Math.sqrt(variance);
    confidence = topScore > mean + stddev ? "high" : topScore > mean ? "medium" : "low";
  }

  // Log analytics (best-effort, non-blocking)
  if (knowledgeDir) {
    logQuery(knowledgeDir, {
      query: options.query,
      timestamp: new Date().toISOString(),
      method: searchMethod,
      resultCount: formatted.length,
      confidence,
      topDocId: topResults.length > 0 ? topResults[0].doc.id : null,
      ms,
    });
  }

  return {
    query: options.query,
    queryType,
    searchMethod,
    confidence,
    results: formatted,
    facets,
    ms,
  };
}
