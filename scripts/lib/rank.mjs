// Turns raw clusters into ranked, presentable stories.
//
// Ranking principle: a story is "top news" when many independent outlets across
// the political spectrum all chose to run it. That is a measurable proxy for
// significance which no single newsroom's front page can give you.

import { cleanDescription, firstSentences, truncate } from './text.mjs';

// Framing devices common in engagement-optimised headlines. Presence of these
// does not make a report false - it makes it a worse choice of neutral summary,
// so we prefer a sibling headline that lacks them.
const LOADED_PATTERNS = [
  /\b(slams?|blasts?|destroys?|eviscerates?|savages?|torches?|schools?|shreds?)\b/i,
  /\b(shocking|stunning|bombshell|explosive|brutal|savage|epic|insane|chaos|meltdown|firestorm)\b/i,
  /\b(erupts?|rages?|fumes?|panics?|scrambles?)\b/i,
  /\b(here'?s (?:why|what|how)|what to know|you need to know|everything we know)\b/i,
  /\b(secret|hidden|exposed|revealed|truth about|the real reason)\b/i,
  /\b(desperate|humiliating|disastrous|catastrophic|shameful|outrageous)\b/i,
  /\b(woke|radical|far-left|far-right|libtard|snowflake|regime)\b/i,
  /\b(hits? back|fires? back|claps? back|hits? out)\b/i,
];

/** Lower is better. Penalises framing, punctuation theatrics, and odd lengths. */
export function sensationalism(title) {
  const t = String(title ?? '');
  let score = 0;
  for (const re of LOADED_PATTERNS) if (re.test(t)) score += 3;
  if (/!/.test(t)) score += 2;
  if (/\?$/.test(t)) score += 1.5;
  // Shouted words (initialisms like UN, EU, US, NATO are fine).
  const shouted = t.match(/\b[A-Z]{5,}\b/g) ?? [];
  score += shouted.length * 2;
  if (/^['"“]/.test(t.trim())) score += 1.5;   // opens on a quote - usually a reaction piece
  if (/\b(EXCLUSIVE|BREAKING|WATCH|LIVE|OPINION|ANALYSIS)\b\s*[:|-]/i.test(t)) score += 2.5;
  const len = t.length;
  if (len < 30) score += 1.5;
  if (len > 130) score += 1.5;
  const colonTease = /^[^:]{0,22}:\s/.test(t);   // "Ukraine: what happens next"
  if (colonTease) score += 0.75;
  return score;
}

/** Spread of political leans covering a story, 0 (monoculture) to 1 (full spectrum). */
export function leanSpread(leans, leanWeights) {
  const values = leans.map((l) => leanWeights[l] ?? 0);
  if (values.length < 2) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(...Object.values(leanWeights)) - Math.min(...Object.values(leanWeights));
  return range === 0 ? 0 : (max - min) / range;
}

/**
 * Score one cluster. Components are returned alongside the total so the app
 * (and a sceptical reader) can see exactly why a story ranked where it did.
 */
export function scoreCluster(cluster, { leanWeights, now = Date.now() }) {
  const sources = new Map();
  for (const item of cluster.items) if (!sources.has(item.sourceId)) sources.set(item.sourceId, item);

  const distinctSources = sources.size;
  const leans = [...sources.values()].map((i) => i.lean);
  const distinctLeans = new Set(leans).size;
  const spread = leanSpread(leans, leanWeights);
  const wireCount = [...sources.values()].filter((i) => i.wire).length;

  const newest = Math.max(...cluster.items.map((i) => (i.published ? i.published.getTime() : 0)));
  const ageHours = newest > 0 ? Math.max(0, (now - newest) / 3.6e6) : 24;
  // Half-life of about 18 hours: yesterday's lead should yield to this morning's.
  const recency = Math.pow(0.5, ageHours / 18);

  const breadth = 3.0 * Math.log2(1 + distinctSources);
  const diversity = 1.4 * (distinctLeans - 1) + 2.2 * spread;
  const wire = 0.8 * Math.min(wireCount, 4);
  const freshness = 2.5 * recency;

  return {
    total: breadth + diversity + wire + freshness,
    components: {
      breadth: round(breadth),
      diversity: round(diversity),
      wire: round(wire),
      freshness: round(freshness),
    },
    distinctSources,
    distinctLeans,
    leanSpread: round(spread),
    wireCount,
    newest,
    uniqueItems: [...sources.values()],
  };
}

const round = (n) => Math.round(n * 100) / 100;

/** Choose the least-framed headline available, preferring wire desks on a tie. */
export function pickHeadline(items) {
  return [...items].sort((a, b) => {
    const sa = sensationalism(a.title) - (a.wire ? 1.25 : 0);
    const sb = sensationalism(b.title) - (b.wire ? 1.25 : 0);
    if (sa !== sb) return sa - sb;
    return a.title.length - b.title.length;
  })[0];
}

/**
 * Build the two-sentence summary. Prefers a description from a different outlet
 * than the headline, so the story is not framed entirely by one newsroom.
 */
export function pickSummary(items, headlineItem) {
  const candidates = items
    .map((i) => ({ item: i, text: cleanDescription(i.description) }))
    .filter((c) => c.text.length >= 60)
    .sort((a, b) => {
      const wa = (a.item.wire ? -2 : 0) + sensationalism(a.text) * 0.5 + (a.item === headlineItem ? 0.75 : 0);
      const wb = (b.item.wire ? -2 : 0) + sensationalism(b.text) * 0.5 + (b.item === headlineItem ? 0.75 : 0);
      return wa - wb;
    });

  const chosen = candidates[0];
  if (!chosen) {
    // No usable description anywhere - fall back to the headline itself.
    return { text: '', sourceId: null };
  }
  return { text: firstSentences(chosen.text, 2, 260), sourceId: chosen.item.sourceId };
}

/** Assemble the final ranked story list. */
export function buildStories(clusters, { leanWeights, sourcesById, limit, now = Date.now() }) {
  const scored = clusters
    .map((cluster) => ({ cluster, score: scoreCluster(cluster, { leanWeights, now }) }))
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, limit);

  return scored.map(({ cluster, score }, index) => {
    const items = score.uniqueItems;
    const headlineItem = pickHeadline(items);
    const summary = pickSummary(items, headlineItem);

    const coverage = items
      .map((i) => ({
        source: sourcesById[i.sourceId]?.name ?? i.sourceId,
        sourceId: i.sourceId,
        lean: i.lean,
        title: truncate(i.title, 180),
        url: i.link,
      }))
      .sort((a, b) => a.source.localeCompare(b.source));

    return {
      rank: index + 1,
      id: stableId(headlineItem.title, score.newest),
      title: truncate(headlineItem.title, 180),
      summary: summary.text || truncate(cleanDescription(headlineItem.description), 260),
      url: headlineItem.link,
      headlineSource: sourcesById[headlineItem.sourceId]?.name ?? headlineItem.sourceId,
      summarySource: summary.sourceId ? (sourcesById[summary.sourceId]?.name ?? summary.sourceId) : null,
      publishedAt: score.newest > 0 ? new Date(score.newest).toISOString() : null,
      sourceCount: score.distinctSources,
      leanCount: score.distinctLeans,
      leanSpread: score.leanSpread,
      wireCount: score.wireCount,
      score: round(score.total),
      scoreComponents: score.components,
      coverage,
    };
  });
}

/** Deterministic id so the app can tell a genuinely new story from a re-run. */
function stableId(title, timestamp) {
  const basis = `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  let h = 2166136261;
  for (let i = 0; i < basis.length; i += 1) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const day = timestamp > 0 ? new Date(timestamp).toISOString().slice(0, 10) : 'undated';
  return `${day}-${(h >>> 0).toString(36)}`;
}
