// Run with: node --test scripts/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripHtml, cleanDescription, truncate, tokenize, entities, stem, firstSentences, dropDanglingOpener } from './lib/text.mjs';
import { buildMessages, zonedTimeToEpoch, nextDeliveryEpoch, isSlotPassed, readConfig } from './lib/ntfy.mjs';
import { classifyCluster, selectByQuota, DEFAULT_TOPIC } from './lib/topics.mjs';
import { parseFeed, cleanUrl } from './lib/rss.mjs';
import { clusterItems } from './lib/cluster.mjs';
import { sensationalism, pickHeadline, pickSummary, coreTerms, representativeness, leanSpread, buildStories } from './lib/rank.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(ROOT, 'scripts/fixtures/headlines.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(ROOT, 'sources.json'), 'utf8'));

test('stripHtml decodes entities and closes inline-tag gaps', () => {
  assert.equal(stripHtml('<p>Hello &amp; <b>world</b>&#8217;s &quot;news&quot;</p>'), 'Hello & world’s "news"');
  assert.equal(stripHtml('<script>evil()</script>Text'), 'Text');
});

test('stripHtml rejects lone surrogates that would corrupt JSON', () => {
  const out = stripHtml('bad &#55296; end');
  assert.ok(!/[\uD800-\uDFFF]/.test(out));
  JSON.parse(JSON.stringify({ out })); // must not throw
});

test('cleanDescription removes syndication boilerplate', () => {
  assert.equal(cleanDescription('<p>Rates held. Continue reading...</p>'), 'Rates held.');
  assert.equal(cleanDescription('Story text. The post X appeared first on Y.'), 'Story text.');
});

test('truncate breaks on word boundaries and only ellipsises when cut', () => {
  assert.equal(truncate('short', 20), 'short');
  assert.ok(truncate('the quick brown fox jumps over', 15).endsWith('…'));
  assert.ok(truncate('the quick brown fox jumps over', 15).length <= 16);
});

test('firstSentences keeps sentence count and normalises spacing', () => {
  assert.equal(firstSentences('One. Two. Three.', 2, 200), 'One. Two.');
});

test('stemmer collides inflections that outlets vary on', () => {
  for (const [a, b] of [['tariff', 'tariffs'], ['import', 'imported'], ['duty', 'duties'], ['trade', 'trading']]) {
    assert.equal(stem(a), stem(b), `${a} should stem to same as ${b}`);
  }
  assert.equal(stem('gas'), 'gas');
  assert.equal(stem('business'), 'business');
});

test('tokenize drops stopwords and short noise', () => {
  const t = tokenize('The UN and a Report on the New Crisis');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('and'));
  assert.ok(t.includes('crisis'));
});

test('entities keeps sentence-initial proper nouns and emits component words', () => {
  assert.deepEqual(entities('Japan issues tsunami advisory'), ['japan']);
  const e = entities('US Federal Reserve keeps rates on hold');
  assert.ok(e.includes('federal'));
  assert.ok(e.includes('reserve'));
});

test('parseFeed handles RSS, Atom, and CDATA', () => {
  const rss = '<rss><channel><item><title><![CDATA[A story]]></title><link>https://e.com/a</link><description>Body</description><pubDate>Tue, 12 Aug 2025 06:00:00 GMT</pubDate></item></channel></rss>';
  const [item] = parseFeed(rss);
  assert.equal(item.title, 'A story');
  assert.equal(item.link, 'https://e.com/a');
  assert.ok(item.published instanceof Date);

  const atom = '<feed><entry><title>Atom</title><link rel="alternate" href="https://e.org/p"/><summary>S</summary></entry></feed>';
  assert.equal(parseFeed(atom)[0].link, 'https://e.org/p');
});

test('parseFeed survives malformed input without throwing', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<rss><channel></channel></rss>'), []);
  assert.doesNotThrow(() => parseFeed('<item><title>x</title'));
});

test('cleanUrl strips trackers and refuses non-http schemes', () => {
  assert.equal(cleanUrl('https://e.com/a?utm_source=rss&id=7&fbclid=z'), 'https://e.com/a?id=7');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl('not a url'), '');
  assert.equal(cleanUrl('http://e.com/a'), 'https://e.com/a');
});

test('clustering groups the fixture exactly, with no false merges', () => {
  const clusters = clusterItems(fixture);
  const expected = new Set(fixture.map((f) => f.event)).size;
  assert.equal(clusters.length, expected, 'cluster count should equal distinct events');
  for (const c of clusters) {
    const events = new Set(c.items.map((i) => i.event));
    assert.equal(events.size, 1, `cluster mixed events: ${[...events].join('+')}`);
  }
});

test('clustering keeps distinct same-topic events apart', () => {
  const clusters = clusterItems(fixture);
  const eventOf = (sourceId, event) => clusters.findIndex((c) => c.items.some((i) => i.sourceId === sourceId && i.event === event));
  // Two different earthquakes must not share a cluster.
  assert.notEqual(eventOf('reuters', 'quake'), eventOf('bbc', 'quake_chile'));
  // Two different central banks likewise.
  assert.notEqual(eventOf('ap', 'fed'), eventOf('economist', 'ecb'));
  // Two different Gaza stories likewise.
  assert.notEqual(eventOf('npr', 'gaza_aid'), eventOf('aljazeera', 'gaza_talks'));
});

test('sensationalism scores framed headlines above plain ones', () => {
  assert.ok(sensationalism('Fed SLAMS critics in shocking rebuke!') > sensationalism('Federal Reserve holds interest rates steady'));
  assert.ok(sensationalism("Here's why the Fed decision matters") > sensationalism('Federal Reserve holds rates steady'));
});

test('pickHeadline prefers the plainest phrasing', () => {
  const chosen = pickHeadline([
    { title: 'Fed SLAMS critics in shocking rebuke!', wire: false },
    { title: 'Federal Reserve holds interest rates steady', wire: true },
  ]);
  assert.equal(chosen.title, 'Federal Reserve holds interest rates steady');
});

test('leanSpread is 1 across the full spectrum and 0 for a monoculture', () => {
  const w = config.leanWeights;
  assert.equal(leanSpread(['left', 'right'], w), 1);
  assert.equal(leanSpread(['left', 'left'], w), 0);
});

test('buildStories ranks broad cross-spectrum coverage first', () => {
  const items = fixture.map((f) => ({
    ...f,
    lean: config.sources.find((s) => s.id === f.sourceId)?.lean ?? 'center',
    wire: Boolean(config.sources.find((s) => s.id === f.sourceId)?.wire),
    link: `https://example.invalid/${f.sourceId}`,
    published: new Date(),
  }));
  const sourcesById = Object.fromEntries(config.sources.map((s) => [s.id, s]));
  const stories = buildStories(clusterItems(items), { leanWeights: config.leanWeights, sourcesById, limit: 5 });

  assert.equal(stories.length, 5);
  assert.equal(stories[0].sourceCount, 4, 'the four-outlet story should lead');
  for (let i = 1; i < stories.length; i += 1) {
    assert.ok(stories[i - 1].score >= stories[i].score, 'stories must be sorted by score');
  }
  for (const s of stories) {
    assert.ok(s.title.length > 0 && s.summary.length > 0, 'every story needs a title and summary');
    assert.ok(s.coverage.length === s.sourceCount, 'coverage list must match source count');
    assert.match(s.id, /^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/);
  }
});

test('story ids are stable across runs but differ between stories', () => {
  const build = () => {
    const items = fixture.map((f) => ({ ...f, lean: 'center', wire: false, link: 'https://e.invalid/x', published: new Date('2025-08-12T06:00:00Z') }));
    const sourcesById = Object.fromEntries(config.sources.map((s) => [s.id, s]));
    return buildStories(clusterItems(items), { leanWeights: config.leanWeights, sourcesById, limit: 5 });
  };
  const a = build();
  const b = build();
  assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
  assert.equal(new Set(a.map((s) => s.id)).size, a.length, 'ids must be unique within a digest');
});

test('source registry is well formed and politically balanced', () => {
  const ids = config.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'source ids must be unique');
  for (const s of config.sources) {
    assert.ok(s.name && s.url && s.lean, `${s.id} missing fields`);
    assert.ok(s.lean in config.leanWeights, `${s.id} has unknown lean ${s.lean}`);
    assert.doesNotThrow(() => new URL(s.url), `${s.id} has an invalid URL`);
  }
  const weight = (s) => config.leanWeights[s.lean];
  const left = config.sources.filter((s) => weight(s) < 0).length;
  const right = config.sources.filter((s) => weight(s) > 0).length;
  // A lopsided registry would make "consensus" mean "one side agreed with itself".
  assert.ok(Math.abs(left - right) <= 2, `registry is lopsided: ${left} left vs ${right} right`);
});

test('stripHtml handles feeds that escape their own markup', () => {
  // Regression: these arrived as a literal "</p>" summary in the first live digest.
  assert.equal(cleanDescription('&lt;p&gt;Real body text.&lt;/p&gt;'), 'Real body text.');
  assert.equal(cleanDescription('&lt;/p&gt;'), '');
  assert.equal(cleanDescription('&amp;lt;p&amp;gt;Double encoded&amp;lt;/p&amp;gt;'), 'Double encoded');
});

test('a story never gets a markup fragment as its summary', () => {
  const items = [
    { sourceId: 'bbc', lean: 'center', wire: true, title: 'Sword attack victim was a teenager, police say', description: '&lt;/p&gt;', link: 'https://e.invalid/1', published: new Date() },
    { sourceId: 'abc', lean: 'center-left', wire: false, title: 'Police name teenager as sword attack victim', description: '<p></p>', link: 'https://e.invalid/2', published: new Date() },
  ];
  const sourcesById = Object.fromEntries(config.sources.map((s) => [s.id, s]));
  const [story] = buildStories(clusterItems(items), { leanWeights: config.leanWeights, sourcesById, limit: 1 });
  assert.ok(!story.summary.includes('<'), `summary contained markup: ${story.summary}`);
  assert.ok(!story.summary.includes('>'), `summary contained markup: ${story.summary}`);
  assert.equal(story.summary, '', 'with no usable description the summary should be empty, not a fragment');
});

test('soft news is demoted below hard news of equal reach', () => {
  const make = (prefix, title) => ['npr', 'bbc', 'foxnews', 'guardian'].map((sourceId, i) => ({
    sourceId, lean: config.sources.find((s) => s.id === sourceId).lean,
    wire: Boolean(config.sources.find((s) => s.id === sourceId).wire),
    title: `${title} ${prefix}`,
    description: `${title} reported in detail by outlet number ${i} with enough body text to count.`,
    link: `https://e.invalid/${prefix}${i}`, published: new Date(),
  }));
  const items = [
    ...make('alpha', 'Prince Harry and Meghan search for a brand'),
    ...make('beta', 'Central bank holds benchmark interest rates steady'),
  ];
  const sourcesById = Object.fromEntries(config.sources.map((s) => [s.id, s]));
  const stories = buildStories(clusterItems(items), { leanWeights: config.leanWeights, sourcesById, limit: 2 });
  assert.equal(stories.length, 2);
  assert.match(stories[0].title, /interest rates/, 'hard news should outrank soft news at equal reach');
  assert.ok(stories[1].scoreComponents.softPenalty < 0, 'the soft story should carry a penalty');
});

// --- iOS project structure -------------------------------------------------
// These run in CI on Linux, where no Xcode exists. They cannot tell us the app
// compiles, but they catch the structural mistakes that cost a build cycle.

test('Info.plist sits outside the synchronized source folder', () => {
  // The Xcode 16 file-system-synchronized group adds every file under the source
  // folder to Copy Bundle Resources. An Info.plist there is therefore produced
  // twice - once as a copied resource, once from INFOPLIST_FILE - and the build
  // fails with "Multiple commands produce .../Info.plist".
  const syncedDir = resolve(ROOT, 'ios/MorningBrief/MorningBrief');
  const stray = readdirSync(syncedDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('Info.plist'));
  assert.deepEqual(stray, [], `Info.plist must not live inside ${syncedDir}`);
  assert.ok(existsSync(resolve(ROOT, 'ios/MorningBrief/Info.plist')), 'Info.plist should sit beside the .xcodeproj');
});

test('the Xcode project points at that Info.plist and generates no other', () => {
  const pbx = readFileSync(resolve(ROOT, 'ios/MorningBrief/MorningBrief.xcodeproj/project.pbxproj'), 'utf8');
  // The lookbehind matters: INFOPLIST_FILE is a substring of GENERATE_INFOPLIST_FILE.
  const infoplistSettings = pbx.match(/(?<![A-Z_])INFOPLIST_FILE = [^;]+;/g) ?? [];
  assert.equal(infoplistSettings.length, 2, 'expected one INFOPLIST_FILE per build configuration');
  for (const setting of infoplistSettings) {
    assert.equal(setting, 'INFOPLIST_FILE = Info.plist;');
  }
  assert.equal((pbx.match(/GENERATE_INFOPLIST_FILE = NO;/g) ?? []).length, 2,
    'both configurations must use the checked-in plist rather than a generated one');
});

test('the background task identifier is derived, not hard-coded', () => {
  // BGTaskScheduler refuses to register an identifier absent from Info.plist, and
  // that failure appears at launch on device - never at build time. Deriving both
  // sides from the bundle id means renaming the bundle cannot desynchronise them.
  const plist = readFileSync(resolve(ROOT, 'ios/MorningBrief/Info.plist'), 'utf8');
  const swift = readFileSync(resolve(ROOT, 'ios/MorningBrief/MorningBrief/Services/BackgroundRefresh.swift'), 'utf8');

  const declared = plist.match(/<key>BGTaskSchedulerPermittedIdentifiers<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.equal(declared, '$(PRODUCT_BUNDLE_IDENTIFIER).refresh',
    'Info.plist should derive the task id from the bundle id build setting');

  const usesBundleId = /taskIdentifier\s*=\s*"\\\(Bundle\.main\.bundleIdentifier/.test(swift);
  assert.ok(usesBundleId, 'BackgroundRefresh should derive taskIdentifier from Bundle.main.bundleIdentifier');
  assert.ok(/\.refresh"/.test(swift), 'the derived identifier should keep the .refresh suffix');
});

test('no source file hard-codes the bundle identifier', () => {
  // A stale literal here survives a bundle-id change and breaks silently.
  const dir = resolve(ROOT, 'ios/MorningBrief/MorningBrief');
  const offenders = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.swift'))
    .filter((f) => {
      const body = readFileSync(resolve(dir, f), 'utf8');
      // The fallback inside the derivation itself is fine; a bare literal is not.
      return /"com\.philkellner\.MorningBrief"/.test(body)
        && !/bundleIdentifier \?\? "com\.philkellner\.MorningBrief"/.test(body);
    });
  assert.deepEqual(offenders, [], 'these files hard-code the bundle identifier');
});

// --- notification delivery --------------------------------------------------

test('a stranded opening quote is dropped from a summary', () => {
  // Seen live: sentence splitting kept the opening quote of a pull quote it
  // then discarded, so the notification ended with a bare ".
  assert.equal(firstSentences('Talks collapsed. "We will respond," said the minister.', 1, 200), 'Talks collapsed.');
  assert.equal(dropDanglingOpener('Talks collapsed. "'), 'Talks collapsed.');
  assert.equal(dropDanglingOpener('A quoted "phrase" inside stays intact.'), 'A quoted "phrase" inside stays intact.');
  assert.equal(dropDanglingOpener('Balanced (parens) are fine.'), 'Balanced (parens) are fine.');
});

test('local delivery time survives daylight saving', () => {
  const timeZone = 'America/Chicago';
  const at = (year, month, day) => new Date(zonedTimeToEpoch({ year, month, day, hour: 6, timeZone })).toISOString();
  assert.equal(at(2026, 6, 15), '2026-06-15T11:00:00.000Z', 'CDT is UTC-5');
  assert.equal(at(2026, 1, 15), '2026-01-15T12:00:00.000Z', 'CST is UTC-6');
  // 2026-03-08 is the spring-forward date; a naive offset calculation lands an hour out.
  assert.equal(at(2026, 3, 8), '2026-03-08T11:00:00.000Z');
  assert.equal(at(2026, 3, 7), '2026-03-07T12:00:00.000Z');
});

test('delivery rolls to tomorrow once today\'s slot has passed', () => {
  const timeZone = 'America/Chicago';
  const fiveAm = zonedTimeToEpoch({ year: 2026, month: 6, day: 15, hour: 5, timeZone });
  const sevenAm = zonedTimeToEpoch({ year: 2026, month: 6, day: 15, hour: 7, timeZone });
  assert.equal(nextDeliveryEpoch({ now: fiveAm, hour: 6, minute: 0, timeZone }),
    zonedTimeToEpoch({ year: 2026, month: 6, day: 15, hour: 6, timeZone }), 'before the slot: today');
  assert.equal(nextDeliveryEpoch({ now: sevenAm, hour: 6, minute: 0, timeZone }),
    zonedTimeToEpoch({ year: 2026, month: 6, day: 16, hour: 6, timeZone }), 'after the slot: tomorrow');
});

test('ntfy messages carry the story, a click target and a stagger', () => {
  const digest = {
    edition: '2026-06-15',
    stories: [
      { rank: 1, id: 'a', title: 'First story', summary: 'Body one.', url: 'https://e.invalid/1', headlineSource: 'BBC News', sourceCount: 12, leanCount: 4 },
      { rank: 2, id: 'b', title: 'Second story', summary: 'Body two.', url: '', headlineSource: 'NPR', sourceCount: 3, leanCount: 2 },
    ],
  };
  const now = Date.UTC(2026, 5, 15, 10, 0, 0);
  const deliverAt = now + 3600_000;
  const msgs = buildMessages(digest, { topic: 't', deliverAt, spacingSeconds: 45, now });

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].title, 'First story');
  assert.match(msgs[0].message, /Body one\./);
  assert.match(msgs[0].message, /12 outlets · 4 leans · via BBC News/);
  assert.equal(msgs[0].click, 'https://e.invalid/1');
  assert.ok(!('click' in msgs[1]), 'a story with no url should not carry a click action');
  assert.equal(Number(msgs[1].delay) - Number(msgs[0].delay), 45, 'stories are staggered by the spacing');
});

test('ntfy refuses to broadcast the bundled sample digest', () => {
  assert.throws(() => buildMessages({ seed: true, stories: [{ rank: 1, title: 'x', summary: 'y' }] }, { topic: 't' }),
    /sample data/i);
});

test('a delay in the past is omitted rather than sent', () => {
  const now = Date.now();
  const digest = { stories: [{ rank: 1, title: 'x', summary: 'y', url: '', headlineSource: 'BBC', sourceCount: 1, leanCount: 1 }] };
  const [msg] = buildMessages(digest, { topic: 't', deliverAt: now - 60_000, now });
  assert.ok(!('delay' in msg), 'ntfy rejects a delay in the past, so it must be dropped');
});

test('empty environment variables fall back to defaults', () => {
  // GitHub Actions sets `FOO: ${{ secrets.FOO }}` to "" when the secret does not
  // exist, so an unset NTFY_SERVER arrived as an empty string and became
  // fetch(""), failing with "Failed to parse URL from".
  const withEmpties = readConfig({
    NTFY_TOPIC: 'abc', NTFY_SERVER: '', NTFY_TOKEN: '',
    NTFY_HOUR: '', NTFY_MINUTE: '', NTFY_SPACING_SECONDS: '', NTFY_PRIORITY: '',
  });
  assert.equal(withEmpties.server, 'https://ntfy.sh');
  assert.equal(withEmpties.token, null, 'an empty token must not become "Bearer "');
  // Number('') is 0, which would silently move delivery to midnight.
  assert.equal(withEmpties.hour, 6);
  assert.equal(withEmpties.spacingSeconds, 45);
  assert.equal(withEmpties.priority, 3);

  assert.deepEqual(readConfig({ NTFY_TOPIC: 'abc' }), withEmpties, 'absent and empty must behave identically');
});

test('config trims values and strips a trailing slash from the server', () => {
  const config = readConfig({ NTFY_TOPIC: '  abc  ', NTFY_SERVER: 'https://n.example.com/', NTFY_HOUR: '7' });
  assert.equal(config.topic, 'abc');
  assert.equal(config.server, 'https://n.example.com');
  assert.equal(config.hour, 7);
});

test('a non-numeric override does not silently become zero', () => {
  assert.equal(readConfig({ NTFY_TOPIC: 'a', NTFY_HOUR: 'six' }).hour, 6);
});

test('a late build recognises that its delivery slot has passed', () => {
  // GitHub has run this job as much as 10 hours behind its cron. Scheduling from
  // a late build would queue the stories for tomorrow's slot, colliding with
  // tomorrow's build and delivering a day-old brief.
  const timeZone = 'America/Chicago';
  const slotFor = (day, h) => zonedTimeToEpoch({ year: 2026, month: 9, day, hour: h, timeZone });

  assert.equal(isSlotPassed({ now: slotFor(1, 5), hour: 6, timeZone }).passed, false, '05:00 is before the slot');
  assert.equal(isSlotPassed({ now: slotFor(1, 9), hour: 6, timeZone }).passed, true, '09:00 is after it');
  assert.equal(isSlotPassed({ now: slotFor(1, 6) - 1, hour: 6, timeZone }).passed, false, 'one ms before is not passed');

  // The reported slot must be today's, not tomorrow's - that is what makes the
  // "how late are we" message meaningful.
  assert.equal(isSlotPassed({ now: slotFor(1, 9), hour: 6, timeZone }).slot, slotFor(1, 6));
});

test('slot detection holds across a daylight-saving change', () => {
  const timeZone = 'America/Chicago';
  // 2026-03-08 springs forward; 06:00 local is 11:00Z, not 12:00Z.
  const morning = zonedTimeToEpoch({ year: 2026, month: 3, day: 8, hour: 7, timeZone });
  const { passed, slot } = isSlotPassed({ now: morning, hour: 6, timeZone });
  assert.equal(passed, true);
  assert.equal(new Date(slot).toISOString(), '2026-03-08T11:00:00.000Z');
});

// --- topics -----------------------------------------------------------------

test('one newsroom with several feeds counts as one outlet', () => {
  // BBC runs world, technology, science and health feeds. Counting those as
  // four independent confirmations would inflate the number the whole ranking
  // rests on.
  const mk = (sourceId, outlet, title) => ({
    sourceId, outlet, lean: 'center', wire: false, title,
    description: `${title} reported with enough body text to be usable here.`,
    link: `https://e.invalid/${sourceId}`, published: new Date(), categories: [],
  });
  const items = [
    mk('bbc', 'bbc', 'Chip maker unveils new processor'),
    mk('bbc_tech', 'bbc', 'Chip maker unveils its new processor'),
    mk('verge', 'verge', 'New processor unveiled by chip maker'),
  ];
  const [story] = buildStories(clusterItems(items), { leanWeights: config.leanWeights, sourcesById: {}, limit: 1 });
  assert.equal(story.sourceCount, 2, 'BBC twice must count once');
  assert.equal(story.coverage.length, 2);
});

test('the classifier separates specialist stories from general news', () => {
  const item = (title, description, path) => ({ title, description, link: `https://e.com${path}x`, categories: [] });
  const cases = [
    ['world', '/world/', 'Iran says it will return to ceasefire if US does', 'Tehran signalled willingness to resume talks after weeks of strikes.'],
    ['world', '/news/', 'Supreme Court allows ballroom project to proceed', 'The justices ruled on an emergency application by the administration.'],
    ['world', '/world/', 'Aid convoy reaches northern Gaza after weeks of delays', 'Trucks carrying flour and medicine crossed into the territory.'],
    ['tech', '/technology/', 'Chip maker unveils processor built on new architecture', 'The semiconductor firm said its chips use a smaller process node.'],
    ['tech', '/science/', 'Astronomers spot most distant galaxy yet', 'Researchers used the telescope to observe light from the early universe.'],
    ['business', '/business/', 'Fed holds interest rates steady as inflation cools', 'The central bank left its benchmark rate unchanged, citing the economy.'],
    ['business', '/markets/', 'Airline profits climb on strong summer demand', 'Carriers reported higher quarterly earnings and raised guidance.'],
    ['health', '/health/', 'Study finds treatment slows Alzheimer disease', 'Researchers reported clinical trial results in patients at several hospitals.'],
    ['health', '/environment/', 'Wildfires force evacuations as heatwave intensifies', 'Climate scientists link the extreme weather to global warming.'],
  ];
  for (const [expected, path, title, description] of cases) {
    assert.equal(classifyCluster([item(title, description, path)]), expected, `misclassified: ${title}`);
  }
});

test('vocabulary alone cannot promote a story into a specialist topic', () => {
  // Every one of these was mislabelled on a live digest by a keyword-only rule,
  // and then took a specialist slot from a real tech or health story.
  const general = (title, description) => classifyCluster([
    { title, description, link: 'https://e.com/news/x', categories: [] },
  ]);
  assert.equal(general('Iran urges US to honour commitments under MoU',
    'Tehran said the economy and sanctions relief were central to the agreement.'), DEFAULT_TOPIC);
  assert.equal(general('Nepal families post photos of missing relatives',
    'Flooding and landslides have left hundreds unaccounted for after extreme weather.'), DEFAULT_TOPIC);
  assert.equal(general('Court says India must uphold Pakistan water treaty',
    'The ruling concerns river flows and environment obligations between the two states.'), DEFAULT_TOPIC);
});

test('a topic-scoped feed outranks bland wording', () => {
  const bland = { title: 'Company announces annual results', description: 'No obvious vocabulary here at all.', link: 'https://e.com/x', categories: [] };
  assert.equal(classifyCluster([bland]), DEFAULT_TOPIC);
  assert.equal(classifyCluster([{ ...bland, topicHint: 'business' }]), 'business');
});

test('one stray keyword does not reclassify general news', () => {
  // "economy" in a diplomatic story must not make it business.
  const item = {
    title: 'Leaders meet for talks on regional security',
    description: 'The summit also touched on the economy, officials said.',
    link: 'https://e.com/world/x', categories: [],
  };
  assert.equal(classifyCluster([item]), DEFAULT_TOPIC);
});

test('quotas give each topic its slots', () => {
  const entry = (topic, total, distinctSources = 3) => ({ topic, score: { total, distinctSources } });
  const ranked = [
    entry('world', 30), entry('world', 29), entry('world', 28), entry('world', 27),
    entry('world', 26), entry('world', 25), entry('world', 24),
    entry('tech', 12), entry('tech', 11),
    entry('business', 10), entry('business', 9),
    entry('health', 8), entry('health', 7),
  ];
  const chosen = selectByQuota(ranked, { quotas: { world: 4, tech: 2, business: 2, health: 2 }, limit: 10 });
  const counts = {};
  for (const c of chosen) counts[c.topic] = (counts[c.topic] ?? 0) + 1;
  assert.equal(chosen.length, 10);
  assert.deepEqual(counts, { world: 4, tech: 2, business: 2, health: 2 });
  // Without quotas the seven world stories would have taken seven of ten slots.
  assert.ok(chosen.every((c, i, a) => i === 0 || a[i - 1].score.total >= c.score.total), 'output stays score-ordered');
});

test('an empty topic gives its slots back rather than padding', () => {
  const entry = (topic, total, distinctSources = 3) => ({ topic, score: { total, distinctSources } });
  const ranked = [
    entry('world', 30), entry('world', 29), entry('world', 28), entry('world', 27),
    entry('world', 26), entry('world', 25),
    entry('tech', 12), entry('tech', 11),
    // Health has only a single-source story: below the floor, so not worth a slot.
    entry('health', 9, 1),
  ];
  const chosen = selectByQuota(ranked, { quotas: { world: 4, tech: 2, business: 2, health: 2 }, limit: 8, minSources: 2 });
  const counts = {};
  for (const c of chosen) counts[c.topic] = (counts[c.topic] ?? 0) + 1;
  assert.equal(chosen.length, 8);
  assert.equal(counts.world, 6, 'unused business and health slots go to the next-best stories');
  assert.ok(!counts.business);
});

test('the registry stays balanced as topic feeds are added', () => {
  const weight = (s) => config.leanWeights[s.lean];
  const left = config.sources.filter((s) => weight(s) < 0).length;
  const right = config.sources.filter((s) => weight(s) > 0).length;
  assert.ok(Math.abs(left - right) <= 2, `lopsided: ${left} left vs ${right} right`);

  // Feed ids must be unique; outlets deliberately are not.
  const ids = config.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate feed id');

  // Every topic needs enough outlets that consensus means something.
  const byTopic = {};
  for (const s of config.sources) {
    const t = s.topic ?? 'general';
    (byTopic[t] ??= new Set()).add(s.outlet);
  }
  for (const topic of ['tech', 'business', 'health']) {
    assert.ok(byTopic[topic]?.size >= 6, `${topic} has only ${byTopic[topic]?.size ?? 0} outlets`);
  }
});

test('a lone specialist desk among many general outlets does not reclassify', () => {
  // Both of these shipped in a live digest wearing the wrong topic, and each
  // consumed a specialist slot that a real tech or health story should have had.
  const item = (outlet, path, title, description) => ({
    outlet, link: `https://e.com${path}a`, title, description, categories: [],
  });

  const iran = [...Array(11)].map((_, i) => item(`gen${i}`, '/world/',
    'Iran urges US to honour commitments under MoU',
    'Tehran said the economy and sanctions relief were central to the agreement.'));
  iran.push(item('bloomberg', '/markets/', 'Iran urges US to honour MoU commitments',
    'Sanctions relief and the economy were central.'));
  assert.equal(classifyCluster(iran), DEFAULT_TOPIC, 'one business desk of twelve is still world news');

  const nepal = [...Array(8)].map((_, i) => item(`gen${i}`, '/world/',
    'Nepal families post photos of missing relatives',
    'Flooding and landslides have left hundreds unaccounted for.'));
  nepal.push(item('guardian', '/environment/', 'Nepal floods leave hundreds missing',
    'Extreme weather and landslides across the region.'));
  assert.equal(classifyCluster(nepal), DEFAULT_TOPIC, 'one environment desk of nine is still world news');
});

test('specialist desks dominating the coverage do reclassify', () => {
  const item = (outlet, path, title) => ({
    outlet, link: `https://e.com${path}a`, title,
    description: 'The company confirmed the change in a statement to staff.', categories: [],
  });
  const apple = [...Array(3)].map((_, i) => item(`gen${i}`, '/news/', 'Apple names new chief executive'));
  for (const outlet of ['verge', 'arstechnica', 'bbc', 'nytimes', 'wsj']) {
    apple.push(item(outlet, '/technology/', 'Apple names Ternus as chief executive'));
  }
  assert.equal(classifyCluster(apple), 'tech', 'five tech desks of eight is a tech story');

  // A small story carried only by specialists still classifies.
  assert.equal(classifyCluster([
    item('verge', '/technology/', 'Chip maker unveils processor'),
    item('arstechnica', '/technology/', 'Chipmaker reveals new processor'),
  ]), 'tech');
});

test('headline-labelled commentary is excluded like sectioned opinion', () => {
  // Carbon Brief publishes "Guest post:" pieces under its normal news path, so
  // the section filter cannot see them. One reached rank 10 of a live digest.
  const EXCLUDED_TITLE = [
    /^\s*guest post\b/i, /^\s*analysis:/i, /^\s*explainer:/i, /^\s*q&a:/i,
    /^\s*comment:/i, /^\s*viewpoint:/i, /^\s*debriefed\b/i,
  ];
  const excluded = (title) => EXCLUDED_TITLE.some((re) => re.test(title));
  assert.ok(excluded('Guest post: Why tough methane cuts are crucial'));
  assert.ok(excluded('Analysis: What the ruling means'));
  assert.ok(!excluded('Methane cuts agreed at climate summit'), 'reported news must survive');
  assert.ok(!excluded('Guests arrive for the state dinner'), 'the word alone is not the label');
});

test('the chosen headline must describe the story, not merely avoid framing', () => {
  // Shipped live: a nine-outlet G20 trade story went out as "China's corruption
  // investigation procedures". That headline has no loaded words, no
  // punctuation, and came from a wire desk, so it scored perfectly on
  // sensationalism alone - while carrying almost no information.
  const item = (wire, title) => ({ wire, title });
  const cluster = [
    item(false, "China dissented from G20 statement opposing 'cheap exports' flooding markets"),
    item(false, "Bessent vows to 'asphyxiate' Iran economically, warns regime's offshore assets"),
    item(true, 'G20 backs final statement despite Russia tensions, China dissent'),
    item(false, 'At G20 Meeting, Scott Bessent Accuses China of Flooding the World With Cheap Goods'),
    item(true, "China dissents as Bessent says 19 finance ministers agree to address 'cheap exports'"),
    item(true, 'China\u2019s corruption investigation procedures'),
    item(false, 'Scott Bessent pitches Trump-inspired finance competition at G20 ministerial'),
    item(true, 'G20 finance chiefs \u2014 except China \u2014 back action on distorted trade'),
    item(true, 'China prevented G-20 communique over imbalance trade spat, says US Bessent'),
  ];

  const core = coreTerms(cluster);
  assert.ok(core.has('china') && core.has('g20'), `core terms were ${[...core].join(',')}`);

  const chosen = pickHeadline(cluster);
  assert.ok(!/corruption investigation procedures/.test(chosen.title),
    `picked the uninformative headline: ${chosen.title}`);
  assert.ok(/g20/i.test(chosen.title) && /china/i.test(chosen.title),
    `chosen headline should carry the shared terms: ${chosen.title}`);

  assert.ok(representativeness('China\u2019s corruption investigation procedures', core)
    < representativeness('At G20 Meeting, Scott Bessent Accuses China of Flooding the World With Cheap Goods', core));
});

test('the summary comes from a member that is about the same story', () => {
  // The same digest paired that G20 headline with a sentence about the Strait
  // of Hormuz, lifted from the one cluster member covering something else.
  const item = (title, description) => ({ wire: true, title, description });
  const cluster = [
    item('China dissents at G20 over cheap exports', 'Finance ministers at the G20 agreed to address cheap exports flooding world markets, with China dissenting from the statement.'),
    item('G20 finance chiefs back action on distorted trade', 'The G20 communique on trade imbalances was backed by every delegation except China, officials said afterwards.'),
    item('Bessent vows to asphyxiate Iran economically', 'He said the US and China agree on the importance of keeping the Strait of Hormuz open to shipping traffic.'),
  ];
  const summary = pickSummary(cluster, cluster[0]);
  assert.ok(!/Hormuz/.test(summary.text), `summary drifted off-story: ${summary.text}`);
  assert.match(summary.text, /G20|trade|exports/i);
});

test('a summary must be about the same story as the headline shown', () => {
  // Both shipped in a live brief. An over-merged cluster agrees on little or
  // nothing, which is exactly when cluster-level agreement stops being a useful
  // reference - the earlier guard returned "fully representative" for an empty
  // core and so disabled itself in the case that needed it most.
  const item = (title, description) => ({ wire: true, sourceId: title.slice(0, 6), title, description });

  const advocacy = [
    item('Protect Our Care targeting 29 House Republicans',
      'The advocacy group said it would run advertising against 29 House Republicans over health coverage votes.'),
    item('Beef tariff plan draws cattle industry uproar',
      "Trump's plan to lower tariffs on 300,000 metric tons of imported beef caused an uproar among cattle producers."),
  ];
  assert.ok(!/beef|cattle/i.test(pickSummary(advocacy, advocacy[0]).text),
    'a beef-tariff summary must not appear under a health-advocacy headline');

  // Two unrelated Japan stories merge on the single shared term "japan", which
  // both candidates match perfectly - so the preference for a second outlet
  // decided it, and decided wrong.
  const japan = [
    item('Japan developing GPS-based app to locate nationals overseas',
      'The government said the application would help track citizens abroad during emergencies.'),
    item('Japan to transfer ageing warships to Philippines',
      "Japan's plans to transfer ageing warships to the Philippines and Indonesia could turn older hardware into leverage."),
  ];
  assert.ok(!/warship/i.test(pickSummary(japan, japan[0]).text),
    'a warships summary must not appear under a GPS-app headline');
});

test('a coherent cluster still takes its summary from a second outlet', () => {
  // The guard must not collapse into "always quote the headline's own outlet",
  // which would lose the cross-outlet framing the summary exists to provide.
  const cluster = [
    { wire: false, sourceId: 'nyt', title: 'At G20 Meeting, Bessent Accuses China of Flooding World With Cheap Goods',
      description: 'The Treasury secretary used the G20 meeting to accuse China of flooding world markets with cheap goods.' },
    { wire: true, sourceId: 'f24', title: 'G20 backs statement despite China dissent',
      description: 'G20 finance ministers backed a final statement on cheap exports and trade imbalances, with China dissenting.' },
  ];
  const summary = pickSummary(cluster, cluster[0]);
  assert.equal(summary.sourceId, 'f24', 'summary should come from the outlet that did not supply the headline');
});
