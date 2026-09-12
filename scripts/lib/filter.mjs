// What never belongs in the brief.
//
// Extracted from the build script so the accumulated labelled cases can assert
// against it directly: "this item should have been dropped" is one of the
// verdicts a flagged story can carry.

import { stripHtml } from './text.mjs';
import { looksLikeOpinion, OPINION_PATHS } from './opinion.mjs';

// Sections that are commentary, listings, or lifestyle rather than reported news.
export const EXCLUDED_PATH = new RegExp([
  'opinion', 'commentisfree', 'editorial', 'voices', 'columnists', 'letters',
  'blogs?', 'sport', 'sports', 'football', 'soccer', 'nfl', 'nba', 'mlb',
  'entertainment', 'celebrity', 'showbiz', 'arts', 'lifestyle', 'style',
  'travel', 'food', 'recipes', 'horoscopes?', 'puzzles?', 'crossword',
  'obituaries', 'weather', 'shopping', 'deals', 'coupons', 'gaming',
].map((s) => `/${s}/`).join('|'), 'i');

export const EXCLUDED_TITLE = [
  /\blive updates?\b/i, /\bphotos? of the (?:day|week)\b/i, /\bin pictures\b/i,
  /\bpodcast\b/i, /\bquiz\b/i, /\bcrossword\b/i, /\bnewsletter\b/i,
  /\bwatch live\b/i, /\bmorning briefing\b/i, /\bwhat to watch\b/i,
  /\byour (?:daily|morning|evening)\b/i, /\brecap\b/i, /\bhoroscope\b/i,
  // Specialist outlets label their commentary in the headline. Carbon Brief's
  // "Guest post:" reached rank 10 of a live digest: it is an opinion piece, and
  // opinion is excluded everywhere else by section path, which these bypass
  // because they sit under the same path as the outlet's reporting.
  /^\s*guest post\b/i, /^\s*analysis:/i, /^\s*explainer:/i, /^\s*q&a:/i,
  /^\s*comment:/i, /^\s*viewpoint:/i, /^\s*debriefed\b/i,
];

export const EXCLUDED_CATEGORY = /^(opinion|sport|sports|entertainment|lifestyle|travel|arts|culture|food)$/i;


/**
 * Is this item reported news that belongs in the brief?
 * Never throws: a malformed link means no path evidence, not a lost feed.
 */
export function isNewsworthy(item) {
  try {
    if (!item.title || stripHtml(item.title).length < 15) return false;
    let path = '';
    try { if (item.link) path = new URL(item.link).pathname; } catch { path = ''; }
    if (path && EXCLUDED_PATH.test(path)) return false;
    // Commentary filed under a path that does not say so - a live brief summarised
    // a story using reason.com/volokh/...-bold-brave-and-right-on-the-iran-war.
    if (path && OPINION_PATHS.test(path)) return false;
    if (looksLikeOpinion(item.title)) return false;
    if (EXCLUDED_TITLE.some((re) => re.test(item.title))) return false;
    if (item.categories?.some((c) => EXCLUDED_CATEGORY.test(String(c).trim()))) return false;
    return true;
  } catch {
    return false;
  }
}
