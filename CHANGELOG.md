# Changelog

## 1.0.0

Initial release. Extracted from guitar-app project.

- MCP server with 8 tools: search, lookup, graph, list, write, delete, validate, stats
- BM25 full-text search with optional Voyage AI vector embeddings (hybrid RRF fusion)
- CLI with subcommands: serve, embeddings, init, validate
- Zero-config mode (works without knowledge.config.yaml)
- Programmatic API via `createKnowledgeServer()`
