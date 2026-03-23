import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { log } from "./logger.js";
import { ID_PATTERN, VALID_TYPES } from "./constants.js";

export type DocumentStatus = "active" | "draft" | "deprecated";

export interface KnowledgeDocument {
  id: string;
  title: string;
  type: "summary" | "detail" | "decision" | "reference";
  domain: string;
  subdomain?: string;
  tags: string[];
  phase: number[];
  related: string[];
  parentId: string | null;
  childrenIds: string[];
  contentBody: string;
  filePath: string;
  wordCount: number;
  status: DocumentStatus;
  supersededBy?: string;
  lastUpdated?: string;
  decisionStatus?: "proposed" | "accepted" | "deprecated" | "superseded" | "finalized";
  alternativesConsidered?: string[];
  decisionDate?: string;
}

interface RawFrontmatter {
  id?: string;
  title?: string;
  type?: string;
  domain?: string;
  subdomain?: string;
  tags?: string[];
  phase?: number | number[];
  related?: string[];
  children?: string[];
  word_count?: number;
  status?: string;
  superseded_by?: string;
  last_updated?: string;
  decision_status?: string;
  alternatives_considered?: string[];
  decision_date?: string;
  [key: string]: unknown;
}

export function parseFrontmatter(raw: string): { frontmatter: RawFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  try {
    const frontmatter = parseYaml(match[1]) as RawFrontmatter;
    const body = match[2].trim();
    return { frontmatter, body };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

// Re-export VALID_TYPES from constants for backward compatibility
export { VALID_TYPES } from "./constants.js";

export function deriveParentId(id: string): string | null {
  if (id === "root") return null;
  const segments = id.split("/");
  if (segments.length <= 1) return "root";
  return segments.slice(0, -1).join("/");
}

export function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
    } else if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function validateFrontmatter(
  fm: RawFrontmatter,
  filePath: string,
  validDomains?: string[] | null
): string[] {
  const warnings: string[] = [];
  if (!fm.id) {
    warnings.push(`${filePath}: missing required field 'id'`);
    return warnings; // Can't validate further without ID
  }
  if (!ID_PATTERN.test(fm.id)) {
    warnings.push(`${filePath}: invalid ID format "${fm.id}"`);
  }
  if (fm.domain && validDomains && !validDomains.includes(fm.domain)) {
    warnings.push(`${filePath}: invalid domain "${fm.domain}"`);
  }
  if (fm.type && !(VALID_TYPES as readonly string[]).includes(fm.type)) {
    warnings.push(`${filePath}: invalid type "${fm.type}"`);
  }
  const phases = fm.phase ? (Array.isArray(fm.phase) ? fm.phase : [fm.phase]) : [];
  for (const p of phases) {
    if (p < 1 || !Number.isInteger(p)) {
      warnings.push(`${filePath}: invalid phase value ${p}`);
    }
  }
  if (fm.type === "decision" && !fm.decision_status) {
    warnings.push(`${filePath}: decision document missing 'decision_status' field`);
  }
  return warnings;
}

/** Load a single document from a file path. Returns null if the file has no valid id. */
export function loadSingleDocument(
  filePath: string,
  knowledgeDir: string,
  validDomains?: string[] | null
): KnowledgeDocument | null {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const validationWarnings = validateFrontmatter(frontmatter, filePath, validDomains);
  if (validationWarnings.length > 0) {
    for (const w of validationWarnings) log.warn("schema_validation", { warning: w });
  }
  if (!frontmatter.id) return null;

  const id = frontmatter.id;
  const phase = frontmatter.phase
    ? Array.isArray(frontmatter.phase)
      ? frontmatter.phase
      : [frontmatter.phase]
    : [];

  const rawStatus =
    frontmatter.status || (frontmatter.decision_status === "deprecated" ? "deprecated" : undefined);
  const status: KnowledgeDocument["status"] =
    rawStatus === "draft" ? "draft" : rawStatus === "deprecated" ? "deprecated" : "active";

  const rawDecisionStatus = frontmatter.decision_status as string | undefined;
  const validDecisionStatuses = ["proposed", "accepted", "deprecated", "superseded", "finalized"];
  const decisionStatus =
    rawDecisionStatus && validDecisionStatuses.includes(rawDecisionStatus)
      ? (rawDecisionStatus as KnowledgeDocument["decisionStatus"])
      : undefined;

  return {
    id,
    title: frontmatter.title || id,
    type: (frontmatter.type as KnowledgeDocument["type"]) || "detail",
    domain: frontmatter.domain || id.split("/")[0],
    subdomain: frontmatter.subdomain,
    tags: frontmatter.tags || [],
    phase,
    related: frontmatter.related || [],
    parentId: deriveParentId(id),
    childrenIds: frontmatter.children || [],
    contentBody: body,
    filePath: relative(join(knowledgeDir, ".."), filePath),
    wordCount: frontmatter.word_count || body.split(/\s+/).filter(Boolean).length,
    status,
    supersededBy: frontmatter.superseded_by,
    lastUpdated: frontmatter.last_updated,
    decisionStatus,
    alternativesConsidered: frontmatter.alternatives_considered,
    decisionDate: frontmatter.decision_date,
  };
}

export function loadDocuments(
  knowledgeDir: string,
  validDomains?: string[] | null,
  warningsOut?: string[]
): Map<string, KnowledgeDocument> {
  const docs = new Map<string, KnowledgeDocument>();
  const files = collectMarkdownFiles(knowledgeDir);
  const childrenFromFrontmatter = new Map<string, string[]>();

  for (const filePath of files) {
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    // Validate schema
    const validationWarnings = validateFrontmatter(frontmatter, filePath, validDomains);
    if (validationWarnings.length > 0) {
      for (const w of validationWarnings) {
        log.warn("schema_validation", { warning: w });
        warningsOut?.push(w);
      }
    }
    if (!frontmatter.id) continue;

    const id = frontmatter.id;

    // Check for duplicate IDs
    if (docs.has(id)) {
      const msg = `Duplicate document ID "${id}" in ${filePath} (existing: ${docs.get(id)!.filePath})`;
      log.warn("duplicate_id", { id, file: filePath, existingFile: docs.get(id)!.filePath });
      warningsOut?.push(msg);
    }
    const phase = frontmatter.phase
      ? Array.isArray(frontmatter.phase)
        ? frontmatter.phase
        : [frontmatter.phase]
      : [];

    if (frontmatter.children) {
      childrenFromFrontmatter.set(id, frontmatter.children);
    }

    // Parse status: support both "status" and legacy "decision_status" fields
    const rawStatus =
      frontmatter.status ||
      (frontmatter.decision_status === "deprecated" ? "deprecated" : undefined);
    const status: KnowledgeDocument["status"] =
      rawStatus === "draft" ? "draft" : rawStatus === "deprecated" ? "deprecated" : "active";

    // Parse decision_status into typed enum value
    const rawDecisionStatus = frontmatter.decision_status as string | undefined;
    const validDecisionStatuses = ["proposed", "accepted", "deprecated", "superseded", "finalized"];
    const decisionStatus =
      rawDecisionStatus && validDecisionStatuses.includes(rawDecisionStatus)
        ? (rawDecisionStatus as KnowledgeDocument["decisionStatus"])
        : undefined;

    const doc: KnowledgeDocument = {
      id,
      title: frontmatter.title || id,
      type: (frontmatter.type as KnowledgeDocument["type"]) || "detail",
      domain: frontmatter.domain || id.split("/")[0],
      subdomain: frontmatter.subdomain,
      tags: frontmatter.tags || [],
      phase,
      related: frontmatter.related || [],
      parentId: deriveParentId(id),
      childrenIds: [],
      contentBody: body,
      filePath: relative(join(knowledgeDir, ".."), filePath),
      wordCount: frontmatter.word_count || body.split(/\s+/).filter(Boolean).length,
      status,
      supersededBy: frontmatter.superseded_by,
      lastUpdated: frontmatter.last_updated,
      decisionStatus,
      alternativesConsidered: frontmatter.alternatives_considered,
      decisionDate: frontmatter.decision_date,
    };

    docs.set(id, doc);
  }

  // Populate childrenIds from frontmatter `children` fields
  for (const [parentId, children] of childrenFromFrontmatter) {
    const parent = docs.get(parentId);
    if (parent) {
      parent.childrenIds = children.filter((c) => docs.has(c));
    }
  }

  // For docs without explicit children, derive from parentId
  for (const doc of docs.values()) {
    if (doc.parentId && docs.has(doc.parentId)) {
      const parent = docs.get(doc.parentId)!;
      if (!parent.childrenIds.includes(doc.id)) {
        parent.childrenIds.push(doc.id);
      }
    }
  }

  return docs;
}

/**
 * Async version of loadDocuments — reads files concurrently to unblock the event loop.
 * Useful for large knowledge bases (500+ docs).
 */
export async function loadDocumentsAsync(
  knowledgeDir: string,
  validDomains?: string[] | null,
  warningsOut?: string[],
  concurrency: number = 50
): Promise<Map<string, KnowledgeDocument>> {
  const docs = new Map<string, KnowledgeDocument>();
  const files = collectMarkdownFiles(knowledgeDir);
  const childrenFromFrontmatter = new Map<string, string[]>();

  // Process files in batches for concurrency control
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        const raw = await readFile(filePath, "utf-8");
        return { filePath, raw };
      })
    );

    for (const { filePath, raw } of results) {
      const { frontmatter, body } = parseFrontmatter(raw);

      const validationWarnings = validateFrontmatter(frontmatter, filePath, validDomains);
      if (validationWarnings.length > 0) {
        for (const w of validationWarnings) {
          log.warn("schema_validation", { warning: w });
          warningsOut?.push(w);
        }
      }
      if (!frontmatter.id) continue;

      const id = frontmatter.id;
      if (docs.has(id)) {
        const msg = `Duplicate document ID "${id}" in ${filePath} (existing: ${docs.get(id)!.filePath})`;
        log.warn("duplicate_id", { id, file: filePath, existingFile: docs.get(id)!.filePath });
        warningsOut?.push(msg);
      }

      const phase = frontmatter.phase
        ? Array.isArray(frontmatter.phase)
          ? frontmatter.phase
          : [frontmatter.phase]
        : [];

      if (frontmatter.children) {
        childrenFromFrontmatter.set(id, frontmatter.children);
      }

      const rawStatus =
        frontmatter.status ||
        (frontmatter.decision_status === "deprecated" ? "deprecated" : undefined);
      const status: KnowledgeDocument["status"] =
        rawStatus === "draft" ? "draft" : rawStatus === "deprecated" ? "deprecated" : "active";

      const rawDecisionStatus = frontmatter.decision_status as string | undefined;
      const validDecisionStatuses = [
        "proposed",
        "accepted",
        "deprecated",
        "superseded",
        "finalized",
      ];
      const decisionStatus =
        rawDecisionStatus && validDecisionStatuses.includes(rawDecisionStatus)
          ? (rawDecisionStatus as KnowledgeDocument["decisionStatus"])
          : undefined;

      docs.set(id, {
        id,
        title: frontmatter.title || id,
        type: (frontmatter.type as KnowledgeDocument["type"]) || "detail",
        domain: frontmatter.domain || id.split("/")[0],
        subdomain: frontmatter.subdomain,
        tags: frontmatter.tags || [],
        phase,
        related: frontmatter.related || [],
        parentId: deriveParentId(id),
        childrenIds: [],
        contentBody: body,
        filePath: relative(join(knowledgeDir, ".."), filePath),
        wordCount: frontmatter.word_count || body.split(/\s+/).filter(Boolean).length,
        status,
        supersededBy: frontmatter.superseded_by,
        lastUpdated: frontmatter.last_updated,
        decisionStatus,
        alternativesConsidered: frontmatter.alternatives_considered,
        decisionDate: frontmatter.decision_date,
      });
    }
  }

  // Populate childrenIds from frontmatter `children` fields
  for (const [parentId, children] of childrenFromFrontmatter) {
    const parent = docs.get(parentId);
    if (parent) {
      parent.childrenIds = children.filter((c) => docs.has(c));
    }
  }

  // For docs without explicit children, derive from parentId
  for (const doc of docs.values()) {
    if (doc.parentId && docs.has(doc.parentId)) {
      const parent = docs.get(doc.parentId)!;
      if (!parent.childrenIds.includes(doc.id)) {
        parent.childrenIds.push(doc.id);
      }
    }
  }

  return docs;
}
