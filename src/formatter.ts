import type { KnowledgeDocument } from "./loader.js";

export type DetailLevel = "summary" | "normal" | "full";

interface FormattedDoc {
  doc: KnowledgeDocument;
  relevance: "primary" | "ancestor" | "graph-expanded";
  similarity?: number;
  matchedOn?: string;
  scoringMethod?: string;
  expandedFrom?: string;
}

// Word budgets per relevance tier and detail level
const WORD_BUDGETS: Record<DetailLevel, Record<FormattedDoc["relevance"], number>> = {
  summary: { ancestor: 40, "graph-expanded": 150, primary: 500 },
  normal: { ancestor: 80, "graph-expanded": 300, primary: 1500 },
  full: { ancestor: Infinity, "graph-expanded": Infinity, primary: Infinity },
};

interface Section {
  heading: string; // e.g., "## Alternatives" or "" for preamble
  body: string;
  wordCount: number;
}

function parseSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      // Flush previous section
      const body = currentLines.join("\n").trim();
      if (body || sections.length > 0) {
        sections.push({
          heading: currentHeading,
          body,
          wordCount: body.split(/\s+/).filter(Boolean).length,
        });
      }
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const body = currentLines.join("\n").trim();
  sections.push({
    heading: currentHeading,
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  });

  return sections;
}

function truncateContent(content: string, wordBudget: number): string {
  if (!Number.isFinite(wordBudget)) return content;

  const sections = parseSections(content);

  // No headings found — fall back to paragraph-based truncation
  const hasHeadings = sections.some((s) => s.heading !== "");
  if (!hasHeadings) {
    return truncateByParagraphs(content, wordBudget);
  }

  const kept: Section[] = [];
  let wordCount = 0;

  for (const section of sections) {
    const sectionWords =
      section.wordCount + (section.heading ? section.heading.split(/\s+/).length : 0);
    if (wordCount + sectionWords > wordBudget && kept.length > 0) {
      break;
    }
    kept.push(section);
    wordCount += sectionWords;
  }

  // Build output from kept sections
  const parts: string[] = [];
  for (const section of kept) {
    if (section.heading) parts.push(section.heading);
    if (section.body) parts.push(section.body);
  }

  // Summarize omitted sections
  const omitted = sections.slice(kept.length);
  if (omitted.length > 0) {
    const omittedSummary = omitted
      .filter((s) => s.heading)
      .map((s) => `${s.heading.replace(/^#+\s+/, "")} (${s.wordCount} words)`)
      .join(", ");
    if (omittedSummary) {
      parts.push(`\n[Sections omitted: ${omittedSummary}]`);
    } else {
      const remaining = omitted.reduce((sum, s) => sum + s.wordCount, 0);
      if (remaining > 0) parts.push(`\n[... ${remaining} more words]`);
    }
  }

  return parts.join("\n");
}

function truncateByParagraphs(content: string, wordBudget: number): string {
  const paragraphs = content.split(/\n\n/);
  const kept: string[] = [];
  let wordCount = 0;

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (wordCount + words.length > wordBudget && kept.length > 0) {
      const totalWords = content.split(/\s+/).filter(Boolean).length;
      const remaining = totalWords - wordCount;
      if (remaining > 0) {
        kept.push(`[... ${remaining} more words]`);
      }
      break;
    }
    kept.push(paragraph);
    wordCount += words.length;
  }

  return kept.join("\n\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSingleDoc(entry: FormattedDoc, detailLevel: DetailLevel): string {
  const { doc, relevance, similarity, matchedOn, scoringMethod, expandedFrom } = entry;
  const attrs = [`id="${escapeXml(doc.id)}"`, `type="${doc.type}"`, `relevance="${relevance}"`];
  if (doc.status !== "active") {
    attrs.push(`status="${doc.status}"`);
  }
  if (doc.supersededBy) {
    attrs.push(`superseded_by="${escapeXml(doc.supersededBy)}"`);
  }
  if (similarity !== undefined) {
    attrs.push(`similarity="${similarity.toFixed(2)}"`);
  }
  if (matchedOn) {
    attrs.push(`matched_on="${escapeXml(matchedOn)}"`);
  }
  if (scoringMethod) {
    attrs.push(`scoring_method="${escapeXml(scoringMethod)}"`);
  }
  if (expandedFrom) {
    attrs.push(`expanded_from="${escapeXml(expandedFrom)}"`);
  }
  attrs.push(`path="${escapeXml(doc.filePath)}"`);

  const parts = [`  <document ${attrs.join(" ")}>`];
  parts.push(`    <title>${escapeXml(doc.title)}</title>`);

  if (doc.tags.length > 0) {
    parts.push(`    <tags>${escapeXml(doc.tags.join(", "))}</tags>`);
  }
  if (doc.related.length > 0) {
    parts.push(`    <related>${escapeXml(doc.related.join(", "))}</related>`);
  }

  if (doc.type === "decision") {
    const meta: string[] = [];
    if (doc.decisionStatus) meta.push(`status="${escapeXml(doc.decisionStatus)}"`);
    if (doc.decisionDate) meta.push(`date="${escapeXml(doc.decisionDate)}"`);
    if (meta.length > 0) {
      parts.push(`    <decision_meta ${meta.join(" ")}>`);
      if (doc.alternativesConsidered && doc.alternativesConsidered.length > 0) {
        parts.push(
          `      <alternatives>${escapeXml(doc.alternativesConsidered.join(", "))}</alternatives>`
        );
      }
      parts.push(`    </decision_meta>`);
    }
  }

  const budget = WORD_BUDGETS[detailLevel][relevance];
  const content = truncateContent(doc.contentBody, budget);
  parts.push(`    <content>\n${content}\n    </content>`);
  parts.push(`  </document>`);

  return parts.join("\n");
}

export interface FacetCounts {
  domains: Map<string, number>;
  types: Map<string, number>;
  phases: Map<string, number>;
}

function formatFacets(facets: FacetCounts): string {
  const parts: string[] = [`  <facets>`];
  for (const [name, count] of [...facets.domains].sort((a, b) => b[1] - a[1])) {
    parts.push(`    <domain name="${escapeXml(name)}" count="${count}"/>`);
  }
  for (const [name, count] of [...facets.types].sort((a, b) => b[1] - a[1])) {
    parts.push(`    <type name="${escapeXml(name)}" count="${count}"/>`);
  }
  for (const [name, count] of [...facets.phases].sort((a, b) => b[1] - a[1])) {
    parts.push(`    <phase name="${escapeXml(name)}" count="${count}"/>`);
  }
  parts.push(`  </facets>`);
  return parts.join("\n");
}

export function formatSearchResults(
  query: string,
  results: FormattedDoc[],
  detailLevel: DetailLevel = "normal",
  searchMethod?: string,
  facets?: FacetCounts
): string {
  const methodAttr = searchMethod ? ` search_method="${escapeXml(searchMethod)}"` : "";
  const parts = [
    `<knowledge_context query="${escapeXml(query)}" total_docs="${results.length}"${methodAttr}>`,
  ];

  // Order: ancestors first, then primaries by similarity, then expanded
  const ancestors = results.filter((r) => r.relevance === "ancestor");
  const primaries = results.filter((r) => r.relevance === "primary");
  const expanded = results.filter((r) => r.relevance === "graph-expanded");

  for (const entry of [...ancestors, ...primaries, ...expanded]) {
    parts.push(formatSingleDoc(entry, detailLevel));
  }

  if (facets) {
    parts.push(formatFacets(facets));
  }

  parts.push(`</knowledge_context>`);
  return parts.join("\n");
}

export function formatLookupResult(
  doc: KnowledgeDocument,
  ancestors: KnowledgeDocument[],
  related: KnowledgeDocument[],
  contentLevel: "full" | "summary" = "full"
): string {
  const detailLevel: DetailLevel = contentLevel === "summary" ? "normal" : "full";
  const parts = [`<knowledge_context total_docs="${1 + ancestors.length + related.length}">`];

  for (const a of ancestors) {
    parts.push(formatSingleDoc({ doc: a, relevance: "ancestor" }, detailLevel));
  }

  parts.push(formatSingleDoc({ doc, relevance: "primary" }, detailLevel));

  for (const r of related) {
    parts.push(formatSingleDoc({ doc: r, relevance: "graph-expanded" }, detailLevel));
  }

  parts.push(`</knowledge_context>`);
  return parts.join("\n");
}

export function formatGraphResult(
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    domain: string;
    wordCount: number;
    childrenCount: number;
  }>,
  edges: Array<{
    source: string;
    target: string;
    type: "child" | "related";
  }>,
  totalDocs: number,
  rootId: string
): string {
  const parts: string[] = [];

  parts.push(
    `<knowledge_graph root="${escapeXml(rootId)}" total_docs="${totalDocs}" nodes_shown="${nodes.length}">`
  );

  for (const node of nodes) {
    parts.push(
      `  <node id="${escapeXml(node.id)}" type="${escapeXml(node.type)}" domain="${escapeXml(node.domain)}" word_count="${node.wordCount}" children_count="${node.childrenCount}">`
    );
    parts.push(`    <title>${escapeXml(node.title)}</title>`);
    parts.push(`  </node>`);
  }

  parts.push(`  <edges>`);
  for (const edge of edges) {
    parts.push(
      `    <edge source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}" type="${escapeXml(edge.type)}"/>`
    );
  }
  parts.push(`  </edges>`);

  parts.push(`</knowledge_graph>`);
  return parts.join("\n");
}

export function formatWriteResult(result: {
  id: string;
  filePath: string;
  parentId: string | null;
  status: "created" | "updated";
  warnings?: string[];
}): string {
  const lines = [
    `Document ${result.status}: "${result.id}"`,
    `  File: ${result.filePath}`,
    `  Parent: ${result.parentId ?? "(root)"}`,
    ``,
    `BM25 search index updated — document is immediately searchable.`,
    `Note: Embedding vectors update automatically when VOYAGE_API_KEY is set.`,
  ];
  if (result.warnings && result.warnings.length > 0) {
    lines.push(``);
    lines.push(`Warnings:`);
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}

export function formatDeleteResult(result: { id: string; warnings: string[] }): string {
  const lines = [`Document deleted: "${result.id}"`, ``, `BM25 search index updated.`];
  if (result.warnings.length > 0) {
    lines.push(``);
    lines.push(`Warnings:`);
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}

export function formatListResult(
  docs: Array<{
    id: string;
    title: string;
    type: string;
    domain: string;
    tags: string[];
    wordCount: number;
    status: string;
    lastUpdated?: string;
  }>,
  totalDocs: number
): string {
  const parts = [`<knowledge_list total="${docs.length}" of="${totalDocs}">`];
  for (const doc of docs) {
    const attrs = [
      `id="${escapeXml(doc.id)}"`,
      `type="${doc.type}"`,
      `domain="${escapeXml(doc.domain)}"`,
      `words="${doc.wordCount}"`,
    ];
    if (doc.status !== "active") attrs.push(`status="${doc.status}"`);
    if (doc.lastUpdated) attrs.push(`updated="${doc.lastUpdated}"`);
    parts.push(`  <doc ${attrs.join(" ")}>`);
    parts.push(`    <title>${escapeXml(doc.title)}</title>`);
    if (doc.tags.length > 0) {
      parts.push(`    <tags>${escapeXml(doc.tags.join(", "))}</tags>`);
    }
    parts.push(`  </doc>`);
  }
  parts.push(`</knowledge_list>`);
  return parts.join("\n");
}

export type { FormattedDoc };
