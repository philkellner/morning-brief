// Minimal RSS 2.0 / RDF / Atom parser. Regex-based on purpose: the alternative is a
// dependency, and feed XML here is only ever read for a handful of known fields.

import { decodeEntities, stripHtml } from './text.mjs';

/** Pull the text content of the first matching tag, unwrapping CDATA. */
function tag(xml, ...names) {
  for (const name of names) {
    const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i');
    const m = xml.match(re);
    if (!m) continue;
    const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    const value = (cdata ? cdata[1] : m[1]).trim();
    if (value) return value;
  }
  return '';
}

/** Atom links live in an attribute, and feeds often carry several rel types. */
function atomLink(xml) {
  const links = [...xml.matchAll(/<(?:\w+:)?link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const attrs = (s) => Object.fromEntries(
    [...s.matchAll(/(\w+)\s*=\s*["']([^"']*)["']/g)].map((m) => [m[1].toLowerCase(), m[2]]),
  );
  const parsed = links.map(attrs).filter((a) => a.href);
  const alternate = parsed.find((a) => !a.rel || a.rel === 'alternate');
  return decodeEntities((alternate ?? parsed[0])?.href ?? '');
}

const TRACKING_PARAMS = [
  /^utm_/i, /^ito$/i, /^cmp$/i, /^cmpid$/i, /^smid$/i, /^smtyp$/i, /^partner$/i,
  /^fbclid$/i, /^gclid$/i, /^msclkid$/i, /^igshid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^ns_/i, /^at_/i, /^__twitter/i, /^ref$/i, /^referrer$/i, /^source$/i,
  /^spm$/i, /^xtor$/i, /^ocid$/i, /^taid$/i, /^sh$/i, /^srnd$/i, /^guccounter$/i,
];

/** Drop analytics query params so the stored link is the plain article URL. */
export function cleanUrl(raw) {
  const input = decodeEntities(String(raw ?? '')).trim();
  if (!input) return '';
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    u.hash = '';
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return '';
  }
}

function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Parse a feed document into normalised entries.
 * Unknown or malformed blocks are skipped rather than throwing - one bad item
 * must never cost us the rest of the feed.
 */
export function parseFeed(xml) {
  const doc = String(xml ?? '');
  const blocks = [
    ...doc.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...doc.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const items = [];
  for (const block of blocks) {
    try {
      const title = stripHtml(tag(block, 'title'));
      if (!title) continue;
      const link = cleanUrl(tag(block, 'link', 'guid', 'id') || atomLink(block));
      const description = tag(block, 'description', 'summary', 'subtitle')
        || tag(block, 'encoded')
        || tag(block, 'content');
      const published = parseDate(
        tag(block, 'pubDate', 'published', 'updated', 'date', 'created'),
      );
      const categories = [...block.matchAll(/<(?:\w+:)?category(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?category>/gi)]
        .map((m) => stripHtml(m[1]))
        .filter(Boolean);
      items.push({ title, link, description, published, categories });
    } catch {
      // Skip the malformed entry, keep the feed.
    }
  }
  return items;
}
