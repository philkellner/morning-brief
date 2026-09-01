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
//   NTFY_PRIORITY          ntfy priority 1-5 (default 3)

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessages, nextDeliveryEpoch, isSlotPassed, readConfig } from './lib/ntfy.mjs';

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

const { server, timeZone, hour, minute, spacingSeconds, priority } = config;
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
if (sendNow) {
  deliverAt = null;
} else if (Number.isFinite(inMinutes)) {
  deliverAt = now + inMinutes * 60_000;
} else {
  // A build can arrive hours late - GitHub's scheduler has run this job as much
  // as 10 hours behind its cron. If today's slot is already gone, scheduling
  // would silently queue these stories for TOMORROW's slot, where they would
  // collide with tomorrow's build and deliver yesterday's news. Stop instead,
  // and let the next build own the next morning.
  const { passed, slot: todaySlot } = isSlotPassed({ now, hour, minute, timeZone });
  if (passed && !has('--force-schedule')) {
    const slot = new Date(todaySlot).toISOString();
    const lateMinutes = Math.round((now - todaySlot) / 60_000);
    console.log(`Today's ${hour}:${String(minute).padStart(2, '0')} ${timeZone} slot passed ${lateMinutes} minutes ago (${slot}).`);
    console.log('Skipping, so tomorrow\'s build is not duplicated. Use --now to send anyway, or --force-schedule to queue for tomorrow.');
    process.exit(0);
  }
  deliverAt = nextDeliveryEpoch({ now, hour, minute, timeZone });
}

let messages;
try {
  messages = buildMessages(digest, { topic, limit, deliverAt, spacingSeconds, priority, now });
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
    : `${hour}:${String(minute).padStart(2, '0')} ${timeZone}`;
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
