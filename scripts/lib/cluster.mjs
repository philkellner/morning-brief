// Groups headlines from different outlets that describe the same event.
//
// Approach: TF-IDF vectors over headline tokens, with proper-noun matches weighted
// up, compared by cosine similarity and grouped greedily. Rare terms ("Sudan",
// "ceasefire") dominate the score; common newsroom vocabulary ("says", "report")
// is near-worthless after IDF, which is exactly what we want.

import { tokenize, entities } from './text.mjs';

const ENTITY_BOOST = 1.7;
// Description tokens are noisier than headline tokens but rescue stories whose
// headlines share no vocabulary ("Fed holds rates" / "Central bank stands pat").
const DESCRIPTION_WEIGHT = 0.45;

/** Build the token->weight map for one item before IDF is applied. */
function termFrequencies(item) {
  const tf = new Map();
  const bump = (term, amount) => tf.set(term, (tf.get(term) ?? 0) + amount);
  for (const t of tokenize(item.title)) bump(t, 1);
  for (const e of entities(item.title)) bump(`@${e}`, ENTITY_BOOST);
  const description = item.description ?? '';
  for (const t of tokenize(description).slice(0, 40)) bump(t, DESCRIPTION_WEIGHT);
  // Headlines abbreviate ("Fed") where the body spells it out ("Federal Reserve"),
  // so body proper nouns are what link those two reports of the same event.
  for (const e of entities(description).slice(0, 20)) bump(`@${e}`, DESCRIPTION_WEIGHT * ENTITY_BOOST);
  return tf;
}

function idfWeights(allTf) {
  const df = new Map();
  for (const tf of allTf) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const n = allTf.length;
  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 0.5)));
  return idf;
}

function toVector(tf, idf) {
  const vec = new Map();
  let norm = 0;
  for (const [term, freq] of tf) {
    const w = freq * (idf.get(term) ?? 0);
    if (w <= 0) continue;
    vec.set(term, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [term, w] of vec) vec.set(term, w / norm);
  return vec;
}

function cosine(a, b) {
  // Iterate the smaller map; the vectors are sparse.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other) dot += w * other;
  }
  return dot;
}

/**
 * Does the overlap between two vectors rest on anything *distinctive*?
 *
 * Two reports of one event share rare, topic-bearing terms ("steel"+"tariff",
 * "Hokkaido"). Two unrelated reports share only common newsroom vocabulary,
 * which IDF has already flattened to near-zero weight. So we look for a single
 * shared term carrying real weight in both vectors, rather than insisting on a
 * shared proper noun - abbreviations and differing attributions mean plenty of
 * genuine matches share no capitalised token at all.
 */
function hasDistinctiveOverlap(a, b, floor) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other && w * other >= floor) return true;
  }
  return false;
}

function mergeInto(centroid, vec, weight) {
  for (const [term, w] of vec) centroid.set(term, (centroid.get(term) ?? 0) + w * weight);
  let norm = 0;
  for (const w of centroid.values()) norm += w * w;
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [term, w] of centroid) centroid.set(term, w / norm);
}

/**
 * @param {Array} items  normalised feed items
 * @param {object} opts  { threshold, strictThreshold }
 * @returns {Array<{items: Array}>} clusters, largest first
 */
export function clusterItems(items, opts = {}) {
  const threshold = opts.threshold ?? 0.20;
  // With nothing distinctive in common we demand a markedly stronger match,
  // otherwise two unrelated stories about "police" and "investigation" fuse.
  const strictThreshold = opts.strictThreshold ?? 0.42;
  const distinctiveFloor = opts.distinctiveFloor ?? 0.04;

  if (items.length === 0) return [];

  const tfs = items.map(termFrequencies);
  const idf = idfWeights(tfs);
  const vectors = tfs.map((tf) => toVector(tf, idf));

  const clusters = [];
  for (let i = 0; i < items.length; i += 1) {
    const vec = vectors[i];
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = cosine(vec, cluster.centroid);
      if (score <= bestScore) continue;
      const distinctive = hasDistinctiveOverlap(vec, cluster.centroid, distinctiveFloor);
      const required = distinctive ? threshold : strictThreshold;
      if (score >= required) { best = cluster; bestScore = score; }
    }

    if (best) {
      best.items.push(items[i]);
      best.members.push(vec);
      mergeInto(best.centroid, vec, 1);
    } else {
      clusters.push({ centroid: new Map(vec), items: [items[i]], members: [vec] });
    }
  }

  // Second pass: greedy assignment is order-dependent, so fold together clusters
  // that ended up adjacent once their centroids had settled.
  for (let a = 0; a < clusters.length; a += 1) {
    if (!clusters[a]) continue;
    for (let b = a + 1; b < clusters.length; b += 1) {
      if (!clusters[b]) continue;
      const score = cosine(clusters[a].centroid, clusters[b].centroid);
      const distinctive = hasDistinctiveOverlap(clusters[a].centroid, clusters[b].centroid, distinctiveFloor);
      if (score >= (distinctive ? threshold : strictThreshold)) {
        clusters[a].items.push(...clusters[b].items);
        for (const v of clusters[b].members) mergeInto(clusters[a].centroid, v, 1);
        clusters[a].members.push(...clusters[b].members);
        clusters[b] = null;
      }
    }
  }

  return clusters.filter(Boolean).map((c) => ({ items: c.items }));
}
