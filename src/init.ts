import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const CONFIG_TEMPLATE = `# Knowledge graph configuration
# See: https://github.com/rossng/knowledge-mcp-server#configuration

# name: "my-project"

# Uncomment and customize domains to enforce strict validation:
# domains:
#   - technology
#   - architecture
#   - business

# Uncomment to define project phases:
# phases:
#   - id: 1
#     name: "Phase 1"
#   - id: 2
#     name: "Phase 2"

# Uncomment to add query hints for domain classification:
# query_hints:
#   technology: ["api", "database", "framework"]

# Uncomment to define synonym expansion:
# synonyms:
#   ml: ["machine learning"]
#   ai: ["artificial intelligence"]

# Embedding configuration (optional, enables semantic search):
# Default: local model (no API key needed, runs in-process)
# embeddings:
#   provider: "local"                    # "local" (default) or "voyage"
#   model: "Xenova/all-MiniLM-L6-v2"    # local model name
#   # cache_dir: "~/.cache/my-models"   # optional model cache override
#
# To use Voyage AI instead:
# embeddings:
#   provider: "voyage"
#   model: "voyage-3-lite"
#   api_key_env: "VOYAGE_API_KEY"
`;

const ROOT_SUMMARY_TEMPLATE = `---
id: root
title: Knowledge Root
type: summary
domain: root
tags: []
phase: []
---

Root node of the knowledge graph. Add domain directories and documents below this.
`;

interface McpServerEntry {
  type: string;
  command: string;
  args: string[];
}

interface McpJson {
  mcpServers?: Record<string, McpServerEntry>;
}

function updateMcpJson(projectRoot: string, knowledgeDirRelative: string): void {
  const mcpJsonPath = join(projectRoot, ".mcp.json");

  const entry: McpServerEntry = {
    type: "stdio",
    command: "npx",
    args: ["knowledge-mcp-server", "--knowledge-dir", `./${knowledgeDirRelative}`],
  };

  let config: McpJson = { mcpServers: {} };

  if (existsSync(mcpJsonPath)) {
    try {
      const raw = readFileSync(mcpJsonPath, "utf-8");
      config = JSON.parse(raw) as McpJson;
    } catch {
      console.warn(`  Warning: could not parse ${mcpJsonPath}, skipping .mcp.json update`);
      return;
    }

    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    if (config.mcpServers.knowledge) {
      console.log(`  Skipped: .mcp.json already has a "knowledge" server entry`);
      return;
    }
  }

  config.mcpServers!.knowledge = entry;
  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  Created/updated: .mcp.json (MCP server registered)`);
}

export function initKnowledgeDir(knowledgeDir: string, projectRoot: string): void {
  const configPath = join(knowledgeDir, "knowledge.config.yaml");
  const knowledgeDirRelative = relative(projectRoot, knowledgeDir) || ".";

  if (existsSync(configPath)) {
    console.log(`Already initialized: ${configPath} exists.`);
    updateMcpJson(projectRoot, knowledgeDirRelative);
    return;
  }

  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEMPLATE);
  writeFileSync(join(knowledgeDir, "_summary.md"), ROOT_SUMMARY_TEMPLATE);

  console.log(`Initialized knowledge directory at ${knowledgeDir}`);
  console.log("  Created: knowledge.config.yaml");
  console.log("  Created: _summary.md (root node)");

  updateMcpJson(projectRoot, knowledgeDirRelative);

  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit knowledge.config.yaml to configure domains and phases");
  console.log("  2. Create domain directories (e.g., mkdir knowledge/technology)");
  console.log("  3. Add documents with YAML frontmatter (see README for format)");
}
