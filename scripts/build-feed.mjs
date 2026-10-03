#!/usr/bin/env node
// Regenerates docs/feed.xml from the digest already on disk, without fetching.
//
//   npm run feed
//
// The daily build writes both together, so this is for the times only the feed
// needs rebuilding: the site's domain changed, or the feed format did, and
// waiting for tomorrow's digest would leave readers on a stale document.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAtom } from './lib/feed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.env.SITE_URL ?? 'https://philk.dev/morning-brief/';
const siteUrl = raw.endsWith('/') ? raw : `${raw}/`;

const digest = JSON.parse(await readFile(resolve(ROOT, 'docs/digest.json'), 'utf8'));
const atom = buildAtom(digest, { siteUrl, feedUrl: new URL('feed.xml', siteUrl).toString() });
await writeFile(resolve(ROOT, 'docs/feed.xml'), atom);

console.log(`Rebuilt docs/feed.xml for edition ${digest.edition} (${digest.stories.length} entries) at ${siteUrl}`);
