# Morning Brief

Ten news stories on your phone at 06:00, one notification each. No ads, no
trackers, no comment sections, and no single newsroom deciding what leads.

- **A GitHub Actions cron** builds the digest at 05:00 America/Chicago from 35
  RSS feeds spanning the political spectrum, and commits it as `docs/digest.json`.
- **A SwiftUI iOS app** fetches that file and schedules one local notification
  per story for 06:00.

There is no server and nothing to pay for. The whole backend is a cron job that
commits a JSON file.

---

## What "unbiased" means here — and what it can't mean

No feed is unbiased, and any project claiming otherwise is selling something.
What this does instead is **measure consensus and show you the evidence**:

| Mechanism | What it buys you |
|---|---|
| 35 sources — 10 left-of-centre, 15 centre, 10 right-of-centre | No single outlet's news judgement sets your morning |
| Stories ranked by **how many distinct outlets** ran them | "Top" means broadly-reported, not editorially promoted |
| Ranking rewards **spread across the spectrum** | A story only the left or only the right ran ranks below one everybody ran |
| Headline picked as the **least sensational** phrasing among covering outlets | You get "Federal Reserve holds rates steady", not "Fed SLAMS critics" |
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

### 5. Optional: the web view

**Settings → Pages → Source: main, folder: /docs** publishes a terminal-styled
reader at `https://philkellner.github.io/morning-brief/`. The iOS app does not
need this — it reads the raw file from GitHub directly.

### 6. Build the app

On your Mac:

```bash
git clone https://github.com/philkellner/morning-brief.git
cd morning-brief
./ios/setup-mac.sh --build
```

That checks your toolchain, compiles the app for the simulator, and opens Xcode.
The `--build` step is the one that matters: it compiles without needing any
Apple account or signing setup, so you find out whether the code is sound before
touching provisioning. If it fails, it prints the compiler errors.

Other options:

```bash
./ios/setup-mac.sh                       # check the toolchain and open Xcode
./ios/setup-mac.sh --team ABC1234567     # write your signing team into the project
./ios/setup-mac.sh --build --no-open     # verify it compiles, open nothing
./ios/setup-mac.sh --download-platform --build   # fetch the iOS SDK first
```

**Two things trip up a fresh Mac**, and the script names both rather than letting
Xcode fail obscurely:

- *Command Line Tools installed but not Xcode.* The CLT ship their own
  `/usr/bin/xcodebuild`, so the binary exists and appears to work. It cannot
  build an iOS app.
- *Xcode installed but no iOS platform.* Since Xcode 16, the iOS SDK and
  simulator runtimes are a separate multi-gigabyte download. Without them
  `xcodebuild` reports "Unable to find a destination matching the provided
  destination specifier", which does not obviously mean "your SDK is missing".
  Fix: `xcodebuild -downloadPlatform iOS`.

Then in Xcode: pick your Team under the target's **Signing & Capabilities** tab,
choose your iPhone, and press Run. Allow notifications when asked, and use
**Settings → Send a test notification** to confirm delivery without waiting for
06:00.

Requires **Xcode 16 or newer** — the project uses the newer file-system
synchronized group format, so adding Swift files never means editing the project
file. On an older Xcode, regenerate it:

```bash
brew install xcodegen && cd ios/MorningBrief && xcodegen generate
```

A free Apple ID works; Apple expires free provisioning profiles after 7 days, so
you would re-run from Xcode weekly. A paid developer account ($99/yr) makes the
build last a year.

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
npm test                    # 19 tests, no dependencies
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

- **iOS background refresh is a request, not a promise.** The app asks to be
  woken 45 minutes before delivery, and also refreshes whenever you open it. If
  iOS declines to run it, the 06:00 notifications carry the last digest the phone
  managed to fetch — and the lead notification says so, with the edition date,
  rather than passing stale news off as current. In practice, opening the app
  most days is what keeps iOS generous with background time.
- **Local notifications, not push.** That is what removes the need for a server,
  APNs certificate, and paid account. The cost is the staleness window above.
- **English-language sources only**, and heavily US/UK/EU weighted.
- **The Swift code has not been compiled.** It was written on Linux, where no
  Xcode toolchain exists. The Node pipeline is fully tested; the app is not.

## Licence

MIT
