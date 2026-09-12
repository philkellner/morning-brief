// Detects commentary that reached the corpus despite the section filters.
//
// Opinion is excluded by URL section path, which works only where an outlet
// files it under a path saying so. It routinely does not: a live brief took its
// summary from reason.com/volokh/.../president-trump-is-bold-brave-and-right-on-
// the-iran-war - the Volokh Conspiracy, a law blog, under a path naming neither
// opinion nor blog.
//
// The sensationalism scorer was no help either, and could not be: it looks for
// engagement framing ("slams", "blasts"), and that piece has none. Opinion is not
// sensational. It is EVALUATIVE - it says a thing is right or wrong - and
// PRESCRIPTIVE - it says what should happen. Those are what to look for.

import { stripHtml } from './text.mjs';

// Adjectives that pass judgement rather than report. Kept as literals: building
// these with `new RegExp` from a string invited an escaping mistake that silently
// matched nothing at all.
const JUDGEMENT_WORD = /\b(right|wrong|correct|mistaken|bold|brave|courageous|heroic|disastrous|shameful|disgraceful|foolish|wise|admirable|indefensible|inexcusable)\b/i;

// "Trump Is Bold, Brave, and Right on the Iran War" - a copula joined to a verdict.
const JUDGEMENT_VERDICT = /\b(?:is|are|was|were|remains?)\s+(?:\w+,?\s+(?:and\s+)?){0,3}(?:right|wrong|correct|mistaken|bold|brave|courageous|heroic|disastrous|shameful|disgraceful|foolish|wise|admirable|indefensible|inexcusable)\b/i;

// Weighted, because the signals are not equally telling. A copula joined to a
// verdict, or a "why X should" construction, is definitive on its own. A single
// judgement adjective is not: "reckless driving charge" is reporting.
const SIGNALS = [
  [JUDGEMENT_VERDICT, 2],
  [/^\s*why\b[^?]*\b(should|must|need|matters|cannot)\b/i, 2],
  [/\bwe\s+(must|should|need to|cannot|can't|owe)\b/i, 2],
  [/\b(here'?s why|the case (?:for|against)|in defen[cs]e of|let'?s be clear|make no mistake|it'?s time to)\b/i, 2],
  [/\b(should|must)\s+(?:not\s+)?(?:be\s+)?(resign|apologi[sz]e|step down|be ashamed)\b/i, 2],
  // First-person openings: reporting does not use them, commentary does.
  [/^\s*(i|my|we|our)\b/i, 2],
  [JUDGEMENT_WORD, 1],
];

// Section paths that carry commentary without saying "opinion".
export const OPINION_PATHS = /\/(opinion|volokh|commentar(?:y|ies)|columns?|op-?ed|perspectives?|viewpoints?|soapbox|blogs?|analysis)\//i;

/**
 * Weighted opinion evidence in a headline. Two points are required to exclude,
 * so one judgement adjective alone never is: "reckless driving charge" is
 * reporting, and "Bold Beauty wins the 3.15" is racing.
 */
export function opinionScore(title) {
  const text = stripHtml(title ?? '');
  let score = 0;
  for (const [re, weight] of SIGNALS) if (re.test(text)) score += weight;
  return score;
}

export const MIN_OPINION_SIGNALS = 2;

/** True when a headline reads as commentary rather than reporting. */
export function looksLikeOpinion(title) {
  return opinionScore(title) >= MIN_OPINION_SIGNALS;
}
