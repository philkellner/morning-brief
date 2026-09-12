#!/usr/bin/env node
// Explains why a story in a past brief came out the way it did.
//
//   npm run triage -- 2026-09-12 9          by edition and rank
//   npm run triage -- 2026-09-12 heart      by a substring of the headline
//   npm run triage -- latest 3
//
// Prints every raw cluster member with the signals each heuristic saw, so a
// wrong topic, headline or summary can be traced to the rule responsible
// instead of guessed at.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewsworthy } from './lib/filter.mjs';
import { opinionScore, looksLikeOpinion } from './lib/opinion.mjs';
import { scoreItemTopics, classifyCluster } from './lib/topics.mjs';
import { sensationalism, coreTerms, representativeness, pickHeadline, pickSummary } from './lib/rank.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = resolve(ROOT, 'docs/archive');

const [editionArg, selector] = process.argv.slice(2);
if (!editionArg || !selector) {
  console.error('usage: npm run triage -- <edition|latest> <rank|headline-substring>');
  process.exit(2);
}

let edition = editionArg;
if (edition === 'latest') {
  const files = (await readdir(ARCHIVE)).filter((f) => f.endsWith('.detail.json')).sort();
  if (files.length === 0) { console.error('No detail archives yet. They are written from the next build onward.'); process.exit(1); }
  edition = files.at(-1).replace('.detail.json', '');
}

let detail;
try {
  detail = JSON.parse(await readFile(resolve(ARCHIVE, `${edition}.detail.json`), 'utf8'));
} catch {
  console.error(`No detail archive for ${edition}. Available: ${(await readdir(ARCHIVE)).filter((f) => f.endsWith('.detail.json')).map((f) => f.replace('.detail.json', '')).join(', ') || 'none'}`);
  process.exit(1);
}

const story = /^\d+$/.test(selector)
  ? detail.stories.find((s) => s.rank === Number(selector))
  : detail.stories.find((s) => s.title.toLowerCase().includes(selector.toLowerCase()));

if (!story) {
  console.error(`No story matching "${selector}" in ${edition}. Stories:`);
  for (const s of detail.stories) console.error(`  ${s.rank}. [${s.topic}] ${s.title.slice(0, 62)}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const hydrated = story.members.map((m) => ({ ...m, published: m.published ? new Date(m.published) : new Date() }));

console.log(`\n${edition}  rank ${story.rank}  topic=${story.topic}  outlets=${story.sourceCount}  score=${story.score}`);
console.log(`  headline: ${story.title}`);
console.log(`  summary:  ${story.summary}`);
console.log(`  score:    ${JSON.stringify(story.scoreComponents)}`);

// --- what the filters thought -------------------------------------------------
console.log('\nMEMBERS  (would the filters admit it, and does it read as commentary?)');
console.log(`  ${pad('feed', 16)}${pad('outlet', 14)}${pad('hint', 9)}${pad('admit', 7)}${pad('opinion', 9)}${pad('sensat', 8)}path`);
for (const m of hydrated) {
  let path = '';
  try { path = new URL(m.link).pathname; } catch { path = '(unparseable)'; }
  console.log(`  ${pad(m.sourceId, 16)}${pad(m.outlet, 14)}${pad(m.topicHint ?? '-', 9)}${pad(isNewsworthy(m) ? 'yes' : 'NO', 7)}${pad(opinionScore(m.title) + (looksLikeOpinion(m.title) ? ' DROP' : ''), 9)}${pad(sensationalism(m.title).toFixed(1), 8)}${path.slice(0, 44)}`);
  console.log(`  ${' '.repeat(16)}${m.title.slice(0, 92)}`);
}

// --- how the topic was decided ------------------------------------------------
const admitted = hydrated.filter(isNewsworthy);
const outlets = new Map();
for (const m of admitted) {
  if (!outlets.has(m.outlet)) outlets.set(m.outlet, new Set());
  const scores = scoreItemTopics(m);
  for (const [topic, ev] of Object.entries(scores)) if (ev.provenance > 0) outlets.get(m.outlet).add(topic);
}
const votes = { tech: 0, business: 0, health: 0 };
for (const set of outlets.values()) for (const t of set) votes[t] += 1;

console.log(`\nTOPIC  (a specialist claim needs 2 desks, or every outlet, and >=50% share)`);
console.log(`  distinct outlets admitted: ${outlets.size}`);
for (const [topic, count] of Object.entries(votes)) {
  const share = outlets.size ? count / outlets.size : 0;
  console.log(`  ${pad(topic, 10)}desks=${pad(count, 4)}share=${pad(share.toFixed(2), 7)}${count >= 2 || (count > 0 && count === outlets.size) ? (share >= 0.5 ? 'qualifies' : 'share too low') : 'too few desks'}`);
}
console.log(`  decision: ${classifyCluster(admitted)}`);

// --- headline and summary selection -------------------------------------------
if (admitted.length > 0) {
  const core = coreTerms(admitted);
  console.log(`\nHEADLINE  (core terms the outlets agree on: ${[...core].join(', ') || 'none'})`);
  const scored = admitted
    .map((m) => ({ m, rep: representativeness(m.title, core), sens: sensationalism(m.title) }))
    .sort((a, b) => (b.rep - a.rep) || (a.sens - b.sens));
  for (const { m, rep, sens } of scored) {
    console.log(`  rep=${rep.toFixed(2)} sens=${sens.toFixed(1)} ${m.wire ? 'wire ' : '     '}${m.title.slice(0, 74)}`);
  }
  const chosen = pickHeadline(admitted);
  console.log(`  chosen: ${chosen.title.slice(0, 84)}`);
  const summary = pickSummary(admitted, chosen);
  console.log(`\nSUMMARY\n  from ${summary.sourceId ?? '(none matched the headline)'}: ${summary.text.slice(0, 150)}`);
}

console.log(`\nTo record this as a permanent case:\n  npm run flag -- ${edition} ${story.rank} --id <slug> --expect <verdict>\n`);
