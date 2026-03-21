import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

export function initKnowledgeDir(knowledgeDir: string): void {
  const configPath = join(knowledgeDir, "knowledge.config.yaml");

  if (existsSync(configPath)) {
    console.log(`Already initialized: ${configPath} exists.`);
    return;
  }

  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEMPLATE);
  writeFileSync(join(knowledgeDir, "_summary.md"), ROOT_SUMMARY_TEMPLATE);

  console.log(`Initialized knowledge directory at ${knowledgeDir}`);
  console.log("  Created: knowledge.config.yaml");
  console.log("  Created: _summary.md (root node)");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit knowledge.config.yaml to configure domains and phases");
  console.log("  2. Create domain directories (e.g., mkdir knowledge/technology)");
  console.log("  3. Add documents with YAML frontmatter (see README for format)");
}
