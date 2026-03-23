# Changelog

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
