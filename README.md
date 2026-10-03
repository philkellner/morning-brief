# Morning Brief

Ten news stories every morning. No ads, no trackers, no comment sections, and
no single newsroom deciding what leads.

- **A GitHub Actions cron** builds the digest at 05:00 America/Chicago from 63
  RSS feeds spanning the political spectrum, and commits it as `docs/digest.json`.
- **Read it in a newsreader**: every build publishes an Atom feed at `/feed.xml`,
  which is the fullest form of the brief — see *Reading it in a newsreader* below.
- **Or push to your phone** via [ntfy](https://ntfy.sh), one notification per
  story at 06:00 — see *Phone notifications*.

There is no server and nothing to pay for. The whole backend is a cron job that
commits a JSON file.

---

## What "unbiased" means here — and what it can't mean

No feed is unbiased, and any project claiming otherwise is selling something.
What this does instead is **measure consensus and show you the evidence**:

| Mechanism | What it buys you |
|---|---|
| 63 feeds across 44 outlets — balanced left / centre / right | No single outlet's news judgement sets your morning |
| Stories ranked by **how many distinct outlets** ran them | "Top" means broadly-reported, not editorially promoted |
| Ranking rewards **spread across the spectrum** | A story only the left or only the right ran ranks below one everybody ran |
| Headline picked as the **least sensational** phrasing among covering outlets | You get "Federal Reserve holds rates steady", not "Fed SLAMS critics" |
| Commentary excluded by **verdict and prescription**, not just by section path | Keeps out "Trump Is Bold, Brave, and Right on the Iran War", which no framing filter would flag |
| Wire desks preferred for headline and summary | Closest thing to plain declarative reporting |
| Title + description only, tracking params stripped | No ads, no engagement furniture |
| Every story shows its coverage list and lean spread | You can audit the ranking rather than trust it |

**The honest caveats.** Cross-source consensus cannot fix a blind spot every
outlet shares. It structurally favours widely-covered stories over important
under-reported ones. The `lean` labels in `sources.json` are coarse and
themselves contestable — they are used only for diversity scoring and display,
never to filter anything out. And the story you most need may be the one nobody
ran.

---

## Setup

### 1. Push the repo

```bash
git remote add origin https://github.com/philkellner/morning-brief.git
git push -u origin main
```

### 2. Let Actions commit the digest

**Settings → Actions → General → Workflow permissions → "Read and write permissions".**
Without this the build succeeds but the commit step fails with a 403.

### 3. Check the feeds are alive

Every feed in `sources.json` was probed live on 2026-08-23 and returned parseable
items, so this is maintenance rather than setup. Run the **Probe feeds** workflow
(Actions tab → Probe feeds → Run workflow) whenever the digest looks thin; it
reports which feeds are usable, and runs itself on the first Monday of each month.

Two things worth knowing about the source list:

- **Reuters is not in it.** `reuters.com`, `reutersagency.com` and `apnews.com`
  all return 401/404 to feed readers now. Their wire copy still reaches the digest
  indirectly, since ABC, CBS and NBC run it.
- **AP comes from a third-party mirror** (`feedx.net`), which is why it is marked
  `wire: false` — a feed nobody here controls should not win headline selection.
  Drop it if you would rather not depend on a mirror.

### 4. Build the first digest

Run the **Build morning digest** workflow manually. It commits `docs/digest.json`.
After that it runs itself at 05:00 Chicago every day.

### 5. Turn on Pages

**Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder:
`/docs` → Save.** That serves the Atom feed, and a terminal-styled web reader
alongside it. See *Enabling the URL* below for why it has to be the branch
option and not "GitHub Actions".

---

## Reading it in a newsreader

Every build writes an Atom feed:

```
https://philk.dev/morning-brief/feed.xml
```

Note the domain: the user site `philkellner.github.io` carries a `CNAME` to
`philk.dev`, and a project page inherits that domain, so this repository is
published under `philk.dev/morning-brief/` rather than at its github.io address.
`SITE_URL` overrides it if that ever changes — the Atom `self` link has to match
the address the feed actually serves from, because readers use it to identify
the feed.

Subscribe to that URL in NetNewsWire (**File → New Feed**, or paste it into the
sidebar) and the brief arrives as ten items each morning. Nothing needs to run,
nothing needs installing, and there is no account anywhere — it is a static file
on GitHub Pages that the reader polls.

This is the fullest form of the brief, because a reader has room for what a
notification does not. Each entry carries the headline and summary, then the
provenance: how many outlets ran the story, across how many editorial leans, the
outlet whose headline was chosen, and **the full list of who else carried it,
each with its lean and a link to their version**. That coverage list is the thing
that makes the ranking auditable rather than something to take on trust, and in
a reader you can actually read it.

The topic travels as an Atom `<category>`, so a reader can group or filter
by World, Technology, Business and Health.

Entry ids are stable across rebuilds (`tag:morning-brief,<edition>:<story-id>`),
so re-running a build does not resurface the whole brief as unread.

### Enabling the URL (one click, once)

The feed is committed on every build, but a repository does not serve a site
until Pages is switched on, and that first switch has to be made by a repo
admin. Neither the REST API from a sandboxed environment nor
`actions/configure-pages` from inside Actions can do it: the Actions token may
*deploy* to Pages but not *create* the site, and tries fail with
`Resource not accessible by integration`.

**Settings → Pages → Build and deployment → Source: "Deploy from a branch" →
Branch: `main`, folder: `/docs` → Save.**

Choose the branch option rather than "GitHub Actions". Pages then rebuilds on
every push to `main`, including the daily digest commit, with no workflow to
maintain — and critically, branch builds are not subject to the rule that
commits made with `GITHUB_TOKEN` do not trigger workflows. An Actions-based
deploy would need a `workflow_run` trigger to work around exactly that.

Until then, and as a permanent fallback, the feed is readable straight from the
repository:

```
https://raw.githubusercontent.com/philkellner/morning-brief/main/docs/feed.xml
```

NetNewsWire reads that fine. The only difference is the content type —
`text/plain` raw against `application/xml` from Pages — which stricter readers
care about and NetNewsWire does not.

Notifications and the feed are independent. To stop the morning push and read
only in NetNewsWire, delete the `NTFY_TOPIC` secret; the notification step then
exits quietly and everything else carries on.

---

## Phone notifications

Alongside the feed — or instead of it — the cron can push the same ten stories
straight to your phone through [ntfy](https://ntfy.sh), one notification per
story at 06:00. There is nothing to install beyond ntfy's own App Store app and
nothing to renew.

What a notification loses is the provenance: the coverage list, the lean count
and the outlet attribution all fit in a newsreader entry and not in a
notification. The two are independent, so running both is reasonable.

### Setup

1. **Pick a topic name nobody will guess.** The topic *is* the credential on
   public ntfy: anyone who knows it can read your notifications or publish to
   them. Generate one rather than inventing it:

   ```bash
   openssl rand -hex 12
   ```

2. **Add it as a repository secret**: *Settings → Secrets and variables →
   Actions → New repository secret*, named `NTFY_TOPIC`.

3. **Install ntfy** on your iPhone from the App Store and subscribe to that
   topic.

4. **Test it**: run the **Send a test notification** workflow from the Actions
   tab. It sends the current lead story immediately.

From then on the daily build sends all ten. Until `NTFY_TOPIC` exists the
notification step exits quietly, so nothing changes if you never set it.

### How the timing works

The messages are published at 05:00 carrying ntfy's `delay` field set to 06:00,
so ntfy holds them and releases them on schedule, staggered 45 seconds apart.
One cron entry produces both the build and the delivery — there is no second
schedule to keep in step, and no DST arithmetic beyond what the build already
does.

Payloads are sent as JSON rather than through ntfy's HTTP headers, because
headers cannot carry UTF-8 and real headlines are full of curly quotes, em
dashes and accented names.

### Options

All optional, as repository secrets or local environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `NTFY_TOPIC` | — | Required. Without it, notifications are skipped. |
| `NTFY_SERVER` | `https://ntfy.sh` | Point at a self-hosted instance. |
| `NTFY_TOKEN` | — | Bearer token for an access-controlled topic. |
| `NTFY_HOUR` / `NTFY_MINUTE` | `6` / `0` | Delivery time. |
| `NTFY_TIMEZONE` | `America/Chicago` | Zone that time is local to. |
| `NTFY_SPACING_SECONDS` | `45` | Gap between stories. |
| `NTFY_PRIORITY` | `3` | ntfy priority, 1–5. |

```bash
npm run notify:dry     # print what would be sent, send nothing
npm run notify:test    # send the lead story immediately
npm run notify         # send the full digest, scheduled for 06:00
```

If you self-host ntfy, or use a reserved topic with an access token, the topic
name stops being a shared secret and `NTFY_TOKEN` does the authenticating instead.

---

## Timing, and why the build is at 05:00 but delivery is at 06:00

The hour of slack matters. GitHub's scheduled runs are queued, not guaranteed
punctual, and the phone needs time to pick the new file up.

GitHub cron only speaks UTC and has no notion of daylight saving, so `digest.yml`
fires at both 10:00 and 11:00 UTC — one of which is 05:00 in Chicago whichever
side of a DST change you are on.

Rather than testing the clock hour, the job asks whether today's digest has been
built yet: whichever run arrives first does the work, and the second finds today's
edition already committed and stops. That matters because scheduled runs are
queued, not punctual — the first real one slipped 21 minutes — and an
"is it 05:00?" test would fail on *both* firings if a run drifted across the hour
boundary, silently costing you a day.

To change the delivery time, use **Settings** in the app — it reschedules
immediately. If you move it earlier than 05:45, also shift the cron in
`.github/workflows/digest.yml` so the build still lands first.

---

## When a story comes out wrong

Heuristics miss things. The point of this loop is that each miss is only allowed
to happen once.

**1. Flag it.** Every notification carries a **Flag** button. It opens a GitHub
issue prefilled with the edition, rank, topic and headline — the four things
needed to find the story again. `NTFY_FLAG_REPO` controls where it files; unset
it to remove the button.

**2. Diagnose it.** Each build writes `docs/archive/<edition>.detail.json`
alongside the digest: every raw cluster member, with feed id, URL, description and
topic hint. The published digest keeps only a deduped view, so without this a
story flagged next week could not be reconstructed.

```bash
npm run triage -- 2026-09-12 9        # by edition and rank
npm run triage -- latest heart        # or a substring of the headline
```

That prints, for every member: whether the filters would admit it, its opinion
and sensationalism scores, its URL path — then how the topic vote was counted,
which terms the outlets agreed on, and why each headline won or lost. The point
is to land on *the rule responsible*, rather than guessing.

**3. Record it.** Copy the real cluster into the labelled corpus with the verdict
you assert:

```bash
npm run flag -- 2026-09-12 9 --id cardiac-research-is-health --expect topic=health
```

Verdicts: `topic=<t>`, `clusters=<n>`, `excluded=true`, `kept=true`,
`headlineNot=<regex>`, `summaryNot=<regex>`, `headlineIndex=<n>`, and `pairs`
(`{merge: [[i,j]], split: [[i,j]]}`, by item index — the right shape for a
reported over-merge, where a cluster count over a dozen members is brittle but
"these two are the same story" is exact).

A freshly flagged case is **expected to fail** — that failure is the bug report.

**4. Fix, then prove it.**

```bash
npm run eval        # every case ever reported, with its verdict
npm run eval -- -v  # and why each was filed
```

`npm test` runs them too, one named test per case, so CI fails by name.

### Why the corpus matters more than any single fix

Reported cases come in pairs. `cardiac-research-is-health` says medical research
belongs in health; `astronomy-is-tech` says the fix must not drag physics along
with it. `nyc-single-shared-noun` says four stories sharing a place name must not
merge; `canada-pair-must-merge` says the tightening must not split genuine
duplicates.

That pairing is deliberate, and learned the hard way. On 2026-09-02 two
consecutive summary fixes each broke an assumption the previous one relied on,
and on 2026-09-06 a classification fix had to be walked back twice. Both were
caught by luck. With the corpus they are caught by measurement.

The harness itself was wrong twice on first run, which is worth knowing if you
extend it: clustering cases must be judged **against a background corpus**,
because TF-IDF over four documents is meaningless and reports the opposite of
what the live pipeline does. And a case about summary choice must pin which item
supplies the headline, or it silently tests something else.

---

## How the ranking works

```
score = 3.0 · log₂(1 + distinct outlets)     ← breadth
      + 1.4 · (distinct leans − 1)
      + 2.2 · spectrum spread                 ← diversity
      + 0.8 · min(wire services, 4)           ← wire corroboration
      + 2.5 · 0.5^(age hours / 18)            ← recency, ~18h half-life
```

Every story in the JSON carries its own `scoreComponents`, so you can see
exactly why it placed where it did.

Grouping headlines into stories is TF-IDF cosine similarity over stemmed tokens,
with proper nouns weighted up, plus a gate requiring the overlap to rest on
something *distinctive* before two items merge. Against the adversarial test
fixture — which contains two different earthquakes, two different elections, two
different Gaza stories, and the Fed vs. the ECB — it scores **precision 1.00,
recall 1.00, zero false merges**. Under-merging only understates a source count;
over-merging would send you a notification about a story that does not exist, so
the thresholds are tuned to favour precision.

---

## Local development

```bash
npm test                    # tests plus every reported case, no dependencies
npm run eval                # just the cases reported from real briefs
npm run triage -- latest 3  # explain how one story was decided
npm run feed                # rebuild only feed.xml from the digest on disk
npm run demo                # run the pipeline against fixtures, no network
npm run preview             # fetch real feeds, print the digest, write nothing
npm run probe               # report which feeds are alive
npm run build               # write docs/digest.json
```

There are no dependencies — Node 20+ only. `scripts/lib/` holds the parser,
clustering, and ranking; `scripts/test.mjs` covers all three.

### Tuning it

- **Sources** — edit `sources.json`. Keep the left/right counts within 2 of each
  other, or "consensus" degrades into one side agreeing with itself. A test
  enforces this.
- **What gets excluded** — `EXCLUDED_PATH` / `EXCLUDED_TITLE` in
  `scripts/build-digest.mjs` drop opinion, sport, lifestyle and live blogs.
- **Clustering aggressiveness** — `threshold` in `scripts/lib/cluster.mjs`.
  Raise it if unrelated stories merge; lower it if one event appears twice.
- **Headline neutrality** — `LOADED_PATTERNS` in `scripts/lib/rank.mjs`.

The build refuses to publish if fewer than 5 feeds respond or fewer than 5
stories survive, so a bad morning leaves yesterday's digest in place rather than
overwriting it with junk.

---

## Known limitations

- **English-language sources only**, and heavily US/UK/EU weighted.
- **Health is the thinnest topic.** Specialist provenance needs two outlets
  agreeing, and there are only two right-of-centre health desks publishing a
  usable feed, so a health story occasionally falls back to the world quota.
- **Actions cron drifts.** GitHub's scheduler is best-effort and has been
  observed over ten hours late. The workflow carries eight hourly triggers and
  builds on whichever fires first — see *Timing* above.

## Licence

MIT
