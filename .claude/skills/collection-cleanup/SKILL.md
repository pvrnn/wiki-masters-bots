---
name: collection-cleanup
description: Fetch the full wiki-masters.com card collection, group it by rarity then by theme (derived from each card's Wikipedia category), and launch a local web UI to review, select, and bulk-discard unwanted cards. Use when the user wants to clean up, sort, review, or mass-discard cards from their wiki-masters collection.
---

# Collection cleanup

Pulls every card in the user's wiki-masters.com collection, groups it by rarity
then by theme, and serves a local page where the user reviews the groups,
selects cards, and discards them in bulk. It reuses this repo's existing
Playwright/Supabase auth plumbing (`dist/config.js`, `dist/session.js`) rather
than reimplementing session handling.

## Hard rule: never call bulk-discard yourself

`POST /api/user-cards/bulk-discard` is **irreversible**. This skill's own
scripts never call it. It is only ever invoked by `serve-review.mjs`'s
`/api/discard` route, which only fires when a human clicks the button in the
browser UI and types the exact card count to confirm. Follow that boundary:
run the fetch/build scripts freely (they are read-only), but do not write or
run anything that calls the discard endpoint outside that UI flow, and do not
click the button on the user's behalf.

## Requirements

A valid saved session (`data/storage-state.json`) — run `npm run import-cookie`
or `npm run login` first if none exists. The build has to be current:
`npm run build` after any change to `src/`.

## Steps

1. **Fetch the full collection** (read-only, paginates until a short page):
   ```
   node .claude/skills/collection-cleanup/scripts/fetch-collection.mjs
   ```
   Writes `data/collection-raw.json` (every card) and
   `data/collection-categories.json` (distinct category strings + counts, most
   common first) — the second file is what step 2 is tuned against.

2. **Classify into themes and group**:
   ```
   node .claude/skills/collection-cleanup/scripts/build-grouped.mjs
   ```
   Writes `data/collection-grouped.json`. `classify-theme.mjs` is a
   keyword/regex classifier over each card's Wikipedia category (title as
   fallback when the category is null) — not an LLM call, because these
   category strings are systematic enough that a rule list gets good coverage
   for free and stays deterministic. The build script prints how many cards
   landed in "Autres / non classé" (the catch-all).

   **If that bucket is large** (rule of thumb: over ~20%), don't just accept
   it — read `data/collection-categories.json` (sorted by frequency, so the
   highest-value misses are at the top), find the recurring patterns landing
   in Autres, and add rules to `classify-theme.mjs`. Two gotchas hit during
   the original tuning pass, worth knowing before you repeat them:
   - JavaScript's `\b` only recognises ASCII word characters. `\bmaison à\b`
     silently never matches, because `\b` right before/after an accented
     letter (à, é, î, œ, …) never fires — the accented letter itself isn't a
     "word" character to `\b`, so there's no transition to detect. Drop the
     boundary next to the accented character instead of anchoring on it.
     `\b[îi]le` has the same bug even though the accented letter is inside a
     character class, not literal in the source — `\b` still evaluates
     against whatever character ends up matched at runtime.
   - Prioritized substring matching, not full NLP: a specific pattern (e.g.
     "navire de guerre" → Militaire) must be listed before a broader one that
     would otherwise shadow it (e.g. bare "navire" → Transports). Rules are
     tried in file order, first match wins.
   - Then re-run this step and check the new percentage.

3. **Serve the review UI**:
   ```
   node .claude/skills/collection-cleanup/scripts/serve-review.mjs [port]
   ```
   Defaults to port 4545, binds to `127.0.0.1` only. Tell the user the URL
   and stop — this is a long-running process; launch it in the background and
   don't block waiting on it. The page:
   - reads `data/collection-grouped.json` (never touches the live site itself);
   - lets the user browse by rarity → theme, search, and multi-select cards;
   - on "Discard", shows the exact count and requires typing it to confirm,
     then POSTs `{ card_ids: [...] }` to this server's `/api/discard`, which
     is the only thing in this whole skill that calls the real endpoint.

   Recommend the user test with **one** low-value card first before a large
   batch — see "Open question" below for why.

## Files

```
scripts/
  fetch-collection.mjs   read-only pagination of /api/my-collection
  classify-theme.mjs     the rule-based theme classifier (tune this)
  build-grouped.mjs      raw collection -> grouped JSON
  serve-review.mjs       local server: static UI + /api/collection + /api/discard
public/
  index.html, app.js, style.css   the review UI (vanilla JS, no build step)
```

All scripts resolve the repo's `dist/` via `import.meta.url`, so they work
regardless of the caller's cwd, but are meant to be run from the repo root (as
shown above) so relative paths in their own error messages stay meaningful.

`data/collection-raw.json`, `data/collection-categories.json`,
`data/collection-grouped.json`, and `data/discard-audit.log` (one JSON line
per discard call: requested ids, outcome, response) all land under `data/`,
which is already gitignored — this is personal collection data, never commit
it.

## Open question: which id field does bulk-discard want?

Each collection row carries both `id` (this specific owned copy) and
`card_id` (the underlying card). `serve-review.mjs` sends `card_id`, inferred
from naming symmetry with the request field `card_ids` — not confirmed
against a real call, and the account this was built against had zero
duplicate cards, so the two id spaces couldn't be distinguished empirically.
If a live test discards the wrong-seeming thing (or the call errors), the fix
is a one-line change in `serve-review.mjs`: swap `card.card_id` for
`card.row_id` in the `handleDiscard` function's call to `postJson`.

## Rarity order

Empirically observed via `sort=rarity` (highest first): `L > UR > SR > R >
PC > C`. Hardcoded as `RARITY_ORDER` in `build-grouped.mjs`. If the site adds
a tier this doesn't know about, the build script prints a warning naming it
rather than silently mis-sorting.
