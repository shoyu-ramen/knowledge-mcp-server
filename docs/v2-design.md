# knowledge-mcp-server V2 Design

**Status:** draft
**Owner:** Ross Kuehl
**Date:** 2026-05-21
**Working title:** *"search you can trust, write you can iterate on"*

---

## 1. Executive Summary

knowledge-mcp-server v1.5 is a solid MVP: hybrid BM25 + vector retrieval, file-based markdown storage, an MCP server with 8 tools. Dogfooding has surfaced four classes of limit:

- **Search quality** — the retrieval pipeline has no evaluation harness; we can't tell whether ranking improves release-over-release. Whole-document scoring means a long detail doc with one relevant section under-ranks against shorter docs.
- **Token cost** — even after the 1.4.1/1.5.0 budget trim, an empty default search response burns ~600 tokens of XML structure; primaries dominate at 500 words each.
- **Write workflow** — writes are "drop the file and re-index". No drafts, no patches, no transactional bulk operations, no machine-readable validation feedback.
- **Scale & surface area** — synchronous full-corpus load at startup, one in-process KB per server, stdio-only transport, and a single JSON file for embeddings that's rewritten on every change.

V2 is a major version that addresses all four. It re-grounds the system around three new primitives: **document chunks** (instead of whole-doc-only retrieval), **a persistent index store** (SQLite, replacing the on-startup JSON rebuild), and **a workspaces model** (multiple KBs per server). It also introduces a **cross-encoder reranker**, a built-in **eval harness**, and **HTTP+SSE transport** alongside stdio.

V2 will break v1's wire format, file layout, and config schema. A one-shot migration CLI (`migrate-v1`) ships with V2.0.0. No compatibility shims are maintained beyond migration.

## 2. Goals & Non-Goals

### Goals
- **G1 — Measurably better retrieval.** Publish nDCG@10 and recall@10 against an eval set; demonstrate ≥15% nDCG improvement over v1.5 on a curated 100-query benchmark.
- **G2 — Halve default response cost.** Cut default search response tokens by ≥50% at parity quality, primarily via chunk-level returns and JSON-LD output.
- **G3 — First-class write workflow.** Drafts, section-level patches, transactional bulk writes, structured validation reports.
- **G4 — Multi-tenant ready.** One server, N knowledge bases. Per-KB config, embeddings, indices.
- **G5 — Production transport.** HTTP+SSE alongside stdio. Bearer-token auth. Optional read-only web UI.
- **G6 — Persistent indices.** Sub-200ms cold start at 10K docs. No JSON-file rebuilds at boot.

### Non-Goals (V2.0)
- **NG1** — No hosted SaaS. We ship the primitives (HTTP transport, multi-tenancy, auth); v2.1+ can build on them.
- **NG2** — No learned-to-rank from user clicks. Eval is curated ground truth.
- **NG3** — No graph traversal beyond depth 4 (existing limit stands).
- **NG4** — No LLM-driven writes (auto-summary, suggested tags). Writes are mechanical.
- **NG5** — No backwards compatibility with v1 file format or config. Strict migration only.

## 3. Current State Assessment

Grounded observations against the v1.5 code:

1. **Response shape is structural-heavy.** Every result emits `<document id="…" type="…" relevance="…">…<title>…</title><tags>…</tags>…<content>…</content></document>` — ~80–120 bytes of structure before any content. For a 10-result response at "summary" detail (5 primaries × 500 words + 1 expanded × 150), structure overhead is ~1.2 KB of an ~8 KB response. Owner: `src/formatter.ts:142-204`.

2. **Whole-doc retrieval.** BM25 + cosine score at the document level (`src/search.ts:144-220`, `src/bm25.ts`). A 5,000-word detail doc with one relevant section pays its full length penalty against shorter docs. No chunk-level scoring.

3. **No evaluation harness.** `src/search-analytics.ts` logs queries; there is no ground truth, no per-release benchmark, no regression detection. `confidence` is a heuristic over score-distribution moments (`src/search.ts:476-486`).

4. **Startup is a synchronous full scan.** `loadDocuments` (`src/loader.ts:179`) walks the entire tree, parses every file, then `buildGraph` (`src/graph.ts:111`) constructs five in-memory indices, then the BM25 cache is loaded or rebuilt. At 10K docs this is several seconds of blocking work.

5. **Embeddings persistence is JSON-monolithic.** `.embeddings.json` is one object with `{docId: [384 floats]}` serialized on every change, debounced to 5s (`src/embeddings.ts:227-249`). At 10K docs × 384 dims this is ~30 MB rewritten per debounce window.

6. **Write workflow is overwrite-only.** `writeDocument` (`src/writer.ts:149-314`) writes the full file each call. No patch path. No draft → review state. Validation `warnings` are returned in `WriteResult` but the MCP tool returns them as free text (`src/index.ts:307`), not a machine-readable schema the agent can act on.

7. **File watcher is a race surface.** `src/engine.ts:374-415` watches recursively; `handleFileChanged` (`src/engine.ts:500-536`) does not go through the `writeQueue`, so an MCP-tool write and a watcher-detected external change can race. The `embeddingLock` serializes embedding I/O but not index mutation.

8. **Single KB per server.** `KnowledgeEngine` takes a single `knowledgeDir` (`src/engine.ts:101`). One MCP server = one KB. Multi-KB requires multiple server processes.

9. **Stdio-only.** `src/cli.ts:128-132` wires `StdioServerTransport`. The MCP SDK supports HTTP+SSE; we don't expose it.

10. **Legacy rename shims persist.** `TfIdfIndex` re-exports across `src/bm25.ts`, `src/search.ts`, `src/embeddings.ts`, `src/writer.ts`. `tfidfIndex` field on `KnowledgeEngine` (`src/engine.ts:107`). Deprecated `.graph` / `.tfidfIndex` on `KnowledgeServerResult` (`src/index.ts:23-25`). Carrying cost: confusion, two places to update.

## 4. Proposed Architecture

### 4.1 Document Model 2.0 — Chunks

In v1 the unit of retrieval, embedding, and ranking is the document. In v2 each document has a **chunk plan** computed at write time:

- Docs ≤512 tokens: one chunk, the whole doc.
- Docs >512 tokens: split by `##` heading (re-using the section parser from `src/formatter.ts`); merge consecutive short sections; cap at 800 tokens per chunk; 50-token overlap.
- Each chunk gets a stable `chunkId = ${docId}#${sectionPath}` and its own embedding vector.

Retrieval becomes:

1. **Chunk-level BM25 + vector** → top-K chunks.
2. **Doc-level aggregation** → group chunks by docId, take max chunk score, with a bonus for multiple matching chunks (`agg = max_chunk + 0.1 * log(matching_chunks)`).
3. **Response surface** → return the matching chunk's content (not the whole doc), plus a 1-paragraph doc summary header. This is the lever that cuts token cost.

Storage: chunks live in the same markdown file (no on-disk fragmentation), but the persistent index stores the chunk plan, content, and embedding per chunk.

### 4.2 Persistent Index Store — SQLite

Replace `.embeddings.json`, `.bm25-cache.json`, `.embeddings-hashes.json` with one SQLite database at `.index.db`:

```
docs(id, title, type, domain, subdomain, status, last_updated, content_hash, ...)
chunks(chunk_id, doc_id, section_path, content, token_count, embedding BLOB)
bm25_postings(term, chunk_id, tf, field)        -- field ∈ {title, tags, body}
bm25_doc_freq(term, count)
metadata_index(field, value, doc_id)            -- inverted index for tag/domain/phase/type
backlinks(target_id, source_id)
```

Why SQLite:
- Zero ops, single-file, well-understood.
- WAL mode allows safe concurrent reads during writes.
- `mmap_size` lets vector BLOBs (1.5 KB each at 384 dims) be served from page cache — competitive with the in-memory `Map` at ≤100K docs.
- Native `node:sqlite` (Node 22+) or `better-sqlite3` (Node 20+) both work.

Index updates are incremental on writes; a `knowledge-mcp-server reindex` CLI rebuilds from scratch. Cold start = open DB + memory-map vectors ≈ sub-100ms even at 10K docs.

### 4.3 Retrieval Pipeline 2.0

1. **Query understanding (lightweight).** Keep the v1 regex classifier as a fallback. Add an optional `query_hints` parameter on `knowledge_search` so the calling LLM can pass structured hints: `{domains: [...], intent: "...", expected_doc_types: [...]}`. Document this in the tool description so agents learn to populate it.
2. **Candidate generation.** BM25 + vector over chunks; RRF merge with adaptive k; pull top-50 chunks.
3. **Cross-encoder rerank.** Run a small CPU-tractable cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, ~80 MB) over the 50 chunks. Biggest single quality lever. Cost: ~200ms cold / ~50ms warm at top-50 on a laptop. Opt-in via `search.rerank: true` (off by default to preserve "free local" identity).
4. **MMR diversification + aggregation.** Dedupe by docId; apply MMR (carried from `src/reranker.ts`); aggregate chunk scores to docs.
5. **Response.** Return chunks (default 5) with their parent doc's title/metadata as a compact header.

### 4.4 Evaluation Harness

`eval/queries.yaml` — list of `{query, relevant_doc_ids, relevant_chunk_ids?}`. `npm run eval` computes nDCG@10, recall@10, MRR. CI gate: regression >2% fails the run. Seed with 100 hand-curated queries against the dogfood knowledge base (the project we extracted from). Future: opt-in feedback via `knowledge_feedback(query_id, doc_id, was_useful)` — collected anonymously, off by default.

### 4.5 Response Format — JSON-LD Compact

Replace XML with JSON. Example V2 search response:

```json
{
  "@context": "https://kmcp.dev/v2/schema",
  "query": "pitch detection algorithm",
  "method": "hybrid+rerank",
  "confidence": "high",
  "chunks": [
    {
      "doc_id": "technology/audio-detection/pitch-detection",
      "section": "Algorithm",
      "title": "Pitch Detection Pipeline",
      "type": "detail",
      "score": 0.87,
      "content": "…the matching section content…"
    }
  ],
  "expand": { "doc_id": "…", "section": "…" }
}
```

Structural overhead per result: ~30 bytes (vs 80–120 in XML). The `expand` cursor lets the agent pull additional chunks of the same doc without a fresh search call. Tool `description` strings in `src/index.ts` get a hard re-edit pass — every byte ships in every MCP session.

### 4.6 Write Workflow

- **`knowledge_write`** (existing semantics, refined): full-doc create/update. Returns a structured `validation: {errors: [], warnings: [], suggestions: []}` object instead of free text.
- **`knowledge_patch`** (new): targeted edits.
  - `{id, op: "replace_section", section: "Algorithm", content: "…"}`
  - `{id, op: "add_tag", tag: "…"}`
  - `{id, op: "set_status", status: "deprecated"}`
- **`knowledge_draft`** (new) and **`knowledge_publish`** (new): write a doc with `status: "draft"` (excluded from search, returns a `draft_id`); promote draft → active.
- **`knowledge_transaction`** (new): atomic multi-op. `{ops: [{tool: "write", params: …}, {tool: "patch", params: …}]}`. All-or-nothing; failures roll back the SQLite tx.
- **Schema enforcement**: when `tag_taxonomy` or `domains` is in strict mode, unknown tags/domains become errors, not warnings.

The `writeQueue` (`src/engine.ts:109`) extends to cover the file-watcher path — all index mutation funnels through one queue. The race in `handleFileChanged` is closed.

### 4.7 Workspaces / Multi-KB

`KnowledgeServer` (new top-level, replacing the singleton output of v1's `createKnowledgeServer`) takes a workspaces config:

```yaml
# kmcp.workspaces.yaml
workspaces:
  - id: "guitar-app"
    path: "./knowledge/guitar"
  - id: "infra-runbooks"
    path: "/home/ross/runbooks"
    embeddings: { provider: voyage, model: voyage-3-lite }
```

Every tool gains an optional `workspace_id` parameter (default: the only workspace if one, else error). Internally `KnowledgeServer` holds a `Map<workspaceId, KnowledgeEngine>`. Single-workspace stays the dominant configuration.

### 4.8 Transport

- **Stdio** stays the default for local agents.
- **HTTP+SSE**: new `serve --http :3030 --auth bearer` mode. Streams MCP messages over SSE. Tokens via env (`KMCP_TOKENS=tok1,tok2`) or a `.tokens` file. CORS configurable.
- **Web UI**: a small static SPA (Vite + Preact, target <50 KB) bundled in `dist/ui/`, served at `/ui` in HTTP mode. **Read-only in V2.0**: browse, search, see the graph. Writes happen via MCP tools, not the UI.

## 5. Breaking Changes (V2.0)

- **File layout**: `.embeddings.json`, `.bm25-cache.json`, `.embeddings-hashes.json` → `.index.db` (SQLite). One-shot migration.
- **Frontmatter**:
  - `phase` becomes optional in zero-config mode (was required in some validation paths).
  - `decision_status` → nested `decision: {status: …, date: …, alternatives: [...]}`.
  - `superseded_by` → `superseded: {by: …}`.
  - `last_updated` is writer-managed only; not user-editable from the tool.
- **Config**: `knowledge.config.yaml` → `kmcp.workspace.yaml` (single-workspace) or `kmcp.workspaces.yaml` (multi). Schema otherwise carried over.
- **Tool surface**: 8 → 11 tools (add `knowledge_patch`, `knowledge_draft`, `knowledge_publish`, `knowledge_transaction`, `knowledge_feedback`). Existing 8 keep their names but their schemas change.
- **Response format**: XML `<knowledge_context>…</knowledge_context>` → JSON-LD. Detail levels collapse from `compact|summary|normal|full` to `chunk|doc|full`.
- **Public API**: `createKnowledgeServer(dir)` → `createKnowledgeServer({workspaces: […]})`. `KnowledgeEngine` becomes per-workspace; top-level is `KnowledgeServer`. Remove `tfidfIndex`, `TfIdfIndex`, deprecated `.graph` / `.tfidfIndex` on result.
- **CLI**: `serve` gains `--http`. `embeddings` → `reindex` (rebuilds everything). New: `migrate-v1`, `eval`.

## 6. Migration Path

`npx knowledge-mcp-server migrate-v1 ./knowledge` performs:

1. Read existing `.embeddings.json`, `.embeddings-hashes.json`, `.bm25-cache.json`, `.tags.json`.
2. Build `.index.db` from the doc tree; carry over embedding vectors if the embedding model hasn't changed (no re-embed needed).
3. Rewrite `knowledge.config.yaml` → `kmcp.workspace.yaml`, preserving all settings.
4. Rewrite frontmatter on each doc to V2 schema, in-place. Warns loudly before each overwrite. Optional `--dry-run`.
5. Print a summary: docs migrated, embeddings carried, schema warnings, any docs the tool refused to touch.

No compatibility shims live in V2 source. Users wanting v1 pin `^1.5.0`.

## 7. Milestones

| Milestone | Duration | Deliverables |
| --- | --- | --- |
| **V2.0-alpha** | ~6 weeks | SQLite index store, chunking pipeline, new file layout, migration CLI, single workspace, stdio only. Search at parity with v1.5 (no rerank yet). Eval harness scaffolded; query set not yet curated. |
| **V2.0-beta** | ~4 weeks | Cross-encoder rerank, JSON-LD response format, new write tools (`patch`, `draft`, `publish`, `transaction`). Eval set seeded with 50 queries; CI gate live. |
| **V2.0-rc** | ~3 weeks | Workspaces, HTTP+SSE transport, bearer auth, bundled read-only web UI. Migration tool hardened on at least 3 real corpora. |
| **V2.0.0** | ~2 weeks | Docs, CHANGELOG, blog post. Publish. |

Total end-to-end: ~15 weeks.

## 8. Risks & Open Questions

- **Cross-encoder cost on small machines.** 80 MB model + ~50ms warm latency may be too heavy for the "free local default" identity. *Mitigation:* keep rerank opt-in via config; ship default-off.
- **SQLite bundling.** Node 22+ has native `node:sqlite`; Node 20 needs `better-sqlite3` (native build, adds a postinstall step). *Decision needed before alpha:* minimum supported Node version.
- **Chunking shifts recall semantics.** A query that matched a doc title in v1 may now match a body chunk and miss the doc-level title boost. *Mitigation:* aggregate `max(chunk_score) + 0.3 * title_match_bonus` instead of chunk-max alone.
- **HTTP transport auth.** Bearer tokens are minimal; scoped tokens per workspace might be needed eventually. *Open question:* simple bearer for 2.0, scoped tokens for 2.1?
- **Web UI scope creep.** Read-only is the discipline; editor mode eats the milestone. Hard line: V2.0 is read-only.
- **In-the-wild data migration.** Published v1 users may have customized frontmatter. The migration tool must be conservative and warn loudly rather than silently rewrite.

## 9. Out of Scope (Explicit)

- Hosted SaaS, billing, multi-user permissions.
- Learned-to-rank from user feedback signals.
- Diff-and-merge for concurrent edits (V2.0 stays last-writer-wins with `content_hash` precondition).
- Non-markdown ingestion (PDFs, HTML, source code) — possible in V2.1 via ingestion adapters.
- LLM-driven writes (auto-summary, suggested tags) — possible in V2.1 as optional tooling.

---

*This document is the source of truth for V2 scope. Changes require a PR against this file with the rationale recorded inline.*
