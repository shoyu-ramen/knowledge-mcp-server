import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { buildGraph, getAncestors, getRelated, loadTagTaxonomy } from "./graph.js";
import { knowledgeSearch } from "./search.js";
import {
  buildTfIdfIndex,
  updateBm25Index,
  loadEmbeddings,
  embedSingleDocument,
  removeEmbedding,
  type Bm25Index,
} from "./embeddings.js";
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
import { initEmbeddingProvider } from "./embedding-provider.js";
import type { DetailLevel } from "./formatter.js";

// --- Public types for engine consumers ---

export interface SearchOptions {
  query: string;
  domains?: string[];
  phases?: number[];
  tags?: string[];
  type?: string;
  maxResults?: number;
  detailLevel?: DetailLevel;
  includeDrafts?: boolean;
}

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
  private watcher: FSWatcher | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Map<string, "change" | "delete">();

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
    const start = Date.now();
    this.config = loadConfig(knowledgeDir);
    initEmbeddingProvider(this.config?.embeddings);
    this.validDomains = getEffectiveDomains(this.config, knowledgeDir);
    this.validPhaseIds = getEffectivePhaseIds(this.config);
    this.graph = buildGraph(knowledgeDir, this.validDomains);
    this.tfidfIndex = buildTfIdfIndex(this.graph.documents);
    this.classifierConfig = buildClassifierConfig(this.config);
    const elapsed = Date.now() - start;
    log.info("startup", {
      docs: this.graph.documents.size,
      embeddings: this.graph.embeddings.vectors.size,
      embeddingsAvailable: this.graph.embeddings.available,
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
      this.classifierConfig
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
    if (this.watcher) return;
    try {
      this.watcher = watch(this.knowledgeDir, { recursive: true }, (eventType, filename) => {
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
      });

      // Unref so the watcher doesn't keep the process alive
      this.watcher.unref();
      log.info("file_watcher_started", { dir: this.knowledgeDir });
    } catch (err) {
      log.warn("file_watcher_error", { error: String(err) });
    }
  }

  /** Stop watching for file changes. */
  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
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
    const newEmbeddings = loadEmbeddings(this.knowledgeDir);
    this.graph.embeddings.vectors = newEmbeddings.vectors;
    this.graph.embeddings.available = newEmbeddings.available;
    this.graph.embeddings.normalized = newEmbeddings.normalized;
    log.info("embeddings_reloaded", { count: newEmbeddings.vectors.size });
  }

  private handleFileChanged(fullPath: string): void {
    const doc = loadSingleDocument(fullPath, this.knowledgeDir, this.validDomains);
    if (!doc) return;

    const oldDoc = this.graph.documents.get(doc.id) ?? null;

    // Remove old indices if updating
    if (oldDoc) {
      this.removeFromIndices(oldDoc);
    }

    // Add to graph and indices
    this.graph.documents.set(doc.id, doc);
    this.addToIndices(doc);

    // Update parent's children
    if (doc.parentId) {
      const parent = this.graph.documents.get(doc.parentId);
      if (parent && !parent.childrenIds.includes(doc.id)) {
        parent.childrenIds.push(doc.id);
      }
    }

    // Update BM25 index
    updateBm25Index(this.tfidfIndex, doc.id, doc);

    // Fire-and-forget embedding
    embedSingleDocument(this.graph.embeddings, this.knowledgeDir, doc).catch(() => {});

    log.info("file_change_detected", { id: doc.id, action: oldDoc ? "updated" : "created" });
  }

  private handleFileDeleted(fullPath: string): void {
    // Find the doc that was at this path
    const relPath = relative(join(this.knowledgeDir, ".."), fullPath);
    let docId: string | null = null;
    for (const [id, doc] of this.graph.documents) {
      if (doc.filePath === relPath) {
        docId = id;
        break;
      }
    }
    if (!docId) return;

    const doc = this.graph.documents.get(docId);
    if (!doc) return;

    // Remove from indices
    this.removeFromIndices(doc);

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

  private removeFromIndices(doc: KnowledgeDocument): void {
    for (const tag of doc.tags) {
      const tagSet = this.graph.tagIndex.get(tag.toLowerCase());
      if (tagSet) {
        tagSet.delete(doc.id);
        if (tagSet.size === 0) this.graph.tagIndex.delete(tag.toLowerCase());
      }
    }
    const domainSet = this.graph.domainIndex.get(doc.domain.toLowerCase());
    if (domainSet) {
      domainSet.delete(doc.id);
      if (domainSet.size === 0) this.graph.domainIndex.delete(doc.domain.toLowerCase());
    }
    for (const phase of doc.phase) {
      const phaseSet = this.graph.phaseIndex.get(phase);
      if (phaseSet) {
        phaseSet.delete(doc.id);
        if (phaseSet.size === 0) this.graph.phaseIndex.delete(phase);
      }
    }
    const typeSet = this.graph.typeIndex.get(doc.type);
    if (typeSet) {
      typeSet.delete(doc.id);
      if (typeSet.size === 0) this.graph.typeIndex.delete(doc.type);
    }
    for (const targetId of doc.related) {
      const backlinks = this.graph.backlinkIndex.get(targetId);
      if (backlinks) {
        backlinks.delete(doc.id);
        if (backlinks.size === 0) this.graph.backlinkIndex.delete(targetId);
      }
    }
  }

  private addToIndices(doc: KnowledgeDocument): void {
    for (const tag of doc.tags) {
      const lower = tag.toLowerCase();
      if (!this.graph.tagIndex.has(lower)) this.graph.tagIndex.set(lower, new Set());
      this.graph.tagIndex.get(lower)!.add(doc.id);
    }
    const domainLower = doc.domain.toLowerCase();
    if (!this.graph.domainIndex.has(domainLower))
      this.graph.domainIndex.set(domainLower, new Set());
    this.graph.domainIndex.get(domainLower)!.add(doc.id);
    if (!this.graph.typeIndex.has(doc.type)) this.graph.typeIndex.set(doc.type, new Set());
    this.graph.typeIndex.get(doc.type)!.add(doc.id);
    for (const phase of doc.phase) {
      if (!this.graph.phaseIndex.has(phase)) this.graph.phaseIndex.set(phase, new Set());
      this.graph.phaseIndex.get(phase)!.add(doc.id);
    }
    for (const targetId of doc.related) {
      if (!this.graph.backlinkIndex.has(targetId))
        this.graph.backlinkIndex.set(targetId, new Set());
      this.graph.backlinkIndex.get(targetId)!.add(doc.id);
    }
  }
}
