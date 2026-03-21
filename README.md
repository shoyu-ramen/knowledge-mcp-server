# knowledge-mcp-server

MCP server for semantic search, CRUD, and graph operations over hierarchical knowledge bases stored as Markdown with YAML frontmatter.

Provides 8 tools via [Model Context Protocol](https://modelcontextprotocol.io/): `knowledge_search`, `knowledge_lookup`, `knowledge_graph`, `knowledge_list`, `knowledge_write`, `knowledge_delete`, `knowledge_validate`, and `knowledge_stats`.

## Quick Start

```bash
# Initialize a new knowledge directory (also creates .mcp.json for Claude Code)
npx knowledge-mcp-server init

# Start the MCP server
npx knowledge-mcp-server
```

## Installation

```bash
npm install knowledge-mcp-server
```

## Claude Code Integration

Running `npx knowledge-mcp-server init` automatically creates a `.mcp.json` file in your project root, registering the server with Claude Code. If you need to configure it manually, add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "knowledge": {
      "type": "stdio",
      "command": "npx",
      "args": ["knowledge-mcp-server", "--knowledge-dir", "./knowledge"]
    }
  }
}
```

By default, the server uses a local embedding model (`Xenova/all-MiniLM-L6-v2`) for hybrid BM25 + vector search — no API keys required. The model is downloaded automatically on first use (~23MB).

## CLI Reference

```
knowledge-mcp-server [command] [options]

Commands:
  serve       Start the MCP server over stdio (default)
  embeddings  Generate embeddings for all documents
  init        Scaffold a new knowledge/ directory with config template
  validate    Run graph integrity checks and report issues

Options:
  --knowledge-dir <path>  Path to knowledge directory (default: ./knowledge)
  --help, -h              Show help
  --version               Show version
```

### Generate Embeddings

```bash
# Local model (default, no API key needed)
npx knowledge-mcp-server embeddings

# Or with Voyage AI (requires config + API key)
VOYAGE_API_KEY=your-key npx knowledge-mcp-server embeddings
```

Uses incremental hashing — only re-embeds documents whose content has changed. Automatically detects provider/model changes and re-embeds all documents when switching.

### Validate Graph

```bash
npx knowledge-mcp-server validate
```

Checks for: orphaned documents, broken references, circular parents, missing tags, empty summaries, stale documents (>6 months), and embedding coverage. Exits with code 1 if integrity issues are found.

## Programmatic API

```typescript
import { createKnowledgeServer } from "knowledge-mcp-server";

const { server, graph, tfidfIndex, config } = createKnowledgeServer("./knowledge");
```

### Exported Types

```typescript
import type {
  KnowledgeServerResult,
  KnowledgeGraph,
  KnowledgeDocument,
  KnowledgeConfig,
} from "knowledge-mcp-server";
```

## Document Format

Knowledge documents are Markdown files with YAML frontmatter:

```markdown
---
id: technology/audio-detection/pitch-detection
title: Pitch Detection Pipeline
type: detail
domain: technology
subdomain: audio-detection
tags: [audio, ml, crepe, yin]
phase: [1]
related: [technology/audio-detection/chord-recognition]
---

Your document content here in Markdown.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique document ID (lowercase, hyphens, slashes) |
| `title` | yes | Human-readable title |
| `type` | yes | `summary`, `detail`, `decision`, or `reference` |
| `domain` | yes | Top-level domain |
| `subdomain` | no | Subdomain within the domain |
| `tags` | yes | Array of searchable tags |
| `phase` | yes | Array of applicable phase numbers |
| `related` | no | Array of related document IDs |
| `status` | no | `active` (default), `draft`, or `deprecated` |

### Directory Structure

```
knowledge/
├── knowledge.config.yaml    # Configuration (optional)
├── _summary.md              # Root node
├── .embeddings.json         # Generated embeddings (optional)
├── .embeddings-hashes.json  # Content hashes for change detection
├── .tags.json               # Tag taxonomy (optional)
├── technology/
│   ├── _summary.md
│   └── audio-detection/
│       ├── _summary.md
│       └── pitch-detection.md
└── business/
    ├── _summary.md
    └── pricing-tiers.md
```

## Configuration

`knowledge.config.yaml` is optional. Without it, the server runs in zero-config mode (permissive validation, auto-discovered domains).

```yaml
name: "my-project"

# Strict domain validation (only these domains are accepted)
domains:
  - technology
  - architecture
  - business

# Phase definitions with optional aliases
phases:
  - id: 1
    name: "Foundation"
    aliases: ["launch", "mvp"]
  - id: 2
    name: "Growth"

# Query hints for domain classification
query_hints:
  technology: ["api", "database", "framework", "library"]
  business: ["pricing", "revenue", "market"]

# Synonym expansion for search
synonyms:
  ml: ["machine learning"]
  ai: ["artificial intelligence"]
  dkt: ["deep knowledge tracing"]

# Embedding configuration (local model by default, no API key needed)
embeddings:
  provider: "local"                   # "local" (default) or "voyage"
  model: "Xenova/all-MiniLM-L6-v2"   # local model (384 dims)
  # cache_dir: "~/.cache/my-models"  # optional model cache override

# To use Voyage AI instead:
# embeddings:
#   provider: "voyage"
#   model: "voyage-3-lite"
#   api_key_env: "VOYAGE_API_KEY"
```

## Search Architecture

The search pipeline uses a 4-stage hybrid approach:

1. **Query Classification** — extracts domains, phases, and query type from natural language
2. **Metadata Pre-filter** — O(1) lookups via in-memory indices (domain, phase, tag, type)
3. **Hybrid Scoring** — BM25 full-text search (k1=1.2, b=0.75, title 3x boost) + vector embeddings (local or Voyage AI), merged via Reciprocal Rank Fusion (RRF, k=60)
4. **Hierarchical Expansion** — includes ancestor documents and cross-references within a word budget

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VOYAGE_API_KEY` | No | Voyage AI API key (only when `provider: "voyage"` is configured) |
| `TRANSFORMERS_CACHE` | No | Override cache directory for local embedding model files |
| `LOG_LEVEL` | No | Logging verbosity: `debug`, `info` (default), `warn`, `error` |

## License

MIT
