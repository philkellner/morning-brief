#!/usr/bin/env node
// Sends the digest to an ntfy topic - one notification per story.
//
//   NTFY_TOPIC=your-secret-topic node scripts/notify-ntfy.mjs
//   NTFY_TOPIC=... node scripts/notify-ntfy.mjs --now --limit 1   # test immediately
//   NTFY_TOPIC=... node scripts/notify-ntfy.mjs --in 2 --limit 1   # test ntfy's delay path
//   node scripts/notify-ntfy.mjs --dry-run                        # print, send nothing
//
// Environment:
//   NTFY_TOPIC             required; without it this exits quietly so the
//                          workflow step is a harmless no-op until configured
//   NTFY_SERVER            default https://ntfy.sh
//   NTFY_TOKEN             optional bearer token for a protected topic
//   NTFY_HOUR / NTFY_MINUTE        delivery time, local to NTFY_TIMEZONE (default 06:00)
//   NTFY_TIMEZONE          default America/Chicago
//   NTFY_SPACING_SECONDS   gap between stories (default 45)
//   NTFY_GRACE_MINUTES     how late a build may be and still deliver this
//                          morning's brief immediately (default 180)
//   NTFY_PRIORITY          ntfy priority 1-5 (default 3)
//   NTFY_FLAG_REPO         repo the notification's Flag button files against
//                          (default philkellner/morning-brief; empty disables it)

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessages, nextDeliveryEpoch, deliveryPlan, readConfig } from './lib/ntfy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : fallback;
};

const config = readConfig(process.env);
const { topic } = config;
if (!topic) {
  console.log('NTFY_TOPIC is not set - skipping notifications.');
  console.log('Set it as a repository secret to enable them. See README, "Phone notifications without the app".');
  process.exit(0);
}

const { server, timeZone, hour, minute, spacingSeconds, priority, graceMinutes } = config;
const limit = Number(value('--limit', config.limit)) || config.limit;
const sendNow = has('--now');
// --in exercises the same scheduled-delivery path production uses, on a
// timescale you can actually wait out. --now skips that path altogether, so a
// passing --now test says nothing about whether delayed delivery works.
const inMinutes = Number(value('--in', NaN));
const dryRun = has('--dry-run');

const digest = JSON.parse(await readFile(resolve(ROOT, 'docs/digest.json'), 'utf8'));
const now = Date.now();

// --now skips scheduling entirely, which is what makes a test notification arrive
// in seconds rather than tomorrow morning.
let deliverAt;
let lateMinutes = 0;
if (sendNow) {
  deliverAt = null;
} else if (Number.isFinite(inMinutes)) {
  deliverAt = now + inMinutes * 60_000;
} else if (has('--force-schedule')) {
  deliverAt = nextDeliveryEpoch({ now, hour, minute, timeZone });
} else {
  // A build can arrive hours late - GitHub's scheduler has been running this job
  // 5-7 hours behind its cron. Scheduling past a slot that has already gone
  // would queue these stories for TOMORROW's slot, where they would collide
  // with tomorrow's build and deliver yesterday's news - so a late build sends
  // immediately instead, and only a stale one gives up.
  const plan = deliveryPlan({ now, hour, minute, timeZone, graceMinutes });
  const slotTime = `${hour}:${String(minute).padStart(2, '0')} ${timeZone}`;
  lateMinutes = plan.lateMinutes;

  if (plan.action === 'skip') {
    // Loud on purpose. This failed silently on four mornings out of five: the
    // digest built, the feed published, every step reported success, and the
    // only trace was one line in a log nobody reads. A missed brief is a failed
    // run.
    console.log(`::error::No notifications sent: the ${slotTime} slot passed ${plan.lateMinutes} minutes ago,`
      + ` beyond the ${graceMinutes}-minute grace window. The digest and feed are published; only the push was lost.`);
    console.log('Use --now to send anyway, or --force-schedule to queue for tomorrow.');
    // A dry run is for inspecting the decision, not for failing a build over it.
    process.exit(dryRun ? 0 : 1);
  }

  if (plan.action === 'now') {
    console.log(`::warning::The ${slotTime} slot passed ${plan.lateMinutes} minutes ago;`
      + ' sending this morning\'s brief now rather than losing it.');
  }
  deliverAt = plan.deliverAt;
}

let messages;
try {
  messages = buildMessages(digest, { topic, limit, deliverAt, spacingSeconds, priority, flagRepo: config.flagRepo, now });
} catch (err) {
  console.error(`Refusing to send: ${err.message}`);
  process.exit(1);
}

if (messages.length === 0) {
  console.error('The digest contains no stories.');
  process.exit(1);
}

console.log(`Digest edition ${digest.edition}, ${messages.length} stories -> ${server}/${topic}`);
if (!deliverAt) {
  console.log('Sending immediately (ntfy scheduling not exercised)');
} else {
  const when = new Date(deliverAt).toISOString();
  const basis = Number.isFinite(inMinutes)
    ? `${inMinutes} minute${inMinutes === 1 ? '' : 's'} from now`
    : (lateMinutes > 0
      ? `${lateMinutes} minutes after the ${hour}:${String(minute).padStart(2, '0')} ${timeZone} slot`
      : `${hour}:${String(minute).padStart(2, '0')} ${timeZone}`);
  console.log(`Scheduled from ${when} (${basis}), ${spacingSeconds}s apart`);
}

if (dryRun) {
  for (const m of messages) {
    console.log(`\n--- ${m.title}`);
    console.log(m.message);
    if (m.delay) console.log(`    deliver at ${new Date(Number(m.delay) * 1000).toISOString()}`);
    if (m.click) console.log(`    click ${m.click}`);
  }
  console.log('\n--- dry run, nothing sent ---');
  process.exit(0);
}

const headers = { 'content-type': 'application/json' };
if (config.token) headers.authorization = `Bearer ${config.token}`;

let failures = 0;
for (const [index, message] of messages.entries()) {
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      // ntfy explains rejections in the body; surfacing it saves a lot of guessing.
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    console.log(`  sent ${String(index + 1).padStart(2)}. ${message.title.slice(0, 60)}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${String(index + 1).padStart(2)}. ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${messages.length} notifications failed.`);
  process.exit(1);
}
console.log(`\nAll ${messages.length} notifications accepted by ntfy.`);
