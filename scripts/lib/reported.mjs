// Runs the labelled cases in scripts/fixtures/reported.json.
//
// Every case is a story that reached a real notification wrong, or a counterpart
// that has to keep working after the fix. Twice in one day a fix here broke an
// assumption made by an earlier fix; running all of them on every change is what
// turns that from luck into measurement.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewsworthy } from './filter.mjs';
import { clusterItems } from './cluster.mjs';
import { classifyCluster } from './topics.mjs';
import { pickHeadline, pickSummary } from './rank.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadReported() {
  const path = resolve(ROOT, 'scripts/fixtures/reported.json');
  return JSON.parse(readFileSync(path, 'utf8')).cases;
}

/**
 * Clustering is judged against a background corpus, never the case alone.
 *
 * TF-IDF needs a realistic document frequency: with four documents every term
 * looks rare and the thresholds mean nothing. Evaluating cases in isolation gave
 * exactly the wrong answers - it reported the NYC group as merged when the live
 * pipeline splits it correctly.
 */
function backgroundCorpus() {
  const path = resolve(ROOT, 'scripts/fixtures/headlines.json');
  return JSON.parse(readFileSync(path, 'utf8')).map((i) => ({
    ...i,
    outlet: i.outlet ?? i.sourceId,
    published: new Date(),
    categories: [],
  }));
}

/** Hydrate stored items into the shape the pipeline passes around. */
function hydrate(items) {
  return items.map((i) => ({
    ...i,
    outlet: i.outlet ?? i.sourceId,
    published: i.published ? new Date(i.published) : new Date(),
    categories: i.categories ?? [],
  }));
}

/**
 * Check one case.
 * @returns {{id: string, ok: boolean, failures: string[]}}
 */
export function runCase(testCase) {
  const items = hydrate(testCase.items);
  const expect = testCase.expect ?? {};
  const failures = [];

  if (expect.excluded === true) {
    const survivors = items.filter(isNewsworthy);
    if (survivors.length > 0) {
      failures.push(`expected every item dropped, but kept: ${survivors.map((i) => i.title).join(' | ')}`);
    }
  }

  if (expect.kept === true) {
    const dropped = items.filter((i) => !isNewsworthy(i));
    if (dropped.length > 0) {
      failures.push(`expected every item kept, but dropped: ${dropped.map((i) => i.title).join(' | ')}`);
    }
  }

  // Clustering and the judgements downstream of it only make sense on items the
  // filters would actually have admitted.
  const admitted = expect.excluded === true ? items : items.filter(isNewsworthy);

  if (typeof expect.clusters === 'number') {
    const clusters = clusterItems([...backgroundCorpus(), ...admitted]);
    const landed = new Set();
    for (const [index, cluster] of clusters.entries()) {
      if (cluster.items.some((i) => admitted.includes(i))) landed.add(index);
    }
    if (landed.size !== expect.clusters) {
      const shape = [...landed].map((i) => clusters[i].items
        .filter((x) => admitted.includes(x))
        .map((x) => x.sourceId).join('+')).join(' | ');
      failures.push(`expected ${expect.clusters} clusters, got ${landed.size}: ${shape}`);
    }
  }

  if (expect.topic) {
    const found = classifyCluster(admitted);
    if (found !== expect.topic) failures.push(`expected topic ${expect.topic}, got ${found}`);
  }

  // A summary is judged against the headline shown beside it, so a case about
  // summary choice must pin which item supplies the headline - otherwise the
  // check passes or fails on whichever headline won, which is a different test.
  const headlineItem = typeof expect.headlineIndex === 'number'
    ? admitted[expect.headlineIndex]
    : pickHeadline(admitted);

  if (expect.headlineNot) {
    const chosen = pickHeadline(admitted);
    if (new RegExp(expect.headlineNot, 'i').test(chosen.title)) {
      failures.push(`headline matched forbidden /${expect.headlineNot}/: ${chosen.title}`);
    }
  }

  if (expect.summaryNot) {
    const summary = pickSummary(admitted, headlineItem);
    if (new RegExp(expect.summaryNot, 'i').test(summary.text)) {
      failures.push(`summary matched forbidden /${expect.summaryNot}/: ${summary.text}`);
    }
  }

  return { id: testCase.id, ok: failures.length === 0, failures };
}

export function runAll() {
  return loadReported().map(runCase);
}
