#!/usr/bin/env node
// Checks every feed in sources.json and reports which are usable.
// Feeds move and die; run this whenever the digest looks thin.
//
//   node scripts/probe-feeds.mjs [--json]

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed } from './lib/rss.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'morning-brief/1.0 (+https://github.com/philkellner/morning-brief)';
const asJson = process.argv.includes('--json');

const { sources } = JSON.parse(await readFile(resolve(ROOT, 'sources.json'), 'utf8'));

const probe = async (source) => {
  const started = Date.now();
  try {
    const res = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const body = await res.text();
    const items = res.ok ? parseFeed(body).length : 0;
    return { id: source.id, name: source.name, lean: source.lean, ok: res.ok && items > 0, status: res.status, items, ms: Date.now() - started };
  } catch (e) {
    return { id: source.id, name: source.name, lean: source.lean, ok: false, status: 'ERR', items: 0, error: String(e.message ?? e).slice(0, 80), ms: Date.now() - started };
  }
};

const results = await Promise.all(sources.map(probe));
const working = results.filter((r) => r.ok);
const broken = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ working, broken }, null, 2));
} else {
  console.log(`\nWORKING (${working.length})`);
  for (const r of working.sort((a, b) => b.items - a.items)) {
    console.log(`  ${r.id.padEnd(14)} ${String(r.items).padStart(3)} items  ${String(r.ms).padStart(5)}ms  ${r.lean}`);
  }
  console.log(`\nBROKEN (${broken.length})`);
  for (const r of broken) {
    console.log(`  ${r.id.padEnd(14)} ${String(r.status).padEnd(5)} ${r.error ?? 'no items parsed'}`);
  }
  const byLean = {};
  for (const r of working) byLean[r.lean] = (byLean[r.lean] ?? 0) + 1;
  console.log(`\n${working.length}/${results.length} usable. Working sources by lean:`, byLean);
  if (broken.length) console.log('\nRemove or replace broken entries in sources.json.');
}

process.exit(working.length >= 5 ? 0 : 1);
