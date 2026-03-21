import { describe, it, expect } from "vitest";
import { formatGraphResult, formatSearchResults, formatLookupResult } from "../src/formatter.js";
import { makeDoc } from "./helpers.js";

describe("truncateContent (via formatSearchResults)", () => {
  function getContent(body: string, budget: "summary" | "normal" | "full"): string {
    const doc = makeDoc({ contentBody: body });
    return formatSearchResults(
      "test",
      [{ doc, relevance: "primary" }],
      budget
    );
  }

  it("keeps complete sections within budget", () => {
    const body = `# Section 1\n\nShort content.\n\n# Section 2\n\nMore short content.`;
    const result = getContent(body, "normal");
    expect(result).toContain("Section 1");
    expect(result).toContain("Short content.");
  });

  it("lists omitted sections with word counts", () => {
    // Create content with many sections that will exceed summary budget (500 words)
    const sections = Array.from({ length: 10 }, (_, i) =>
      `## Section ${i + 1}\n\n${"word ".repeat(100).trim()}`
    ).join("\n\n");
    const result = getContent(sections, "summary");
    expect(result).toContain("[Sections omitted:");
    expect(result).toMatch(/\d+ words/);
  });

  it("falls back to paragraph splitting when no headings", () => {
    const body = "First paragraph with some words.\n\nSecond paragraph with more words.\n\n" +
      "word ".repeat(600).trim();
    const result = getContent(body, "summary");
    expect(result).toContain("First paragraph");
  });

  it("returns full content when budget is infinite", () => {
    const body = "# Heading\n\nContent here.\n\n# Another\n\nMore content.";
    const result = getContent(body, "full");
    expect(result).toContain("Heading");
    expect(result).toContain("Another");
    expect(result).toContain("More content.");
    expect(result).not.toContain("[Sections omitted:");
  });
});

describe("XML escaping", () => {
  it("escapes special characters in document attributes", () => {
    const doc = makeDoc({ title: 'Test & "Quotes" <angle>' });
    const result = formatLookupResult(doc, [], []);
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;");
    expect(result).toContain("&lt;");
  });
});

describe("formatGraphResult", () => {
  it("produces valid XML with word_count and children_count", () => {
    const nodes = [
      { id: "tech", title: "Technology", type: "summary", domain: "technology", wordCount: 350, childrenCount: 3 },
      { id: "tech/audio", title: "Audio", type: "detail", domain: "technology", wordCount: 890, childrenCount: 0 },
    ];
    const edges = [
      { source: "tech", target: "tech/audio", type: "child" as const },
    ];

    const result = formatGraphResult(nodes, edges, 42, "tech");
    expect(result).toContain('<knowledge_graph root="tech"');
    expect(result).toContain('total_docs="42"');
    expect(result).toContain('nodes_shown="2"');
    expect(result).toContain('word_count="350"');
    expect(result).toContain('children_count="3"');
    expect(result).toContain('<title>Technology</title>');
    expect(result).toContain('<edge source="tech" target="tech/audio" type="child"/>');
  });
});

describe("decision metadata", () => {
  it("renders decision_meta for decision-type docs", () => {
    const doc = makeDoc({
      type: "decision",
      decisionStatus: "accepted",
      decisionDate: "2026-03-15",
      alternativesConsidered: ["YIN", "SPICE"],
    });
    const result = formatLookupResult(doc, [], []);
    expect(result).toContain('<decision_meta status="accepted" date="2026-03-15">');
    expect(result).toContain("<alternatives>YIN, SPICE</alternatives>");
  });

  it("does not render decision_meta for non-decision docs", () => {
    const doc = makeDoc({ type: "detail" });
    const result = formatLookupResult(doc, [], []);
    expect(result).not.toContain("decision_meta");
  });
});
