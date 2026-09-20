---
name: refresh-collection
description: Refresh the collection-cleanup review page with the latest cards (re-fetch, re-classify, and make sure the local server is running), then report what changed. Use when the user asks to refresh/update/sync their collection view, or after opening packs when they want the review page to reflect the new cards.
---

# Refresh collection

Re-syncs the local collection-cleanup review page after new cards have been
pulled. Replaces the manual sequence of running `fetch-collection.mjs`, then
`build-grouped.mjs`, then separately checking whether `serve-review.mjs` is
still up.

## Steps

```
node .claude/skills/refresh-collection/scripts/refresh-and-report.mjs
```

Run from the repo root. Relay its printed summary as-is: card count (with the
delta from before, when known), how many landed in the "Autres" catch-all
theme, and whether the review server was already running or just got started.

This calls into `collection-cleanup`'s own scripts (`fetch-collection.mjs`,
`build-grouped.mjs`, `serve-review.mjs`) rather than duplicating their logic
— this skill is purely the "do all three, in order, and tell me the result"
wrapper around that one.

## When the server isn't already running

If `http://127.0.0.1:4545/api/collection` doesn't respond, the script starts
`serve-review.mjs` itself, detached so it outlives this script, and polls
briefly to confirm it came up before reporting the URL. No separate step
needed to launch the page first.

## Port

Defaults to `4545`, matching `serve-review.mjs`'s own default. Pass a
different port as the first argument if the user is running the review page
on a non-default port:
```
node .claude/skills/refresh-collection/scripts/refresh-and-report.mjs 4600
```
