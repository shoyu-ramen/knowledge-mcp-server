import { watch, readdirSync, statSync, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { buildGraph, getAncestors, getRelated, loadTagTaxonomy } from "./graph.js";
import { knowledgeSearch, type SearchOptions } from "./search.js";
import { loadEmbeddings, embedSingleDocument, removeEmbedding } from "./embeddings.js";
import { buildTfIdfIndex, updateBm25Index, configureBm25, type Bm25Index } from "./bm25.js";
import {
  writeDocument,
  deleteDocument,
  previewDelete,
  type WriteParams,
  type WriteResult,
  type DeleteResult,
} from "./writer.js";
import { validateGraph, type ValidationReport } from "./validator.js";
import { computeStats, type GraphStats } from "./analytics.js";
import type { KnowledgeGraph } from "./graph.js";
import { loadSingleDocument, type KnowledgeDocument } from "./loader.js";
import { log } from "./logger.js";
import {
  loadConfig,
  getEffectiveDomains,
  getEffectivePhaseIds,
  type KnowledgeConfig,
} from "./config.js";
import { buildClassifierConfig, type ClassifierConfig } from "./query-classifier.js";
import { initEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider.js";
import { addToIndices, removeFromIndices } from "./index-ops.js";
import { computeDocHash, loadBm25Cache, saveBm25Cache } from "./bm25-cache.js";

export interface EngineOptions {
  /** Override the embedding provider (skips singleton initialization). */
  embeddingProvider?: EmbeddingProvider;
}

// Re-export SearchOptions for public API consumers
export type { SearchOptions } from "./search.js";

export interface LookupOptions {
  includeAncestors?: boolean;
  includeRelated?: boolean;
}

export interface LookupResult {
  found: Array<{
    doc: KnowledgeDocument;
    ancestors: KnowledgeDocument[];
    related: KnowledgeDocument[];
  }>;
  notFound: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  domain: string;
  wordCount: number;
  childrenCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "child" | "related";
}

export interface GraphViewResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ListFilters {
  domain?: string;
  type?: string;
  phase?: number;
  tags?: string[];
  titleSearch?: string;
  includeDrafts?: boolean;
}

export interface ListItem {
  id: string;
  title: string;
  type: string;
  domain: string;
  tags: string[];
  wordCount: number;
  status: string;
  lastUpdated?: string;
}

export interface ListResult {
  docs: ListItem[];
  totalDocs: number;
}

// --- KnowledgeEngine ---

export class KnowledgeEngine {
  readonly knowledgeDir: string;
  readonly graph: KnowledgeGraph;
  readonly config: KnowledgeConfig | null;
  readonly validDomains: string[] | null;
  readonly validPhaseIds: number[] | null;
  private tfidfIndex: Bm25Index;
  private classifierConfig: ClassifierConfig;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Map<string, "change" | "delete">();
  private embeddingLock: Promise<void> = Promise.resolve();

  constructor(knowledgeDir: string, options?: EngineOptions) {
    this.knowledgeDir = knowledgeDir;
    const start = Date.now();
    this.config = loadConfig(knowledgeDir);

    // Embedding provider: use injected provider or initialize singleton
    if (options?.embeddingProvider) {
      initEmbeddingProvider(undefined, options.embeddingProvider);
    } else {
      initEmbeddingProvider(this.config?.embeddings);
    }

    if (this.config?.bm25) configureBm25(this.config.bm25);
    this.validDomains = getEffectiveDomains(this.config, knowledgeDir);
    this.validPhaseIds = getEffectivePhaseIds(this.config);
    this.graph = buildGraph(knowledgeDir, this.validDomains);

    // Try loading cached BM25 index before expensive rebuild
    const docHash = computeDocHash(this.graph.documents);
    const cached = loadBm25Cache(knowledgeDir, docHash);
    if (cached) {
      this.tfidfIndex = cached;
    } else {
      this.tfidfIndex = buildTfIdfIndex(this.graph.documents);
      saveBm25Cache(knowledgeDir, this.tfidfIndex, docHash);
    }

    this.classifierConfig = buildClassifierConfig(this.config);
    const elapsed = Date.now() - start;
    log.info("startup", {
      docs: this.graph.documents.size,
      embeddings: this.graph.embeddings.vectors.size,
      embeddingsAvailable: this.graph.embeddings.available,
      bm25Cached: !!cached,
      ms: elapsed,
    });
  }

  // --- Read operations ---

  async search(options: SearchOptions): Promise<string> {
    return knowledgeSearch(
      this.graph,
      this.tfidfIndex,
      {
        query: options.query,
        domains: options.domains,
        phases: options.phases,
        tags: options.tags,
        type: options.type,
        maxResults: options.maxResults,
        detailLevel: options.detailLevel,
        includeDrafts: options.includeDrafts,
      },
      this.classifierConfig,
      this.knowledgeDir
    );
  }

  lookup(ids: string[], options: LookupOptions = {}): LookupResult {
    const { includeAncestors = true, includeRelated = false } = options;
    const found: LookupResult["found"] = [];
    const notFound: string[] = [];

    for (const docId of ids) {
      const doc = this.graph.documents.get(docId);
      if (!doc) {
        notFound.push(docId);
        continue;
      }
      const ancestors = includeAncestors ? getAncestors(this.graph, docId) : [];
      const related = includeRelated ? getRelated(this.graph, docId) : [];
      found.push({ doc, ancestors, related });
    }

    return { found, notFound };
  }

  fuzzyMatchId(query: string): Array<{ id: string; title: string; score: number }> {
    const lower = query.toLowerCase();
    const queryTokens = lower.split(/[\s\-/]+/).filter(Boolean);
    const candidates: Array<{ id: string; title: string; score: number }> = [];

    for (const doc of this.graph.documents.values()) {
      let score = 0;
      const idLower = doc.id.toLowerCase();
      const titleLower = doc.title.toLowerCase();

      if (idLower.includes(lower)) score += 3;
      else if (lower.includes(idLower)) score += 2;
      if (titleLower.includes(lower)) score += 2;

      const idTokens = idLower.split(/[-/]+/);
      const titleTokens = titleLower.split(/\s+/);
      for (const qt of queryTokens) {
        if (idTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
        if (titleTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
      }

      if (score > 0) candidates.push({ id: doc.id, title: doc.title, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 5);
  }

  graphView(
    rootId: string,
    depth: number,
    includeRelated: boolean,
    maxNodes: number
  ): GraphViewResult | null {
    const rootDoc = this.graph.documents.get(rootId);
    if (!rootDoc) return null;

    const effectiveDepth = Math.min(depth, 4);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    const walk = (id: string, currentDepth: number) => {
      if (visited.has(id) || currentDepth > effectiveDepth || nodes.length >= maxNodes) return;
      visited.add(id);

      const doc = this.graph.documents.get(id);
      if (!doc) return;

      nodes.push({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        domain: doc.domain,
        wordCount: doc.wordCount,
        childrenCount: doc.childrenIds.length,
      });

      for (const childId of doc.childrenIds) {
        if (nodes.length >= maxNodes) break;
        edges.push({ source: id, target: childId, type: "child" });
        walk(childId, currentDepth + 1);
      }

      if (includeRelated) {
        for (const relatedId of doc.related) {
          if (this.graph.documents.has(relatedId)) {
            edges.push({ source: id, target: relatedId, type: "related" });
            if (!visited.has(relatedId) && nodes.length < maxNodes) {
              const relDoc = this.graph.documents.get(relatedId)!;
              nodes.push({
                id: relDoc.id,
                title: relDoc.title,
                type: relDoc.type,
                domain: relDoc.domain,
                wordCount: relDoc.wordCount,
                childrenCount: relDoc.childrenIds.length,
              });
              visited.add(relatedId);
            }
          }
        }
      }
    };

    walk(rootId, 0);
    return { nodes, edges };
  }

  list(filters: ListFilters = {}): ListResult {
    const docs: ListItem[] = [];

    for (const doc of this.graph.documents.values()) {
      if (!filters.includeDrafts && doc.status === "draft") continue;
      if (filters.domain && doc.domain.toLowerCase() !== filters.domain.toLowerCase()) continue;
      if (filters.type && doc.type !== filters.type) continue;
      if (filters.phase && !doc.phase.includes(filters.phase)) continue;
      if (filters.tags && filters.tags.length > 0) {
        const docTagsLower = new Set(doc.tags.map((t) => t.toLowerCase()));
        if (!filters.tags.every((t) => docTagsLower.has(t.toLowerCase()))) continue;
      }
      if (
        filters.titleSearch &&
        !doc.title.toLowerCase().includes(filters.titleSearch.toLowerCase())
      )
        continue;

      docs.push({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        domain: doc.domain,
        tags: doc.tags,
        wordCount: doc.wordCount,
        status: doc.status,
        lastUpdated: doc.lastUpdated,
      });
    }

    docs.sort((a, b) => a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));
    return { docs, totalDocs: this.graph.documents.size };
  }

  validate(): ValidationReport {
    return validateGraph(this.graph);
  }

  stats(): GraphStats {
    return computeStats(this.graph);
  }

  // --- Write operations ---

  async write(params: WriteParams): Promise<WriteResult> {
    return this.enqueueWrite(async () => {
      const result = writeDocument(
        this.graph,
        this.tfidfIndex,
        this.knowledgeDir,
        params,
        this.validDomains,
        this.validPhaseIds
      );
      this.tfidfIndex = result.tfidfIndex;
      log.info("write", { id: params.id, status: result.status });
      return result;
    });
  }

  async delete(id: string): Promise<DeleteResult> {
    return this.enqueueWrite(async () => {
      const result = deleteDocument(this.graph, this.tfidfIndex, this.knowledgeDir, id);
      this.tfidfIndex = result.tfidfIndex;
      log.info("delete", { id });
      return result;
    });
  }

  previewDelete(id: string): { warnings: string[] } {
    return previewDelete(this.graph, id);
  }

  /** Write multiple documents in sequence, sharing a single queue slot. */
  async bulkWrite(paramsList: WriteParams[]): Promise<WriteResult[]> {
    return this.enqueueWrite(async () => {
      const results: WriteResult[] = [];
      for (const params of paramsList) {
        const result = writeDocument(
          this.graph,
          this.tfidfIndex,
          this.knowledgeDir,
          params,
          this.validDomains,
          this.validPhaseIds
        );
        this.tfidfIndex = result.tfidfIndex;
        results.push(result);
      }
      log.info("bulk_write", { count: paramsList.length });
      return results;
    });
  }

  /** Detect knowledge gaps: sparse domains, missing cross-links, underserved tags. */
  detectGaps(): {
    sparseDomains: Array<{ domain: string; count: number }>;
    isolatedClusters: string[];
    underTagged: string[];
  } {
    const domainCounts = new Map<string, number>();
    const isolatedClusters: string[] = [];
    const underTagged: string[] = [];

    for (const doc of this.graph.documents.values()) {
      domainCounts.set(doc.domain, (domainCounts.get(doc.domain) || 0) + 1);

      // Isolated: no related links in or out
      const backlinks = this.graph.backlinkIndex.get(doc.id);
      if (
        doc.related.length === 0 &&
        (!backlinks || backlinks.size === 0) &&
        doc.type !== "summary"
      ) {
        isolatedClusters.push(doc.id);
      }

      // Under-tagged: fewer than 2 tags
      if (doc.tags.length < 2 && doc.type !== "summary") {
        underTagged.push(doc.id);
      }
    }

    // Sparse domains: fewer than 3 docs
    const sparseDomains = [...domainCounts.entries()]
      .filter(([, count]) => count < 3)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => a.count - b.count);

    return { sparseDomains, isolatedClusters, underTagged };
  }

  // --- Internal ---

  /** @internal Exposed for backward compatibility */
  get bm25Index(): Bm25Index {
    return this.tfidfIndex;
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  // --- File watching ---

  /** Start watching the knowledge directory for external file changes. */
  watch(): void {
    if (this.watchers.length > 0) return;

    const handler = (eventType: string, filename: string | null) => {
      if (!filename) return;
      const fullPath = resolve(this.knowledgeDir, filename);

      // Determine change type
      if (filename.endsWith(".md")) {
        const exists = existsSync(fullPath);
        this.pendingChanges.set(fullPath, exists ? "change" : "delete");
      } else if (filename === ".embeddings.json") {
        this.pendingChanges.set(fullPath, "change");
      } else if (filename === ".tags.json") {
        this.pendingChanges.set(fullPath, "change");
      } else {
        return; // Ignore other files
      }

      // Debounce: process after 500ms of quiet
      if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = setTimeout(() => {
        this.watchDebounceTimer = null;
        this.processPendingChanges();
      }, 500);
    };

    try {
      // Try recursive watcher (supported on macOS and Windows, Node 20+)
      const watcher = watch(this.knowledgeDir, { recursive: true }, handler);
      watcher.unref();
      this.watchers.push(watcher);
      log.info("file_watcher_started", { dir: this.knowledgeDir });
    } catch {
      // Fallback for Linux: watch each directory individually
      try {
        this.watchDirectoriesRecursive(this.knowledgeDir, handler);
        log.info("file_watcher_started", { dir: this.knowledgeDir, mode: "per-directory" });
      } catch (err) {
        log.warn("file_watcher_error", { error: String(err) });
      }
    }
  }

  private watchDirectoriesRecursive(
    dir: string,
    handler: (eventType: string, filename: string | null) => void
  ): void {
    const watcher = watch(dir, (eventType, filename) => {
      if (!filename) return;
      // Convert to relative path from knowledgeDir
      const relFromKnowledge = relative(this.knowledgeDir, join(dir, filename));
      handler(eventType, relFromKnowledge);
    });
    watcher.unref();
    this.watchers.push(watcher);

    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            this.watchDirectoriesRecursive(fullPath, handler);
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  /** Stop watching for file changes. */
  close(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    this.pendingChanges.clear();
  }

  private processPendingChanges(): void {
    const changes = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    for (const [fullPath, changeType] of changes) {
      const filename = relative(this.knowledgeDir, fullPath);

      if (filename === ".embeddings.json") {
        this.reloadEmbeddings();
        continue;
      }
      if (filename === ".tags.json") {
        this.graph.tagTaxonomy = loadTagTaxonomy(this.knowledgeDir);
        log.info("tag_taxonomy_reloaded");
        continue;
      }

      // Markdown file change
      if (filename.endsWith(".md")) {
        if (changeType === "delete") {
          this.handleFileDeleted(fullPath);
        } else {
          this.handleFileChanged(fullPath);
        }
      }
    }
  }

  private reloadEmbeddings(): void {
    // Acquire embedding lock to prevent race with concurrent embedSingleDocument
    this.embeddingLock = this.embeddingLock.then(() => {
      const newEmbeddings = loadEmbeddings(this.knowledgeDir);
      this.graph.embeddings.vectors = newEmbeddings.vectors;
      this.graph.embeddings.available = newEmbeddings.available;
      this.graph.embeddings.normalized = newEmbeddings.normalized;
      log.info("embeddings_reloaded", { count: newEmbeddings.vectors.size });
    });
  }

  private handleFileChanged(fullPath: string): void {
    const doc = loadSingleDocument(fullPath, this.knowledgeDir, this.validDomains);
    if (!doc) return;

    const oldDoc = this.graph.documents.get(doc.id) ?? null;

    // Remove old indices if updating
    if (oldDoc) {
      removeFromIndices(this.graph, oldDoc);
      this.graph.filePathIndex.delete(oldDoc.filePath);
    }

    // Add to graph and indices
    this.graph.documents.set(doc.id, doc);
    addToIndices(this.graph, doc);
    this.graph.filePathIndex.set(doc.filePath, doc.id);

    // Update parent's children
    if (doc.parentId) {
      const parent = this.graph.documents.get(doc.parentId);
      if (parent && !parent.childrenIds.includes(doc.id)) {
        parent.childrenIds.push(doc.id);
      }
    }

    // Update BM25 index
    updateBm25Index(this.tfidfIndex, doc.id, doc);

    // Fire-and-forget embedding (sequenced through lock to prevent race with reloadEmbeddings)
    this.embeddingLock = this.embeddingLock.then(() =>
      embedSingleDocument(this.graph.embeddings, this.knowledgeDir, doc).catch((err) => {
        log.warn("embed_doc_fire_and_forget", { id: doc.id, error: String(err) });
      })
    );

    log.info("file_change_detected", { id: doc.id, action: oldDoc ? "updated" : "created" });
  }

  private handleFileDeleted(fullPath: string): void {
    // O(1) lookup via filePathIndex
    const relPath = relative(join(this.knowledgeDir, ".."), fullPath);
    const docId = this.graph.filePathIndex.get(relPath) ?? null;
    if (!docId) return;

    const doc = this.graph.documents.get(docId);
    if (!doc) return;

    // Remove from filePathIndex
    this.graph.filePathIndex.delete(relPath);

    // Remove from indices
    removeFromIndices(this.graph, doc);

    // Remove from parent's children
    if (doc.parentId) {
      const parent = this.graph.documents.get(doc.parentId);
      if (parent) {
        parent.childrenIds = parent.childrenIds.filter((c) => c !== docId);
      }
    }

    // Remove backlink entry
    this.graph.backlinkIndex.delete(docId);

    // Remove from documents map
    this.graph.documents.delete(docId);

    // Update BM25 index
    updateBm25Index(this.tfidfIndex, docId, null);

    // Remove embedding
    removeEmbedding(this.graph.embeddings, this.knowledgeDir, docId);

    log.info("file_change_detected", { id: docId, action: "deleted" });
  }
}
