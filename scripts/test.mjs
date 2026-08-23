// Run with: node --test scripts/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
