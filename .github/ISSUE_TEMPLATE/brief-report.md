---
name: Report a story from a brief
about: A story arrived with the wrong topic, a misleading headline or summary, or should not have been there at all
labels: brief-report
---

**Edition**
**Rank**
**Topic**
**Headline**
**Link**

What is wrong with it:

---

Diagnose, then record it as a permanent case:

```bash
npm run triage -- <edition> <rank>
npm run flag -- <edition> <rank> --id <slug> --expect <verdict>
```

Verdicts: `topic=health`, `clusters=2`, `excluded=true`, `kept=true`,
`headlineNot=<regex>`, `summaryNot=<regex>`, `headlineIndex=<n>`.

A freshly flagged case is expected to fail — that failure *is* the bug report.
Fix the heuristic until `npm run eval` is green, and the case guards it from then on.
