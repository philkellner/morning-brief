// Run with: node --test scripts/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripHtml, cleanDescription, truncate, tokenize, entities, stem, firstSentences } from './lib/text.mjs';
import { parseFeed, cleanUrl } from './lib/rss.mjs';
import { clusterItems } from './lib/cluster.mjs';
import { sensationalism, pickHeadline, leanSpread, buildStories } from './lib/rank.mjs';

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

test('the background task identifier matches the bundle identifier', () => {
  // BGTaskScheduler refuses to register an identifier absent from the plist, and
  // the failure only shows up at runtime on a device.
  const plist = readFileSync(resolve(ROOT, 'ios/MorningBrief/Info.plist'), 'utf8');
  const swift = readFileSync(resolve(ROOT, 'ios/MorningBrief/MorningBrief/Services/BackgroundRefresh.swift'), 'utf8');
  const declared = plist.match(/<key>BGTaskSchedulerPermittedIdentifiers<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];
  const used = swift.match(/taskIdentifier\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(declared, 'Info.plist must declare BGTaskSchedulerPermittedIdentifiers');
  assert.equal(used, declared, 'the identifier in Swift must match the one declared in Info.plist');

  const pbx = readFileSync(resolve(ROOT, 'ios/MorningBrief/MorningBrief.xcodeproj/project.pbxproj'), 'utf8');
  const bundleId = pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)?.[1];
  assert.ok(declared.startsWith(bundleId), `background task id ${declared} must be prefixed by bundle id ${bundleId}`);
});
