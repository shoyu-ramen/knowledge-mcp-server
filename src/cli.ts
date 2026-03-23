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
import { log } from "./logger.js";

const VERSION = "1.3.0";

const COMMANDS = ["serve", "embeddings", "init", "validate", "stats", "list"] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  knowledgeDir: string;
  domain?: string;
  type?: string;
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
  list        List documents with metadata (supports --domain, --type filters)

Options:
  --knowledge-dir <path>  Path to knowledge directory (default: ./knowledge)
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--knowledge-dir" && args[i + 1]) {
      knowledgeDir = resolve(args[++i]);
    } else if (args[i] === "--domain" && args[i + 1]) {
      domain = args[++i];
    } else if (args[i] === "--type" && args[i + 1]) {
      type = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (args[i] === "--version") {
      console.log(VERSION);
      process.exit(0);
    }
  }

  return { command, knowledgeDir, domain, type };
}

async function serve(knowledgeDir: string): Promise<void> {
  const { server } = createKnowledgeServer(knowledgeDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("server_started", { transport: "stdio" });
}

function validate(knowledgeDir: string): void {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  const engine = new KnowledgeEngine(knowledgeDir);
  const report = engine.validate();
  console.log(formatValidationReport(report));

  const hasIssues =
    report.orphans.length > 0 ||
    report.brokenRelated.length > 0 ||
    report.brokenChildren.length > 0 ||
    report.circularParents.length > 0;

  if (hasIssues) {
    process.exit(1);
  }
}

function stats(knowledgeDir: string): void {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  const engine = new KnowledgeEngine(knowledgeDir);
  console.log(formatStats(engine.stats()));
}

function list(knowledgeDir: string, domain?: string, type?: string): void {
  if (!existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  const engine = new KnowledgeEngine(knowledgeDir);
  const result = engine.list({ domain, type });

  console.log(`Documents: ${result.docs.length} of ${result.totalDocs}`);
  for (const doc of result.docs) {
    console.log(
      `  ${doc.id}  [${doc.type}]  "${doc.title}"  tags: ${doc.tags.join(", ") || "(none)"}`
    );
  }
}

async function main(): Promise<void> {
  const { command, knowledgeDir, domain, type } = parseArgs(process.argv);

  switch (command) {
    case "serve":
      await serve(knowledgeDir);
      break;
    case "embeddings":
      await generateEmbeddings(knowledgeDir);
      break;
    case "init":
      initKnowledgeDir(knowledgeDir, process.cwd());
      break;
    case "validate":
      validate(knowledgeDir);
      break;
    case "stats":
      stats(knowledgeDir);
      break;
    case "list":
      list(knowledgeDir, domain, type);
      break;
  }
}

main().catch((err) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
