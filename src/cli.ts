#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createKnowledgeServer } from "./index.js";
import { KnowledgeEngine } from "./engine.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatValidationReport } from "./validator.js";
import { formatStats } from "./analytics.js";
import { generateEmbeddings } from "./generate-embeddings.js";
import { initKnowledgeDir } from "./init.js";
import { exportMermaid, exportDot } from "./graph-export.js";
import { loadAnalytics, formatAnalytics } from "./search-analytics.js";
import { log } from "./logger.js";
import { VERSION } from "./constants.js";

const COMMANDS = [
  "serve",
  "embeddings",
  "init",
  "validate",
  "stats",
  "list",
  "search",
  "export",
  "analytics",
] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  knowledgeDir: string;
  domain?: string;
  type?: string;
  phase?: number;
  tags?: string[];
  json?: boolean;
  query?: string;
  format?: string;
  rootId?: string;
}

function printUsage(): void {
  console.log(`knowledge-mcp-server v${VERSION}

Usage: knowledge-mcp-server [command] [options]

Commands:
  serve       Start the MCP server over stdio (default)
  embeddings  Generate embeddings for all documents
  init        Scaffold a new knowledge/ directory with config template
  validate    Run graph integrity checks and report issues
  stats       Show knowledge graph statistics
  list        List documents with metadata
  search      Search the knowledge graph
  export      Export graph as Mermaid or DOT
  analytics   Show search analytics summary

Options:
  --knowledge-dir <path>  Path to knowledge directory (default: ./knowledge)
  --domain <name>         Filter by domain (list, search)
  --type <type>           Filter by type (list, search)
  --phase <n>             Filter by phase (list)
  --tags <t1,t2>          Filter by tags, comma-separated (list)
  --json                  Output as JSON (list, validate, stats, search)
  --format <fmt>          Export format: "mermaid" or "dot" (export)
  --root <id>             Root node for export (default: entire graph)
  --help, -h              Show this help message
  --version               Show version number`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: Command = "serve";
  let knowledgeDir = resolve(process.cwd(), "knowledge");

  // First non-flag argument is the command
  if (args[0] && !args[0].startsWith("-") && (COMMANDS as readonly string[]).includes(args[0])) {
    command = args.shift()! as Command;
  }

  let domain: string | undefined;
  let type: string | undefined;
  let phase: number | undefined;
  let tags: string[] | undefined;
  let json = false;
  let query: string | undefined;
  let format: string | undefined;
  let rootId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--knowledge-dir" && args[i + 1]) {
      knowledgeDir = resolve(args[++i]);
    } else if (args[i] === "--domain" && args[i + 1]) {
      domain = args[++i];
    } else if (args[i] === "--type" && args[i + 1]) {
      type = args[++i];
    } else if (args[i] === "--phase" && args[i + 1]) {
      phase = parseInt(args[++i], 10);
    } else if (args[i] === "--tags" && args[i + 1]) {
      tags = args[++i].split(",").map((t) => t.trim());
    } else if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    } else if (args[i] === "--root" && args[i + 1]) {
      rootId = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (args[i] === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (!args[i].startsWith("-") && command === "search" && !query) {
      query = args[i];
    }
  }

  return { command, knowledgeDir, domain, type, phase, tags, json, query, format, rootId };
}

function requireDir(knowledgeDir: string): void {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }
}

async function serve(knowledgeDir: string): Promise<void> {
  const { server } = createKnowledgeServer(knowledgeDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("server_started", { transport: "stdio" });
}

function validate(knowledgeDir: string, json: boolean): void {
  requireDir(knowledgeDir);
  const engine = new KnowledgeEngine(knowledgeDir);
  const report = engine.validate();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatValidationReport(report));
  }

  const hasIssues =
    report.orphans.length > 0 ||
    report.brokenRelated.length > 0 ||
    report.brokenChildren.length > 0 ||
    report.circularParents.length > 0;

  if (hasIssues) {
    process.exit(1);
  }
}

function stats(knowledgeDir: string, json: boolean): void {
  requireDir(knowledgeDir);
  const engine = new KnowledgeEngine(knowledgeDir);
  const result = engine.stats();

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatStats(result));
  }
}

function list(args: ParsedArgs): void {
  requireDir(args.knowledgeDir);
  const engine = new KnowledgeEngine(args.knowledgeDir);
  const result = engine.list({
    domain: args.domain,
    type: args.type,
    phase: args.phase,
    tags: args.tags,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Documents: ${result.docs.length} of ${result.totalDocs}`);
    for (const doc of result.docs) {
      console.log(
        `  ${doc.id}  [${doc.type}]  "${doc.title}"  tags: ${doc.tags.join(", ") || "(none)"}`
      );
    }
  }
}

async function search(args: ParsedArgs): Promise<void> {
  requireDir(args.knowledgeDir);
  if (!args.query) {
    console.error("Error: search requires a query argument. Usage: search <query> [--domain X]");
    process.exit(1);
  }

  const engine = new KnowledgeEngine(args.knowledgeDir);
  const result = await engine.search({
    query: args.query,
    domains: args.domain ? [args.domain] : undefined,
    type: args.type,
  });

  if (args.json) {
    // Output as JSON object with the raw XML result
    console.log(JSON.stringify({ query: args.query, result }, null, 2));
  } else {
    console.log(result);
  }
}

function graphExport(args: ParsedArgs): void {
  requireDir(args.knowledgeDir);
  const engine = new KnowledgeEngine(args.knowledgeDir);
  const fmt = args.format || "mermaid";

  if (fmt === "dot") {
    console.log(exportDot(engine.graph, args.rootId));
  } else {
    console.log(exportMermaid(engine.graph, args.rootId));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "serve":
      await serve(args.knowledgeDir);
      break;
    case "embeddings":
      await generateEmbeddings(args.knowledgeDir);
      break;
    case "init":
      initKnowledgeDir(args.knowledgeDir, process.cwd());
      break;
    case "validate":
      validate(args.knowledgeDir, args.json ?? false);
      break;
    case "stats":
      stats(args.knowledgeDir, args.json ?? false);
      break;
    case "list":
      list(args);
      break;
    case "search":
      await search(args);
      break;
    case "export":
      graphExport(args);
      break;
    case "analytics": {
      requireDir(args.knowledgeDir);
      const entries = loadAnalytics(args.knowledgeDir);
      if (args.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        console.log(formatAnalytics(entries));
      }
      break;
    }
  }
}

main().catch((err) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
