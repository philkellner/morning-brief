// Groups headlines from different outlets that describe the same event.
//
// Approach: TF-IDF vectors over headline tokens, with proper-noun matches weighted
// up, compared by cosine similarity and grouped greedily. Rare terms ("Sudan",
// "ceasefire") dominate the score; common newsroom vocabulary ("says", "report")
// is near-worthless after IDF, which is exactly what we want.

import { tokenize, entities, stem } from './text.mjs';

const ENTITY_BOOST = 1.7;
// Description tokens are noisier than headline tokens but rescue stories whose
// headlines share no vocabulary ("Fed holds rates" / "Central bank stands pat").
const DESCRIPTION_WEIGHT = 0.45;

/**
 * Build the token->weight map for one item, plus the set of its tokens that are
 * proper nouns.
 *
 * The proper-noun set is what lets the merge gate tell a story from a subject.
 * Stemmed to match the tokens, since "Houthis" tokenises to "houthi".
 */
function termFrequencies(item) {
  const tf = new Map();
  const properNouns = new Set();
  const bump = (term, amount) => tf.set(term, (tf.get(term) ?? 0) + amount);
  for (const t of tokenize(item.title)) bump(t, 1);
  for (const e of entities(item.title)) {
    bump(`@${e}`, ENTITY_BOOST);
    for (const word of e.split(/\s+/)) properNouns.add(stem(word));
  }
  const description = item.description ?? '';
  for (const t of tokenize(description).slice(0, 40)) bump(t, DESCRIPTION_WEIGHT);
  // Headlines abbreviate ("Fed") where the body spells it out ("Federal Reserve"),
  // so body proper nouns are what link those two reports of the same event.
  for (const e of entities(description).slice(0, 20)) {
    bump(`@${e}`, DESCRIPTION_WEIGHT * ENTITY_BOOST);
    for (const word of e.split(/\s+/)) properNouns.add(stem(word));
  }
  return { tf, properNouns };
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
 * Two reports of one event share several rare, topic-bearing terms
 * ("steel"+"tariff", "Hokkaido"+"tsunami"). Two unrelated reports share only
 * common newsroom vocabulary, which IDF has already flattened to near-zero.
 *
 * One shared term is not enough, and accepting it merged four unrelated stories
 * in a live digest purely because each said "NYC": a bus fatality, a grocery
 * profile, a relocation listicle and a schools AI ban. A short headline's vector
 * is dominated by its one proper noun, so two of them score as near-identical
 * while sharing nothing but a place name.
 *
 * The '@' prefix marking a proper noun is stripped before counting, so "nyc" and
 * "@nyc" are one piece of evidence rather than two.
 */
const MIN_SHARED_TERMS = 2;
// At least one shared term must be a common noun or verb - the thing that
// happened - and not a name, place or organisation.
const MIN_PREDICATE_TERMS = 1;

function distinctiveOverlap(a, b, { floor, predicateFloor }) {
  const [small, large] = a.vec.size <= b.vec.size ? [a, b] : [b, a];
  const shared = new Set();
  let predicate = 0;
  for (const [term, weight] of small.vec) {
    const other = large.vec.get(term);
    if (!other) continue;
    const product = weight * other;
    const isProperNoun = term.startsWith('@')
      || a.properNouns.has(term)
      || b.properNouns.has(term);

    if (product >= floor) shared.add(term.startsWith('@') ? term.slice(1) : term);
    // Predicates get a lower bar: common nouns and verbs carry less IDF weight
    // than names, so holding them to the proper-noun floor rejected genuine
    // duplicates that agreed on "cargo", "ship" and "struck".
    if (!isProperNoun && product >= predicateFloor) predicate += 1;
  }
  return { shared: shared.size, predicate };
}

/**
 * Two items may merge only if they agree on something that happened.
 *
 * Shared proper nouns establish a shared SUBJECT, not a shared story. On one day
 * "Iranian cargo ship struck in Hormuz", "Oman talks postponed", "Iran destroys
 * US drone" and a Houthi advance all merged into one twelve-outlet cluster on
 * iran/iranian/hormuz alone - and pulled in an unrelated story about GOP
 * midterms. Another merged "Amodei calls for AI slowdown" with "Anthropic picks
 * Nasdaq for IPO" on the word Anthropic.
 *
 * Reports of one event share its predicate: struck, postponed, slowdown.
 * Reports about one subject do not.
 */
function hasDistinctiveOverlap(a, b, opts) {
  const { shared, predicate } = distinctiveOverlap(a, b, opts);
  return shared >= MIN_SHARED_TERMS && predicate >= opts.minPredicate;
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
/**
 * Vectorise a whole corpus together. Exported so a diagnostic can measure the
 * same vectors the clusterer compares, rather than approximating them: IDF only
 * means anything over the full day's documents.
 */
export function analyseCorpus(items) {
  const analysed = items.map(termFrequencies);
  const idf = idfWeights(analysed.map((a) => a.tf));
  return analysed.map(({ tf, properNouns }) => ({ vec: toVector(tf, idf), properNouns }));
}

/**
 * The heaviest proper noun in `a` that `b` has no trace of.
 *
 * `max`, not a sum, deliberately: a centroid accumulates the vocabulary of every
 * member, so a sum would grow with cluster size and make large clusters
 * progressively unjoinable regardless of what the candidate says.
 */
function peakExclusive(a, b) {
  let peak = 0;
  for (const [term, weight] of a.vec) {
    if (b.vec.has(term)) continue;
    const isProperNoun = term.startsWith('@') || a.properNouns.has(term);
    if (!isProperNoun) continue;
    if (weight > peak) peak = weight;
  }
  return peak;
}

/** Pairwise evidence, for diagnostics and threshold sweeps. */
export function pairEvidence(vectors, i, j, opts = {}) {
  const a = vectors[i];
  const b = vectors[j];
  const floor = opts.distinctiveFloor ?? 0.03;
  const predicateFloor = opts.predicateFloor ?? 0.012;
  const { shared, predicate } = distinctiveOverlap(a, b, { floor, predicateFloor });
  let sharedWeight = 0;
  for (const [term, weight] of a.vec) {
    const other = b.vec.get(term);
    if (other) sharedWeight += weight * other;
  }
  const exclusiveA = peakExclusive(a, b);
  const exclusiveB = peakExclusive(b, a);
  return {
    cosine: cosine(a.vec, b.vec),
    shared,
    predicate,
    sharedWeight,
    exclusiveA,
    exclusiveB,
    contested: Math.min(exclusiveA, exclusiveB),
    ratio: sharedWeight > 0 ? Math.min(exclusiveA, exclusiveB) / sharedWeight : Infinity,
  };
}

export function clusterItems(items, opts = {}) {
  const threshold = opts.threshold ?? 0.20;
  // With nothing distinctive in common we demand a markedly stronger match,
  // otherwise two unrelated stories about "police" and "investigation" fuse.
  const strictThreshold = opts.strictThreshold ?? 0.42;
  // 0.03, retuned when the gate began requiring two shared terms rather than
  // one. Swept against a 34-item corpus: 0.04 over-splits (recall 0.84) and
  // 0.02 re-merges the NYC group; 0.03 scores precision and recall both 1.00.
  const distinctiveFloor = opts.distinctiveFloor ?? 0.03;
  const predicateFloor = opts.predicateFloor ?? 0.012;
  const minPredicate = opts.minPredicate ?? MIN_PREDICATE_TERMS;
  const gate = { floor: distinctiveFloor, predicateFloor, minPredicate };

  if (items.length === 0) return [];

  const vectors = analyseCorpus(items);

  const clusters = [];
  for (let i = 0; i < items.length; i += 1) {
    const vec = vectors[i];
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = cosine(vec.vec, cluster.centroid.vec);
      if (score <= bestScore) continue;
      const distinctive = hasDistinctiveOverlap(vec, cluster.centroid, gate);
      const required = distinctive ? threshold : strictThreshold;
      if (score >= required) { best = cluster; bestScore = score; }
    }

    if (best) {
      best.items.push(items[i]);
      best.members.push(vec);
      mergeInto(best.centroid.vec, vec.vec, 1);
      for (const p of vec.properNouns) best.centroid.properNouns.add(p);
    } else {
      clusters.push({
        centroid: { vec: new Map(vec.vec), properNouns: new Set(vec.properNouns) },
        items: [items[i]],
        members: [vec],
      });
    }
  }

  // Second pass: greedy assignment is order-dependent, so fold together clusters
  // that ended up adjacent once their centroids had settled.
  for (let a = 0; a < clusters.length; a += 1) {
    if (!clusters[a]) continue;
    for (let b = a + 1; b < clusters.length; b += 1) {
      if (!clusters[b]) continue;
      const score = cosine(clusters[a].centroid.vec, clusters[b].centroid.vec);
      const distinctive = hasDistinctiveOverlap(clusters[a].centroid, clusters[b].centroid, gate);
      if (score >= (distinctive ? threshold : strictThreshold)) {
        clusters[a].items.push(...clusters[b].items);
        for (const v of clusters[b].members) mergeInto(clusters[a].centroid.vec, v.vec, 1);
        for (const p of clusters[b].centroid.properNouns) clusters[a].centroid.properNouns.add(p);
        clusters[a].members.push(...clusters[b].members);
        clusters[b] = null;
      }
    }
  }

  return clusters.filter(Boolean).map((c) => ({ items: c.items }));
}
