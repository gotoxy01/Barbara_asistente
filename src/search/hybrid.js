/**
 * Mezcla la búsqueda por palabras con la similitud del embedding.
 * Las dos notas van de 0 a 1. El peso se configura con HYBRID_KEYWORD_WEIGHT y HYBRID_VECTOR_WEIGHT.
 */

function normalizeKeyword(hits) {
  const max = Math.max(0, ...hits.map((hit) => Number(hit.keyword) || 0));
  return hits.map((hit) => ({
    sku: hit.sku,
    keyword: max > 0 ? (Number(hit.keyword) || 0) / max : 0,
  }));
}

/**
 * @param {{ sku: string, keyword: number }[]} keywordHits
 * @param {{ sku: string, vector: number }[]} vectorHits
 * @param {{ keywordWeight?: number, vectorWeight?: number }} [weights]
 * @returns {{ sku: string, score: number, keyword: number, vector: number }[]}
 */
export function rankHybrid(keywordHits, vectorHits, weights = {}) {
  const keywordWeight = Number(weights.keywordWeight ?? 0.55);
  const vectorWeight = Number(weights.vectorWeight ?? 0.45);
  const bySku = new Map();

  for (const hit of normalizeKeyword(keywordHits || [])) {
    if (!hit.sku) continue;
    bySku.set(hit.sku, { sku: hit.sku, keyword: hit.keyword, vector: 0 });
  }
  for (const hit of vectorHits || []) {
    if (!hit.sku) continue;
    const prev = bySku.get(hit.sku) || { sku: hit.sku, keyword: 0, vector: 0 };
    prev.vector = Math.max(0, Math.min(1, Number(hit.vector) || 0));
    bySku.set(hit.sku, prev);
  }

  return [...bySku.values()]
    .map((row) => ({
      ...row,
      score: row.keyword * keywordWeight + row.vector * vectorWeight,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
}
