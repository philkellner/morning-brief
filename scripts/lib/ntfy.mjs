// Builds the ntfy payloads for a digest.
//
// Publishing is done as JSON rather than with ntfy's HTTP headers, because
// headers cannot carry UTF-8: real headlines are full of curly quotes, em
// dashes and accented names, and those would arrive mangled.
//
// Delivery is scheduled, not immediate. The digest is built at 05:00 so that it
// is ready before 06:00, so each message carries a `delay` telling ntfy when to
// release it. One job at 05:00 therefore produces a 06:00 delivery without a
// second cron entry to keep in sync.

/** Milliseconds between UTC and a zone's wall clock at a given instant. */
function zoneOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(epochMs))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  // formatToParts can report hour 24 for midnight.
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asIfUtc - epochMs;
}

/**
 * The epoch millisecond at which the given wall-clock time occurs in `timeZone`.
 * Iterates because the offset depends on the instant we are solving for - the
 * naive single-step version lands an hour out on daylight-saving boundaries.
 */
export function zonedTimeToEpoch({ year, month, day, hour, minute = 0, timeZone }) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let epoch = naive;
  for (let i = 0; i < 3; i += 1) {
    epoch = naive - zoneOffsetMs(epoch, timeZone);
  }
  return epoch;
}

/** Today's calendar date in a zone, as {year, month, day}. */
export function dateInZone(epochMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(epochMs))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** The next occurrence of hour:minute in `timeZone`, at or after `now`. */
export function nextDeliveryEpoch({ now, hour, minute, timeZone, minLeadMs = 10_000 }) {
  const today = dateInZone(now, timeZone);
  let target = zonedTimeToEpoch({ ...today, hour, minute, timeZone });
  if (target < now + minLeadMs) {
    const tomorrow = dateInZone(now + 24 * 3600_000, timeZone);
    target = zonedTimeToEpoch({ ...tomorrow, hour, minute, timeZone });
  }
  return target;
}

/**
 * One payload per story.
 *
 * @returns {Array<object>} ntfy JSON publish bodies, in delivery order
 */
export function buildMessages(digest, {
  topic,
  limit = 10,
  deliverAt = null,
  spacingSeconds = 45,
  priority = 3,
  now = Date.now(),
} = {}) {
  if (!topic) throw new Error('An ntfy topic is required.');
  if (digest.seed) throw new Error('This digest is the bundled sample data; refusing to send it as news.');

  const stories = (digest.stories ?? []).slice(0, limit);

  return stories.map((story, index) => {
    const message = {
      topic,
      title: story.title,
      message: buildBody(story, stories.length),
      priority,
      tags: ['newspaper'],
    };

    if (story.url) message.click = story.url;

    if (deliverAt !== null) {
      const at = deliverAt + index * spacingSeconds * 1000;
      // ntfy rejects a delay in the past, and requires at least ten seconds.
      if (at > now + 10_000) message.delay = String(Math.floor(at / 1000));
    }

    return message;
  });
}

function buildBody(story, total) {
  const provenance = `${story.rank} of ${total} · ${story.sourceCount} outlet${story.sourceCount === 1 ? '' : 's'} · ${story.leanCount} lean${story.leanCount === 1 ? '' : 's'} · via ${story.headlineSource}`;
  return story.summary ? `${story.summary}\n\n${provenance}` : provenance;
}


/**
 * Has today's delivery slot already gone by?
 *
 * Builds can arrive hours late, so this decides whether scheduling is still
 * meaningful. If the slot has passed, queuing would land on TOMORROW's slot and
 * collide with tomorrow's build.
 */
export function isSlotPassed({ now, hour, minute = 0, timeZone }) {
  const slot = zonedTimeToEpoch({ ...dateInZone(now, timeZone), hour, minute, timeZone });
  return { passed: now > slot, slot };
}

/**
 * Read configuration from an environment.
 *
 * Written against empty strings, not just absent keys: GitHub Actions sets
 * `FOO: ${{ secrets.FOO }}` to "" when the secret does not exist, so `??`
 * fallbacks never fire and an unset NTFY_SERVER became fetch(""). Numeric
 * values need the same care - Number("") is 0, which would silently move
 * delivery to midnight.
 */
export function readConfig(env = process.env) {
  const text = (name, fallback = null) => {
    const raw = env[name];
    if (raw === undefined || raw === null) return fallback;
    const trimmed = String(raw).trim();
    return trimmed === '' ? fallback : trimmed;
  };
  const number = (name, fallback) => {
    const raw = text(name);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    topic: text('NTFY_TOPIC'),
    server: (text('NTFY_SERVER', 'https://ntfy.sh')).replace(/\/+$/, ''),
    token: text('NTFY_TOKEN'),
    timeZone: text('NTFY_TIMEZONE', 'America/Chicago'),
    hour: number('NTFY_HOUR', 6),
    minute: number('NTFY_MINUTE', 0),
    spacingSeconds: number('NTFY_SPACING_SECONDS', 45),
    priority: number('NTFY_PRIORITY', 3),
    limit: number('NTFY_LIMIT', 10),
  };
}
