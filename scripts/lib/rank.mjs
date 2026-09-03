// Turns raw clusters into ranked, presentable stories.
//
// Ranking principle: a story is "top news" when many independent outlets across
// the political spectrum all chose to run it. That is a measurable proxy for
// significance which no single newsroom's front page can give you.

import { cleanDescription, firstSentences, truncate, tokenize } from './text.mjs';
import { classifyCluster, selectByQuota, TOPICS, DEFAULT_TOPIC } from './topics.mjs';

/**
 * Slots per topic. World gets the largest share because it is the catch-all -
 * anything not clearly specialist lands there, including national politics.
 */
export const DEFAULT_QUOTAS = { world: 4, tech: 2, business: 2, health: 2 };

// Soft news: legitimately reported and often widely syndicated, but not what a
// "top ten news" brief is for. Demoted rather than excluded, so a genuine hard
// news story that happens to mention a royal is not silently dropped.
const SOFT_NEWS = [
  /\b(royal|monarchy|duchess|duke of|prince (?:harry|william|andrew)|meghan|kate middleton)\b/i,
  /\b(celebrity|red carpet|box office|grammy|oscar|emmy|bafta|met gala)\b/i,
  /\b(reality tv|dating show|makeover|recipe|horoscope|zodiac)\b/i,
  /\b(net worth|fashion|style icon|engagement ring|baby bump)\b/i,
];

/** Share of a cluster's headlines that read as soft news, 0 to 1. */
export function softness(items) {
  if (items.length === 0) return 0;
  const soft = items.filter((i) => SOFT_NEWS.some((re) => re.test(i.title))).length;
  return soft / items.length;
}

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
  // Keyed by outlet, not feed: a newsroom with both a world and a technology
  // feed must count once, or it inflates the very consensus number the whole
  // ranking rests on.
  const sources = new Map();
  for (const item of cluster.items) {
    const outlet = item.outlet ?? item.sourceId;
    if (!sources.has(outlet)) sources.set(outlet, item);
  }

  const distinctSources = sources.size;
  const leans = [...sources.values()].map((i) => i.lean);
  const distinctLeans = new Set(leans).size;
  const spread = leanSpread(leans, leanWeights);
  const wireCount = [...sources.values()].filter((i) => i.wire).length;

  const newest = Math.max(...cluster.items.map((i) => (i.published ? i.published.getTime() : 0)));
  const ageHours = newest > 0 ? Math.max(0, (now - newest) / 3.6e6) : 24;
  // Half-life of about 18 hours: yesterday's lead should yield to this morning's.
  const recency = Math.pow(0.5, ageHours / 18);

  const soft = softness(cluster.items);
  const softPenalty = 6.0 * soft;

  const breadth = 3.0 * Math.log2(1 + distinctSources);
  const diversity = 1.4 * (distinctLeans - 1) + 2.2 * spread;
  const wire = 0.8 * Math.min(wireCount, 4);
  const freshness = 2.5 * recency;

  return {
    total: breadth + diversity + wire + freshness - softPenalty,
    components: {
      breadth: round(breadth),
      diversity: round(diversity),
      wire: round(wire),
      freshness: round(freshness),
      softPenalty: round(-softPenalty),
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

/**
 * Terms shared by a substantial share of a cluster's headlines - what the story
 * is actually about, as agreed by the outlets covering it.
 */
export function coreTerms(items, { minShare = 0.4 } = {}) {
  const counts = new Map();
  for (const item of items) {
    for (const term of new Set(tokenize(item.title))) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  const needed = Math.max(2, Math.ceil(items.length * minShare));
  return new Set([...counts].filter(([, count]) => count >= needed).map(([term]) => term));
}

/** How much of the cluster's shared vocabulary a headline actually carries, 0-1. */
export function representativeness(title, core) {
  if (core.size === 0) return 1;
  const tokens = new Set(tokenize(title));
  let hits = 0;
  for (const term of core) if (tokens.has(term)) hits += 1;
  return hits / core.size;
}

// Weighted to outrank any plausible sensationalism difference: an uninformative
// headline is a worse notification than a slightly livelier accurate one.
const REPRESENTATIVE_WEIGHT = 5;

/**
 * Choose the plainest headline that still describes the story.
 *
 * Sensationalism alone is not enough. Scoring only the absence of framing
 * rewards headlines that say nothing: a live digest led a nine-outlet G20 trade
 * story with "China's corruption investigation procedures", which has no loaded
 * words at all and no information either. A headline must also carry the
 * vocabulary its cluster agrees on.
 */
export function pickHeadline(items) {
  const core = coreTerms(items);
  const cost = (item) => sensationalism(item.title)
    - (item.wire ? 1.25 : 0)
    - REPRESENTATIVE_WEIGHT * representativeness(item.title, core);

  return [...items].sort((a, b) => {
    const diff = cost(a) - cost(b);
    if (diff !== 0) return diff;
    return a.title.length - b.title.length;
  })[0];
}

/**
 * Build the two-sentence summary. Prefers a description from a different outlet
 * than the headline, so the story is not framed entirely by one newsroom.
 */
export function pickSummary(items, headlineItem) {
  // The summary is judged on the same representativeness as the headline. The
  // same live digest paired a G20 trade headline with a sentence about the
  // Strait of Hormuz, taken from the one cluster member about something else.
  const core = coreTerms(items);
  const cost = (item, text) => (item.wire ? -2 : 0)
    + sensationalism(text) * 0.5
    + (item === headlineItem ? 0.75 : 0)
    - REPRESENTATIVE_WEIGHT * representativeness(`${item.title} ${text}`, core);

  const candidates = items
    .map((i) => ({ item: i, text: cleanDescription(i.description) }))
    .filter((c) => c.text.length >= 60)
    .sort((a, b) => cost(a.item, a.text) - cost(b.item, b.text));

  const chosen = candidates[0];
  if (!chosen) {
    // No usable description anywhere - fall back to the headline itself.
    return { text: '', sourceId: null };
  }
  return { text: firstSentences(chosen.text, 2, 260), sourceId: chosen.item.sourceId };
}

/** Assemble the final ranked story list. */
export function buildStories(clusters, {
  leanWeights, sourcesById, limit, now = Date.now(), quotas = DEFAULT_QUOTAS,
}) {
  const ranked = clusters
    .map((cluster) => ({
      cluster,
      topic: classifyCluster(cluster.items),
      score: scoreCluster(cluster, { leanWeights, now }),
    }))
    .sort((a, b) => b.score.total - a.score.total);

  // Ranking within topic is what stops world news taking all ten slots: every
  // outlet runs a world desk, so an unsegmented list always converges there.
  const scored = selectByQuota(ranked, { quotas, limit });

  return scored.map(({ cluster, score, topic }, index) => {
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
      topic,
      topicLabel: TOPICS[topic]?.label ?? TOPICS[DEFAULT_TOPIC].label,
      topicShort: TOPICS[topic]?.short ?? TOPICS[DEFAULT_TOPIC].short,
      title: truncate(headlineItem.title, 180),
      summary: summary.text || fallbackSummary(items),
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

/**
 * Last resort when no outlet supplied a usable description. Returns the longest
 * scrap of prose available, or an empty string - never a stray markup fragment.
 */
function fallbackSummary(items) {
  const best = items
    .map((i) => cleanDescription(i.description))
    .filter((t) => t.length >= 40)
    .sort((a, b) => b.length - a.length)[0];
  return best ? truncate(best, 260) : '';
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
