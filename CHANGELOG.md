# Changelog

## 1.4.1

### Added
- "compact" detail level for search and lookup — ~200 words per primary result, metadata only for ancestors/related
- `include_ancestors` parameter for `knowledge_search` (default false) — ancestors now opt-in for search
- `include_facets` parameter for `knowledge_search` (default false) — facets now opt-in
- `verbose` parameter for `knowledge_search` (default false) — debug metadata (similarity, matched_on, scoring_method, path) now opt-in

### Changed
- Default `detail_level` for `knowledge_search` changed from "normal" to "summary" (~500 words vs ~1500 words per result)
- Lookup ancestor content now capped at summary budget (40 words) regardless of content level
- Reduced related-doc expansion limits (specific: 3→1, broad: 2→1, procedural: 2→1, troubleshooting: 1→0)

## 1.4.0

### Added
- BM25 index caching (`.bm25-cache.json`) — skips expensive index rebuilds on startup when documents haven't changed
- Extracted text processing module — lightweight suffix stemmer (18 rules), 220+ stopwords, compound-term-aware tokenizer (`src/text.ts`)
- Graph export in Mermaid and DOT/Graphviz formats via `export` CLI command
- Search analytics logging to `.search-analytics.jsonl` and `analytics` CLI command for usage summaries
- Structured search results via `knowledgeSearchStructured()` for programmatic consumers
- MMR (Maximal Marginal Relevance) diversification to reduce near-duplicate search results
- New query types: `procedural` and `troubleshooting` with keyword-based classification
- Async document loading (`loadDocumentsAsync()`) with configurable concurrency for large knowledge bases
- BM25 tuning parameters in `knowledge.config.yaml` (`bm25.k1`, `bm25.b`)
- Config structural validation with non-fatal warnings (`validateConfig()`)
- CLI `search` command with `--phase`, `--tags`, `--json` options
- Shared index-ops module (`src/index-ops.ts`) eliminating duplicated index mutation code across engine, writer, and tests
- Centralized constants module (`src/constants.ts`) for `ID_PATTERN`, `VALID_TYPES`, `VERSION`
- `filePathIndex` on `KnowledgeGraph` for O(1) file-path-to-docId lookups (file watcher support)
- File watcher integration tests (`test/file-watcher.test.ts`)

### Changed
- Embeddings now use `Float32Array` instead of `number[]` for memory efficiency
- Staleness penalty uses log-decay formula instead of binary 6-month threshold
- BM25 scoring extracted to dedicated module (`src/bm25.ts`) with per-field weighting (title 3×, tags 2×, body 1×)
- `TfIdfIndex` renamed to `Bm25Index` throughout (backward-compatible re-exports preserved)

## 1.3.0

### Added
- `KnowledgeEngine` class for programmatic access to all operations (search, lookup, write, delete, list, validate, stats, graphView)
- Local embedding provider via Transformers.js — no API keys required (default model: `BAAI/bge-small-en-v1.5`)
- Adaptive RRF k-value that scales with corpus size for better small-corpus ranking
- Search confidence scoring (high/medium/low) in result metadata
- Bidirectional synonym expansion in query classifier
- New CLI commands: `stats` and `list` with `--domain` and `--type` filters
- `previewDelete()` for dry-run deletion with impact warnings
- File watching for live document updates with debounced reload
- Process exit handlers to flush pending embedding writes
- Batch lookup support in `knowledge_lookup` tool
- Facets (domain/type/phase counts) now appear before documents in search results

### Changed
- Default local embedding model changed from `Xenova/all-MiniLM-L6-v2` to `BAAI/bge-small-en-v1.5`
- `createKnowledgeServer()` now returns `engine` field (primary API surface); `graph` and `tfidfIndex` are deprecated

### Deprecated
- `KnowledgeServerResult.graph` — use `engine.graph` instead
- `KnowledgeServerResult.tfidfIndex` — use `engine.bm25Index` instead
- `TfIdfIndex` type alias — use `Bm25Index` instead

## 1.0.0

Initial release. Extracted from guitar-app project.

- MCP server with 8 tools: search, lookup, graph, list, write, delete, validate, stats
- BM25 full-text search with optional Voyage AI vector embeddings (hybrid RRF fusion)
- CLI with subcommands: serve, embeddings, init, validate
- Zero-config mode (works without knowledge.config.yaml)
- Programmatic API via `createKnowledgeServer()`
