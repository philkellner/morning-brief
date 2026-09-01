// Assigns each story a topic, so science competes against science.
//
// Without this, one undifferentiated consensus ranking always converges on
// world news: every outlet runs a world desk, far fewer run a science desk, so
// a major research result carried by four outlets loses to a geopolitical story
// carried by fifteen. Ranking within topic is what makes the brief broad.
//
// Classification is deterministic - feed provenance, then section path, then
// feed categories, then vocabulary - in descending order of trustworthiness. No
// model is involved, for the same reason nothing else here uses one: a model
// would import its own notions of what counts as "business news".

import { stripHtml } from './text.mjs';

/** The catch-all. Anything not clearly specialist belongs here. */
export const DEFAULT_TOPIC = 'world';

export const TOPICS = {
  world: { label: 'World', short: 'WORLD' },
  tech: { label: 'Tech & science', short: 'TECH' },
  business: { label: 'Business', short: 'BUSINESS' },
  health: { label: 'Health & climate', short: 'HEALTH' },
};

const RULES = {
  tech: {
    paths: /\/(tech\w*|scien\w*|space|gadget\w*|computing|ai)\//i,
    categories: /^(tech|technology|science|space|computing|artificial intelligence|gadgets)$/i,
    keywords: [
      /\b(artificial intelligence|machine learning|neural network|deep learning)\b/i,
      /\b(chatbot|large language model|llm|generative ai|ai model|ai system)\b/i,
      // Case-sensitive: the bare initialism, without matching names like "Ai Weiwei".
      /\bAI\b/,
      /\b(semiconductor|microchip|chipmaker|chips?|processor|silicon|foundry)\b/i,
      /\b(tech (?:giant|firm|company)|silicon valley|big tech)\b/i,
      /\b(hardware|electronics|transistor|process node|fabrication|nanomet\w*|circuit board)\b/i,
      /\b(software|smartphone|operating system|open source|app store)\b/i,
      /\b(cybersecurity|data breach|ransomware|hacking group|malware)\b/i,
      /\b(quantum|robotics|autonomous vehicle|algorithm)\b/i,
      /\b(satellite|spacecraft|rocket launch|telescope|asteroid|orbit)\b/i,
      /\b(researchers|scientists|study (?:found|suggests)|peer.reviewed|journal)\b/i,
      /\b(genome|dna|species|fossil|archaeolog|palaeontolog|physics|astronom)\w*/i,
    ],
  },
  business: {
    paths: /\/(business|market\w*|econom\w*|financ\w*|money|investing)\//i,
    categories: /^(business|markets|economy|finance|money|economics)$/i,
    keywords: [
      /\b(shares?|stock market|equities|index closed|wall street|nasdaq|ftse)\b/i,
      /\b(earnings|revenue|quarterly profit|guidance|dividend)\b/i,
      /\b(ipo|merger|acquisition|takeover bid|buyout|bankruptcy|insolvency)\b/i,
      /\b(inflation|interest rates?|central bank|federal reserve|monetary policy|rate cut)\b/i,
      /\b(economy|economic growth|trade deal|tariffs?|exports?|imports?)\b/i,
      /\b(gdp|recession|unemployment rate|jobs report|consumer prices)\b/i,
      /\b(layoffs|hiring freeze|chief executive|shareholders|valuation)\b/i,
      /\b(oil prices?|commodit|currency|bond yields?)\b/i,
    ],
  },
  health: {
    paths: /\/(health\w*|medicine|medical|environment\w*|climate\w*|energy|wellness)\//i,
    categories: /^(health|medicine|environment|climate|climate change|energy|science and environment)$/i,
    keywords: [
      /\b(vaccine|outbreak|epidemic|pandemic|infection|virus strain)\b/i,
      /\b(cancer|diabetes|obesity|alzheimer|dementia|mental health)\b/i,
      /\b(clinical trial|drug approval|fda|patients|hospitals?|public health)\b/i,
      /\b(climate(?: change| crisis| scientists?)?|global warming|greenhouse gas|carbon emissions|net zero)\b/i,
      /\b(heatwave|wildfire|drought|flooding|hurricane|extreme weather)\b/i,
      /\b(renewable energy|solar power|wind farm|fossil fuels?|coal plant)\b/i,
      /\b(biodiversity|deforestation|pollution|conservation|ecosystem)\b/i,
    ],
  },
};

// Provenance beats vocabulary: a story from a science feed is science even when
// its headline avoids every science word.
const WEIGHT = { feedHint: 4, path: 2.5, category: 2, keyword: 1 };
const KEYWORD_CAP = 4;

// Vocabulary alone cannot promote a story into a specialist topic - only
// provenance can. Measured on a live digest, a two-keyword bar mislabelled four
// of ten stories: "Iran urges US to honour commitments under MoU" became
// business, "Nepal families post photos of missing relatives" became health.
// Those then consumed the specialist slots, displacing the real tech and health
// stories, which is worse than never having segmented at all.
//
// The reliable signal is who carried it. Tech desks cover tech. If twelve
// general outlets ran a story and not one of the registry's topic feeds did,
// it is general news whatever words it happens to contain. Keywords still
// score - they decide BETWEEN topics once provenance has established there is
// a specialist claim to judge - but they can no longer make that claim alone.
const REQUIRE_PROVENANCE = true;

/**
 * Topic evidence for a single item.
 * @returns {Record<string, {score: number, provenance: number, hits: number}>}
 */
export function scoreItemTopics(item) {
  const scores = {
    tech: { score: 0, provenance: 0, hits: 0 },
    business: { score: 0, provenance: 0, hits: 0 },
    health: { score: 0, provenance: 0, hits: 0 },
  };
  const text = `${stripHtml(item.title ?? '')} ${stripHtml(item.description ?? '')}`;

  let path = '';
  try {
    if (item.link) path = new URL(item.link).pathname;
  } catch { /* a malformed link simply contributes no path signal */ }

  for (const [topic, rule] of Object.entries(RULES)) {
    const entry = scores[topic];
    if (item.topicHint === topic) entry.provenance += WEIGHT.feedHint;
    if (path && rule.paths.test(path)) entry.provenance += WEIGHT.path;
    if (item.categories?.some((c) => rule.categories.test(String(c).trim()))) entry.provenance += WEIGHT.category;

    for (const re of rule.keywords) if (re.test(text)) entry.hits += 1;
    entry.score = entry.provenance + Math.min(entry.hits, KEYWORD_CAP) * WEIGHT.keyword;
  }
  return scores;
}

/**
 * The topic for a cluster, by summed evidence across its members.
 * Summing rather than voting means one strongly-signalled member (a dedicated
 * science feed) can carry a cluster whose other members are generalists.
 */
export function classifyCluster(items) {
  const totals = {
    tech: { score: 0, provenance: 0, hits: 0 },
    business: { score: 0, provenance: 0, hits: 0 },
    health: { score: 0, provenance: 0, hits: 0 },
  };

  for (const item of items) {
    const scores = scoreItemTopics(item);
    for (const topic of Object.keys(totals)) {
      totals[topic].score += scores[topic].score;
      totals[topic].provenance += scores[topic].provenance;
      // The best-evidenced member decides, not the sum: one dedicated science
      // feed should carry a cluster whose other members are generalists, but
      // ten generalists each brushing one keyword should not.
      totals[topic].hits = Math.max(totals[topic].hits, scores[topic].hits);
    }
  }

  let best = DEFAULT_TOPIC;
  let bestScore = 0;
  for (const [topic, evidence] of Object.entries(totals)) {
    const qualifies = REQUIRE_PROVENANCE ? evidence.provenance > 0 : evidence.hits > 0;
    if (!qualifies) continue;
    const normalised = evidence.score / Math.max(1, Math.sqrt(items.length));
    if (normalised > bestScore) { best = topic; bestScore = normalised; }
  }
  return best;
}

/**
 * Fill each topic's quota from the ranked list, then backfill any unused slots
 * from whatever ranked highest overall.
 *
 * Backfilling matters: on a quiet science day, padding the quota with a
 * single-source story would be worse than giving the slot to the fifth-best
 * world story. `minSources` is what stops that.
 */
export function selectByQuota(ranked, { quotas, limit, minSources = 2 }) {
  const chosen = [];
  const taken = new Set();

  for (const [topic, quota] of Object.entries(quotas)) {
    let filled = 0;
    for (const entry of ranked) {
      if (filled >= quota || chosen.length >= limit) break;
      if (taken.has(entry) || entry.topic !== topic) continue;
      if (topic !== DEFAULT_TOPIC && entry.score.distinctSources < minSources) continue;
      chosen.push(entry);
      taken.add(entry);
      filled += 1;
    }
  }

  for (const entry of ranked) {
    if (chosen.length >= limit) break;
    if (taken.has(entry)) continue;
    chosen.push(entry);
    taken.add(entry);
  }

  return chosen.sort((a, b) => b.score.total - a.score.total).slice(0, limit);
}
