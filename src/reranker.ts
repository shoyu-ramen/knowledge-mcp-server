import type { KnowledgeDocument } from "./loader.js";
import { tokenize } from "./embeddings.js";

interface ScoredDoc {
  doc: KnowledgeDocument;
  score: number;
}

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

export function rerank(
  docs: ScoredDoc[],
  query: string,
  queryType: "broad" | "specific" | "decision"
): ScoredDoc[] {
  if (docs.length === 0) return docs;

  const queryLower = query.toLowerCase().trim();
  const queryTokens = tokenize(query);
  const queryTokenSet = new Set(queryTokens);
  const now = Date.now();

  return docs
    .map(({ doc, score }) => {
      let adjusted = score;

      // Title match bonus: use max of precision (overlap/titleLength) and recall (overlap/queryLength)
      const titleTokens = tokenize(doc.title);
      const titleOverlap = titleTokens.filter((t) => queryTokenSet.has(t)).length;
      if (titleOverlap > 0) {
        const titlePrecision = titleOverlap / Math.max(titleTokens.length, 1);
        const titleRecall = titleOverlap / Math.max(queryTokenSet.size, 1);
        adjusted += 0.15 * Math.max(titlePrecision, titleRecall);
      }

      // Decision-type boost when query is decision-oriented
      if (queryType === "decision" && doc.type === "decision") {
        adjusted += 0.1;
      }

      // Staleness penalty: docs older than 6 months get a small penalty
      if (doc.lastUpdated) {
        const docDate = new Date(doc.lastUpdated).getTime();
        if (!isNaN(docDate) && now - docDate > SIX_MONTHS_MS) {
          adjusted -= 0.05;
        }
      }

      // Exact phrase bonus: query substring appears in content body
      if (queryLower.length > 3 && doc.contentBody.toLowerCase().includes(queryLower)) {
        adjusted += 0.1;
      }

      return { doc, score: adjusted };
    })
    .sort((a, b) => b.score - a.score);
}
