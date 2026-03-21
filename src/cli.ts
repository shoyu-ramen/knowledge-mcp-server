#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createKnowledgeServer } from "./index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildGraph } from "./graph.js";
import { validateGraph, formatValidationReport } from "./validator.js";
import { loadConfig, getEffectiveDomains } from "./config.js";
import { generateEmbeddings } from "./generate-embeddings.js";
import { initKnowledgeDir } from "./init.js";
import { log } from "./logger.js";

const VERSION = "1.0.0";

const COMMANDS = ["serve", "embeddings", "init", "validate"] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  knowledgeDir: string;
}

function printUsage(): void {
  console.log(`knowledge-mcp-server v${VERSION}

Usage: knowledge-mcp-server [command] [options]

Commands:
  serve       Start the MCP server over stdio (default)
  embeddings  Generate embeddings for all documents via Voyage AI
  init        Scaffold a new knowledge/ directory with config template
  validate    Run graph integrity checks and report issues

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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--knowledge-dir" && args[i + 1]) {
      knowledgeDir = resolve(args[++i]);
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (args[i] === "--version") {
      console.log(VERSION);
      process.exit(0);
    }
  }

  return { command, knowledgeDir };
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

  const config = loadConfig(knowledgeDir);
  const validDomains = getEffectiveDomains(config, knowledgeDir);
  const graph = buildGraph(knowledgeDir, validDomains);
  const report = validateGraph(graph);
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

async function main(): Promise<void> {
  const { command, knowledgeDir } = parseArgs(process.argv);

  switch (command) {
    case "serve":
      await serve(knowledgeDir);
      break;
    case "embeddings":
      await generateEmbeddings(knowledgeDir);
      break;
    case "init":
      initKnowledgeDir(knowledgeDir);
      break;
    case "validate":
      validate(knowledgeDir);
      break;
  }
}

main().catch((err) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
