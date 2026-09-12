#!/usr/bin/env node
// Records a story from a past brief as a permanent labelled case.
//
//   npm run flag -- 2026-09-12 9 --id cardiac-research-is-health --expect topic=health
//   npm run flag -- latest 3 --id some-slug --expect clusters=2 --expect summaryNot=warship
//   npm run flag -- 2026-09-12 5 --id opinion-slipped --expect excluded=true --note "why it is wrong"
//
// Copies the story's raw cluster members into scripts/fixtures/reported.json with
// the verdict you assert, then runs it. A freshly flagged case is EXPECTED to
// fail: that failure is the bug report, and it turns green when the heuristic is
// fixed - and stays green forever after, which is the point.
//
// Verdicts: topic=<t>  clusters=<n>  excluded=true  kept=true
//           headlineNot=<regex>  summaryNot=<regex>  headlineIndex=<n>

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase } from './lib/reported.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = resolve(ROOT, 'docs/archive');
const CASES = resolve(ROOT, 'scripts/fixtures/reported.json');

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] ?? '').startsWith('--'));
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : null; };
const flagAll = (name) => argv.reduce((acc, a, i) => (a === `--${name}` ? [...acc, argv[i + 1]] : acc), []);

const [editionArg, selector] = positional;
const id = flag('id');
const expectArgs = flagAll('expect');

if (!editionArg || !selector || !id || expectArgs.length === 0) {
  console.error('usage: npm run flag -- <edition|latest> <rank> --id <slug> --expect <verdict> [--note "..."]');
  console.error('verdicts: topic=world clusters=2 excluded=true kept=true headlineNot=<re> summaryNot=<re> headlineIndex=<n>');
  process.exit(2);
}

const BOOLEAN = new Set(['excluded', 'kept']);
const NUMERIC = new Set(['clusters', 'headlineIndex']);
const KNOWN = new Set([...BOOLEAN, ...NUMERIC, 'topic', 'headlineNot', 'summaryNot']);

const expect = {};
for (const raw of expectArgs) {
  const [key, ...rest] = String(raw).split('=');
  const value = rest.join('=');
  if (!KNOWN.has(key)) { console.error(`Unknown verdict "${key}". Known: ${[...KNOWN].join(', ')}`); process.exit(2); }
  if (!value) { console.error(`Verdict "${key}" needs a value, as ${key}=...`); process.exit(2); }
  if (BOOLEAN.has(key)) expect[key] = value === 'true';
  else if (NUMERIC.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n)) { console.error(`Verdict ${key} needs a number, got "${value}"`); process.exit(2); }
    expect[key] = n;
  } else expect[key] = value;
}

let edition = editionArg;
if (edition === 'latest') {
  const files = (await readdir(ARCHIVE)).filter((f) => f.endsWith('.detail.json')).sort();
  if (files.length === 0) { console.error('No detail archives yet; they are written from the next build onward.'); process.exit(1); }
  edition = files.at(-1).replace('.detail.json', '');
}

let detail;
try {
  detail = JSON.parse(await readFile(resolve(ARCHIVE, `${edition}.detail.json`), 'utf8'));
} catch {
  console.error(`No detail archive for ${edition}.`);
  process.exit(1);
}

const story = /^\d+$/.test(selector)
  ? detail.stories.find((s) => s.rank === Number(selector))
  : detail.stories.find((s) => s.title.toLowerCase().includes(selector.toLowerCase()));
if (!story) { console.error(`No story matching "${selector}" in ${edition}.`); process.exit(1); }

const doc = JSON.parse(await readFile(CASES, 'utf8'));
if (doc.cases.some((c) => c.id === id)) { console.error(`A case named "${id}" already exists.`); process.exit(1); }

const testCase = {
  id,
  reported: edition,
  note: flag('note') ?? `Flagged from ${edition} rank ${story.rank}: "${story.title}" came out as topic=${story.topic}.`,
  expect,
  items: story.members.map(({ published, ...rest }) => ({ ...rest, published })),
};

doc.cases.push(testCase);
await writeFile(CASES, `${JSON.stringify(doc, null, 2)}\n`);

const result = runCase(testCase);
console.log(`\nRecorded "${id}" from ${edition} rank ${story.rank} (${testCase.items.length} members).`);
console.log(`  ${story.title}`);
console.log(`  verdict: ${Object.entries(expect).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log();
if (result.ok) {
  console.log('This case ALREADY PASSES. Either the heuristics changed since the brief,');
  console.log('or the verdict does not capture what was wrong. Check with:');
  console.log(`  npm run triage -- ${edition} ${story.rank}`);
} else {
  console.log('FAILS as expected - this is the bug report:');
  for (const f of result.failures) console.log(`  ${f}`);
  console.log('\nFix the heuristic, then `npm run eval` until every case passes.');
}
