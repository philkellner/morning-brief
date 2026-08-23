// Text normalisation helpers. No dependencies - Node 20+ only.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', trade: '™', copy: '©', reg: '®', deg: '°',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', pound: '£',
  euro: '€', middot: '·', bull: '•', laquo: '«', raquo: '»',
};

/** Decode numeric and the common named HTML entities, applied repeatedly for double-encoding. */
export function decodeEntities(input) {
  let out = String(input ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
      .replace(/&([a-z]+[0-9]*);/gi, (m, name) => {
        const hit = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
        return hit === undefined ? m : hit;
      });
    if (out === before) break;
  }
  return out;
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  // Lone surrogates would corrupt the JSON payload the app parses.
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/**
 * Strip markup, decode entities, collapse whitespace.
 *
 * Stripping and decoding are interleaved, not sequential: plenty of feeds escape
 * their own markup, so `&lt;/p&gt;` only becomes a visible tag after a decode
 * pass. Decoding once at the end would leave literal "</p>" in the summary.
 */
export function stripHtml(input) {
  let out = String(input ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = decodeEntities(
      out
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/p>/gi, ' ')
        .replace(/<[^>]*>/g, ' '),
    );
    if (out === before) break;
  }
  return out
    .replace(/\s+/g, ' ')
    // Inline tags leave a gap before possessives and punctuation; close it back up.
    .replace(/\s+([’'](?:s|t|re|ve|ll|d)\b)/gi, '$1')
    .replace(/\s+([,.;:!?%)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .trim();
}

// Boilerplate that syndication feeds routinely append to descriptions.
const BOILERPLATE = [
  /\bcontinue reading\b.*$/i,
  /\bread more\b\s*[:.…]?\s*$/i,
  /the post .* appeared first on .*$/i,
  /\[\s*…\s*\]\s*$/,
  /\bappeared first on\b.*$/i,
  /^\s*(?:by\s+[A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}\s*[|—-]\s*)/,
  /\bclick here\b.*$/i,
  /\bsubscribe\b\s+to\s+.*$/i,
  /\bsign up for\b.*$/i,
  /\bphoto:.*$/i,
  /\((?:Reuters|AP|AFP|Bloomberg)\)\s*[-–—]?\s*/i,
];

/** Clean a feed description into plain prose suitable for a notification body. */
export function cleanDescription(input) {
  let text = stripHtml(input);
  for (const re of BOILERPLATE) text = text.replace(re, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis only when text was removed. */
export function truncate(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.–—-]+$/, '');
  return `${base}…`;
}

/** Keep at most `count` sentences, then hard-cap the length. */
export function firstSentences(text, count, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const parts = s.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [s];
  const joined = parts.slice(0, count).join(' ').replace(/\s+/g, ' ').trim();
  return truncate(joined, maxChars);
}

const STOPWORDS = new Set(`a about after again against all also am an and any are as at be because been before
being below between both but by can cant could did do does doing down during each few for from further had has
have having he her here hers herself him himself his how i if in into is it its itself just me more most my
myself no nor not now of off on once only or other our ours out over own said same she should so some such than
that the their theirs them themselves then there these they this those through to too under until up very was
we were what when where which while who whom why will with would you your yours yourself amid amid new news
says say update updates live latest report reports according first second third one two get got make made
year years day days week weeks month months time times back may might must shall since upon via while within
without across among around before behind beyond during near toward towards`.split(/\s+/));

/**
 * Light suffix stemmer. Not linguistically rigorous - it only needs to make
 * "tariff"/"tariffs", "import"/"imported" and "duty"/"duties" collide, since
 * outlets covering one event rarely inflect the key nouns identically.
 */
export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Tokenise for similarity: lowercase alphanumeric words, stopwords and 1-2 char noise removed. */
export function tokenize(text) {
  const raw = stripHtml(text)
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/);
  const out = [];
  for (const t of raw) {
    if (!t || t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t) && t.length < 4) continue; // bare small numbers carry no topic signal
    out.push(stem(t));
  }
  return out;
}

/**
 * Capitalised runs from the original casing - a cheap proper-noun proxy.
 * Emits both the full phrase and its component words, so "Federal Reserve"
 * still matches "US Federal Reserve". Sentence-initial words are kept: IDF
 * already discounts words that show up in every headline, and dropping them
 * loses the subject of any headline that leads with it ("Japan issues...").
 */
export function entities(text) {
  const clean = stripHtml(text);
  const found = new Set();
  const re = /\b([A-Z][\w'&.-]*(?:\s+(?:of|de|del|van|von|der|and|the)\s+[A-Z][\w'&.-]*|\s+[A-Z][\w'&.-]*)*)/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const phrase = m[1].trim();
    const norm = phrase.toLowerCase();
    if (norm.length >= 3 && !STOPWORDS.has(norm)) found.add(norm);
    if (phrase.includes(' ')) {
      for (const word of norm.split(/\s+/)) {
        if (word.length >= 3 && !STOPWORDS.has(word)) found.add(word);
      }
    }
  }
  return [...found];
}
