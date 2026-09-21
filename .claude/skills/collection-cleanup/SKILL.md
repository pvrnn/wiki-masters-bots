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

1. **Fetch the collection** (read-only):
   ```
   node .claude/skills/collection-cleanup/scripts/fetch-collection.mjs [--full]
   ```
   Two modes, chosen automatically:
   - **Incremental** (the default once `data/collection-sync-state.json` exists
     from a prior run): paginates `?sort=added` — newest first — and stops as
     soon as it reaches cards already on disk, instead of walking all 13+
     pages every time. A no-op refresh takes ~12s instead of ~90s; ~10 new
     cards from two packs took ~16s. Verified against a real pack-open: the
     exact 10 new cards showed up, nothing else changed, total matched
     precisely (631 → 641).
   - **Full** (`--full`, or automatically when there's no prior state to sync
     against): the original behaviour, `?sort=rarity`, every page until a
     short one ends it. Run this if the numbers ever look wrong, or after a
     discard made outside this UI's own flow — incremental mode only detects
     *additions*, never removals it didn't cause itself (see "Keeping raw and
     grouped in sync" below).

   Either way, writes `data/collection-raw.json` (every card),
   `data/collection-sync-state.json` (`lastRefreshAt`, and the real watermark
   `lastSeenObtainedAt` — the newest `obtained_at` on disk, which is what
   incremental mode's stop condition actually uses), and
   `data/collection-categories.json` (distinct category strings + counts,
   most common first) — the last one is what step 2 is tuned against.

   The listing endpoint has shown sporadic transient 500s in practice (a
   different page failing each retry, not one bad page) — each page gets up
   to 3 retries with backoff before the whole fetch gives up.

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

   The same step also tags each card with an **origin** — `france` /
   `etranger` / `inconnu` (`classify-origin.mjs`), a second axis independent
   of theme, since "is this French" cuts across Géographie, Personnalités,
   Transports, Sport, etc. rather than being a theme of its own. Built the
   same way, from the real category data, with two things worth knowing
   before extending it:
   - A first pass covering only nationality adjectives ("acteur américain")
     plus a handful of hand-picked "de/du \<country>" phrases left roughly
     half of Géographie & Lieux as "inconnu" -- nearly all of it checkably
     foreign, just using a preposition the rules hadn't anticipated
     ("village **de** Belgique", "commune **du** Sénégal", "lac **au**
     Mali"). Matching the country *name* itself, regardless of preposition
     or gender, fixed it (16% inconnu after, down from 48%). If "étranger"
     still undercounts after a run, this is usually why — check for a
     missing country name before adding more adjectives.
   - Short country names risk false-positive substring matches inside
     unrelated words -- confirmed for real in this data: "type d'**indi**ce"
     and "premier stade de la vie d'un **indi**vidu" both contain "inde".
     `\b`-guard any short/risky entry (safe for these specific ones: all
     plain ASCII, no accent-adjacency issue). Long names (allemagne,
     espagne, …) are left as plain substrings — not worth the same treatment,
     collision risk is negligible.

3. **Serve the review UI**:
   ```
   node .claude/skills/collection-cleanup/scripts/serve-review.mjs [port]
   ```
   Defaults to port 4545, binds to `127.0.0.1` only. Tell the user the URL
   and stop — this is a long-running process; launch it in the background and
   don't block waiting on it. The page:
   - reads `data/collection-grouped.json` (never touches the live site itself);
   - lets the user browse by rarity → theme, filter by origin and/or search
     text, and multi-select cards. "Select all" within a theme only selects
     cards currently passing the filters, not the whole theme — otherwise
     filtering to "Étranger" and clicking it would silently also select the
     French cards the filter is hiding, defeating the point of the filter;
   - on "Discard", shows the exact count and requires typing it to confirm,
     then POSTs `{ row_ids: [...] }` to this server's `/api/discard`, which
     is the only thing in this whole skill that calls the real endpoint.

   `/api/discard`'s response distinguishes real per-card outcomes
   (`discardedCount`, `succeededIds`, `failed: [{id, error}]`) rather than
   treating any 200 as success — see "The id field" below for why that
   distinction is load-bearing, not defensive-programming paranoia.

## Files

```
scripts/
  fetch-collection.mjs   read-only pagination of /api/my-collection
  classify-theme.mjs     the rule-based theme classifier (tune this)
  classify-origin.mjs    france / etranger / inconnu classifier (tune this)
  build-grouped.mjs      raw collection -> grouped JSON
  serve-review.mjs       local server: static UI + /api/collection + /api/discard
public/
  index.html, app.js, style.css   the review UI (vanilla JS, no build step)
```

All scripts resolve the repo's `dist/` via `import.meta.url`, so they work
regardless of the caller's cwd, but are meant to be run from the repo root (as
shown above) so relative paths in their own error messages stay meaningful.

`data/collection-raw.json`, `data/collection-sync-state.json`,
`data/collection-categories.json`, `data/collection-grouped.json`, and
`data/discard-audit.log` (one JSON line per discard call: requested ids,
outcome, response) all land under `data/`, which is already gitignored —
this is personal collection data, never commit it.

## Keeping raw and grouped in sync with real discards

A successful discard prunes the discarded ids from **both**
`collection-raw.json` and `collection-grouped.json` (see `pruneFromRawFile`
and `pruneFromGroupedFile` in `serve-review.mjs`). Pruning raw.json matters
specifically *because* incremental fetch merges new cards on top of whatever
is already there rather than replacing it — a discarded card left behind in
raw.json would persist forever and reappear the next time `build-grouped.mjs`
regenerates the grouped view from it, silently undoing the prune on the next
refresh. Both files have to agree with reality, not just the one currently
being read.

If a discard ever happens through some path other than this UI (manual API
call, a bug, whatever), incremental fetch has no way to know and won't catch
up — it only detects additions. Run `--full` to reconcile.

## The id field: resolved by a live test, and the API lies about it

Each collection row carries both `id` (this specific owned copy) and
`card_id` (the underlying card, shared across every owner). Naming symmetry
with the request field `card_ids` suggested the latter — that guess was
**wrong**. A live call sending `card_id` values returned **HTTP 200** with
`{ discarded_count: 0, failed: [...one entry per id, every one "card_not_owned"...] }`.
Nothing was actually discarded, and nothing in the HTTP status said so.

`serve-review.mjs` now sends `id` (the row id) under the site's own
`card_ids` request key — the key name is the site's contract; it does not
describe what it semantically holds. Confirmed against a real single-card
discard (see `data/discard-audit.log`, and independently re-fetched the live
collection afterward to confirm the card was actually gone, not just that the
response claimed so).

**The lesson that matters beyond this one field**: this endpoint returns 200
for a call that discarded nothing. Any code calling it — this UI included —
has to read `discarded_count`/`failed` from the body, never treat HTTP status
as the success signal. `parseDiscardResult` in `serve-review.mjs` is where
that happens; `pruneFromGroupedFile` is only ever called with confirmed
`succeededIds`, never the raw request list, for exactly this reason.

## Rarity order

Empirically observed via `sort=rarity` (highest first): `L > UR > SR > R >
PC > C`. Hardcoded as `RARITY_ORDER` in `build-grouped.mjs`. If the site adds
a tier this doesn't know about, the build script prints a warning naming it
rather than silently mis-sorting.
