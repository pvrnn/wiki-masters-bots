---
name: open-packs
description: Open every available wiki-masters.com card pack right now and report what happened in plain language (packs opened, cards pulled, or why nothing happened). Use when the user asks to open/roll/pull their packs, check for new packs, or wants to know the result of a pack-opening run.
---

# Open packs

Triggers one real run of the pack-opener bot (`dist/index.js run`) and turns
its structured JSON log output into a plain-language summary, instead of
whoever invokes this having to hand-parse raw log lines (which is what
happened before this skill existed — grepping out huge embedded card JSON
blobs to keep output readable, every single time).

## Steps

```
node .claude/skills/open-packs/scripts/run-and-report.mjs
```

Run from the repo root. Relay its printed summary to the user essentially
as-is — it already reports the outcome (drained / blocked / partial / error /
skipped), the before/after pack counts, and every card pulled with rarity and
category. Don't re-derive this from the raw log yourself.

It also writes `data/last-run-report.json` (machine-readable, gitignored) if
a caller needs the structured form instead of the printed text.

## Safe to run alongside the daemon

This goes through the bot's own lock file (`acquireLock`, same one the
`daemon` mode uses), so if the background daemon happens to be mid-run when
this fires, the script detects that and reports "already running, nothing new"
rather than colliding with it. No need to check whether the daemon is running
first, or to stop it before invoking this.

## Reading the outcome

| Exit / status | Meaning | What to tell the user |
|---|---|---|
| `ok`, opened > 0 | Packs opened, cards listed | Report the count and the cards, best rarity first |
| `ok`, opened = 0 | Nothing was available | Say so plainly; not an error |
| `blocked` | Auth/session/human-verification/sanction problem | Relay the exact warning/error lines the script printed — they already name the specific cause (e.g. "needs a human verification", "account shows cheat_strikes") and, for most of these, what to do about it |
| `partial` | Stopped before the queue was empty | Report what was opened and the stop reason (iteration cap, budget, stall) |
| `error` | Unexpected failure | Relay the error lines; don't guess at a cause the script didn't report |
| `skipped` | Another run (usually the daemon) was already in progress | Say so; suggest trying again shortly if the user wants a report right now |

The script never guesses at rarity/theme labels the way collection-cleanup's
theme classifier does — it just relays exactly what the API returned, so
there's nothing to verify here beyond what the bot itself already logged.
