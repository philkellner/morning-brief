#!/usr/bin/env node
// Reports on every labelled case reported from a real brief.
//
//   npm run eval            summary
//   npm run eval -- -v      include each case's note

import { loadReported, runCase } from './lib/reported.mjs';

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
const cases = loadReported();
const results = cases.map(runCase);
const failed = results.filter((r) => !r.ok);

for (const [index, result] of results.entries()) {
  const source = cases[index];
  const verdict = Object.entries(source.expect ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${result.ok ? '  ok  ' : 'FAIL  '}${result.id.padEnd(34)}${verdict}`);
  if (verbose) console.log(`        ${source.note}`);
  for (const failure of result.failures) console.log(`        ${failure}`);
}

console.log(`\n${results.length - failed.length}/${results.length} reported cases pass`);
if (failed.length > 0) {
  console.log('\nA failing case means a heuristic regressed on a story that reached a real brief.');
  process.exit(1);
}
