#!/usr/bin/env node
// Builds the daily digest: fetch feeds -> filter -> cluster -> rank -> write JSON.
//
//   node scripts/build-digest.mjs [--limit 10] [--out docs/digest.json]
//                                 [--fixture path.json] [--dry-run] [--quiet]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from './lib/rss.mjs';
import { clusterItems } from './lib/cluster.mjs';
import { buildStories } from './lib/rank.mjs';
import { stripHtml } from './lib/text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'morning-brief/1.0 (+https://github.com/philkellner/morning-brief)';

const CONFIG = {
  limit: 10,
  maxAgeHours: 36,
  perFeedItems: 30,
  fetchTimeoutMs: 20000,
  concurrency: 8,
  // Publishing a two-story digest is worse than publishing nothing and keeping
  // yesterday's, so the build fails loudly below these floors.
  minFeeds: 5,
  minStories: 5,
  timezone: 'America/Chicago',
};

// Sections that are commentary, listings, or lifestyle rather than reported news.
const EXCLUDED_PATH = new RegExp([
  'opinion', 'commentisfree', 'editorial', 'voices', 'columnists', 'letters',
  'blogs?', 'sport', 'sports', 'football', 'soccer', 'nfl', 'nba', 'mlb',
  'entertainment', 'celebrity', 'showbiz', 'arts', 'lifestyle', 'style',
  'travel', 'food', 'recipes', 'horoscopes?', 'puzzles?', 'crossword',
  'obituaries', 'weather', 'shopping', 'deals', 'coupons', 'gaming',
].map((s) => `/${s}/`).join('|'), 'i');

const EXCLUDED_TITLE = [
  /\blive updates?\b/i, /\bphotos? of the (?:day|week)\b/i, /\bin pictures\b/i,
  /\bpodcast\b/i, /\bquiz\b/i, /\bcrossword\b/i, /\bnewsletter\b/i,
  /\bwatch live\b/i, /\bmorning briefing\b/i, /\bwhat to watch\b/i,
  /\byour (?:daily|morning|evening)\b/i, /\brecap\b/i, /\bhoroscope\b/i,
];

const EXCLUDED_CATEGORY = /^(opinion|sport|sports|entertainment|lifestyle|travel|arts|culture|food)$/i;

function parseArgs(argv) {
  const args = { ...CONFIG, out: 'docs/digest.json', fixture: null, dryRun: false, quiet: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
    else if (a === '--min-stories') args.minStories = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error('--limit must be a positive number');
  return args;
}

async function fetchFeed(source, timeoutMs) {
  const attempt = async () => {
    const res = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  try {
    return { ok: true, xml: await attempt() };
  } catch (first) {
    try {
      // One retry: feeds behind CDNs intermittently reset connections.
      return { ok: true, xml: await attempt() };
    } catch (second) {
      return { ok: false, error: String(second.message ?? second).slice(0, 120), firstError: String(first.message ?? first).slice(0, 120) };
    }
  }
}

/** Run tasks with bounded concurrency so 28 feeds do not open 28 sockets at once. */
async function pooled(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isNewsworthy(item) {
  if (!item.title || item.title.length < 15) return false;
  if (item.link && EXCLUDED_PATH.test(new URL(item.link).pathname)) return false;
  if (EXCLUDED_TITLE.some((re) => re.test(item.title))) return false;
  if (item.categories?.some((c) => EXCLUDED_CATEGORY.test(c.trim()))) return false;
  return true;
}

async function collectItems(sources, args, log) {
  const results = await pooled(sources, args.concurrency, async (source) => {
    const res = await fetchFeed(source, args.fetchTimeoutMs);
    if (!res.ok) {
      log(`  FAIL  ${source.id.padEnd(14)} ${res.error}`);
      return { source, ok: false, error: res.error, items: [] };
    }
    let parsed;
    try {
      parsed = parseFeed(res.xml);
    } catch (e) {
      log(`  FAIL  ${source.id.padEnd(14)} parse error: ${e.message}`);
      return { source, ok: false, error: `parse: ${e.message}`, items: [] };
    }
    log(`  ok    ${source.id.padEnd(14)} ${String(parsed.length).padStart(3)} items`);
    return { source, ok: true, items: parsed };
  });

  const cutoff = Date.now() - args.maxAgeHours * 3.6e6;
  const seenTitles = new Set();
  const items = [];

  for (const { source, ok, items: raw } of results) {
    if (!ok) continue;
    let kept = 0;
    for (const item of raw) {
      if (kept >= args.perFeedItems) break;
      if (!item.link) continue;
      let newsworthy;
      try { newsworthy = isNewsworthy(item); } catch { newsworthy = false; }
      if (!newsworthy) continue;
      // Undated items are common and usually current; keep them.
      if (item.published && item.published.getTime() < cutoff) continue;

      const key = `${source.id}::${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      items.push({
        sourceId: source.id,
        outlet: source.outlet ?? source.id,
        lean: source.lean,
        wire: Boolean(source.wire),
        title: stripHtml(item.title),
        description: item.description ?? '',
        link: item.link,
        published: item.published,
      });
      kept += 1;
    }
  }

  return { items, results };
}

async function main() {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : (...m) => console.log(...m);
  const config = JSON.parse(await readFile(resolve(ROOT, 'sources.json'), 'utf8'));
  const { sources, leanWeights } = config;
  const sourcesById = Object.fromEntries(sources.map((s) => [s.id, s]));

  let items;
  let feedResults;

  if (args.fixture) {
    log(`Loading fixture ${args.fixture}`);
    const fixture = JSON.parse(await readFile(resolve(ROOT, args.fixture), 'utf8'));
    items = fixture.map((f) => ({
      ...f,
      outlet: f.outlet ?? sourcesById[f.sourceId]?.outlet ?? f.sourceId,
      lean: f.lean ?? sourcesById[f.sourceId]?.lean ?? 'center',
      wire: f.wire ?? Boolean(sourcesById[f.sourceId]?.wire),
      link: f.link ?? `https://example.invalid/${f.sourceId}/${encodeURIComponent(f.title.slice(0, 40))}`,
      published: f.published ? new Date(f.published) : new Date(),
    }));
    feedResults = [];
  } else {
    log(`Fetching ${sources.length} feeds...`);
    const collected = await collectItems(sources, args, log);
    items = collected.items;
    feedResults = collected.results;

    const okCount = feedResults.filter((r) => r.ok).length;
    log(`\n${okCount}/${sources.length} feeds responded, ${items.length} articles after filtering`);
    if (okCount < args.minFeeds) {
      throw new Error(`Only ${okCount} feeds responded (minimum ${args.minFeeds}). Refusing to publish a thin digest.`);
    }
  }

  const clusters = clusterItems(items);
  log(`${clusters.length} distinct stories clustered`);

  const stories = buildStories(clusters, { leanWeights, sourcesById, limit: args.limit });
  if (stories.length < Math.min(args.minStories, args.limit)) {
    throw new Error(`Only ${stories.length} stories produced (minimum ${args.minStories}). Refusing to overwrite the previous digest.`);
  }

  const now = new Date();
  const edition = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const digest = {
    version: 1,
    edition,
    generatedAt: now.toISOString(),
    timezone: CONFIG.timezone,
    storyCount: stories.length,
    method: {
      summary: 'Stories are ranked by how many independent outlets across the political spectrum covered them, not by any one newsroom\'s judgement.',
      ranking: 'breadth (distinct outlets) + diversity (spread of editorial lean) + wire presence + recency',
      headlineChoice: 'least sensational phrasing among covering outlets, wire desks preferred',
      caveat: 'Cross-source consensus reduces single-outlet slant. It cannot remove shared blind spots, and it favours widely-covered stories over important but under-reported ones.',
    },
    feeds: {
      attempted: args.fixture ? 0 : sources.length,
      succeeded: feedResults.filter((r) => r.ok).length,
      failed: feedResults.filter((r) => !r.ok).map((r) => ({ id: r.source.id, error: r.error })),
    },
    stories,
  };

  if (args.dryRun) {
    log('\n--- dry run, nothing written ---');
    for (const s of stories) {
      log(`\n${String(s.rank).padStart(2)}. ${s.title}`);
      log(`    ${s.summary}`);
      log(`    ${s.sourceCount} outlets / ${s.leanCount} leans / spread ${s.leanSpread} / score ${s.score}  [${s.coverage.map((c) => c.sourceId).join(' ')}]`);
    }
    return;
  }

  const outPath = resolve(ROOT, args.out);
  await mkdir(dirname(outPath), { recursive: true });
  const json = `${JSON.stringify(digest, null, 2)}\n`;
  await writeFile(outPath, json);

  const archivePath = resolve(ROOT, dirname(args.out), 'archive', `${edition}.json`);
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, json);

  log(`\nWrote ${args.out} and archive/${edition}.json (${stories.length} stories)`);
}

main().catch((err) => {
  console.error(`\nbuild-digest failed: ${err.message}`);
  process.exit(1);
});
