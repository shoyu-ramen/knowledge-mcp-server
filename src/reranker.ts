import type { KnowledgeDocument } from "./loader.js";
import { tokenize } from "./text.js";
import { SIX_MONTHS_MS } from "./constants.js";
import { cosineSimilarity, type EmbeddingsStore } from "./embeddings.js";

interface ScoredDoc {
  doc: KnowledgeDocument;
  score: number;
}

export function rerank(
  docs: ScoredDoc[],
  query: string,
  queryType: "broad" | "specific" | "decision" | "procedural" | "troubleshooting"
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

      // Log-decay staleness penalty: smooth curve instead of binary threshold
      if (doc.lastUpdated) {
        const docDate = new Date(doc.lastUpdated).getTime();
        if (!isNaN(docDate)) {
          const ageMs = now - docDate;
          if (ageMs > SIX_MONTHS_MS) {
            const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
            adjusted -= 0.1 * Math.log2(1 + ageMonths / 6);
          }
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

/**
 * Maximal Marginal Relevance (MMR) diversification.
 * Reorders results to reduce near-duplicate content by penalizing
 * documents that are too similar to already-selected ones.
 *
 * @param docs - Scored documents (already sorted by score)
 * @param embeddings - Embedding store for similarity computation
 * @param lambda - Trade-off: 1.0 = pure relevance, 0.0 = pure diversity (default 0.7)
 * @param k - Number of results to return
 */
export function mmrDiversify(
  docs: ScoredDoc[],
  embeddings: EmbeddingsStore,
  lambda: number = 0.7,
  k: number
): ScoredDoc[] {
  if (docs.length <= 1 || !embeddings.available) return docs.slice(0, k);

  const selected: ScoredDoc[] = [];
  const remaining = [...docs];

  // Normalize scores to [0, 1] for fair comparison with similarity
  const maxScore = Math.max(...remaining.map((d) => d.score), 1e-10);

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score / maxScore;

      // Compute max similarity to any already-selected document
      let maxSim = 0;
      const candidateVec = embeddings.vectors.get(candidate.doc.id);
      if (candidateVec && selected.length > 0) {
        for (const sel of selected) {
          const selVec = embeddings.vectors.get(sel.doc.id);
          if (selVec) {
            const sim = cosineSimilarity(candidateVec, selVec);
            if (sim > maxSim) maxSim = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
