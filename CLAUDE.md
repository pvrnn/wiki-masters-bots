# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A bot that logs in to wiki-masters.com (a Wikipedia-based card game), drains its
card-pack queue on a schedule, and — via a separate set of scripts — lets the user
review and bulk-discard cards from their collection through a local web UI. Two
independent surfaces share the same auth/session code: the CLI bot (`src/`, compiled to
`dist/`) and a handful of standalone scripts under `.claude/skills/*/scripts/` that
import directly from `dist/`.

## Commands

```bash
npm run build       # tsc -> dist/. Run this after any src/ change before testing the CLI
npm run typecheck   # tsc --noEmit
npm run run:once    # one pack-opening pass, then exit
npm start           # daemon mode: run now, then every WM_INTERVAL_MINUTES (61)
npm run login       # password + Turnstile browser login (rarely used — see below)
npm run probe       # verify the saved session without opening any packs
npm run import-cookie -- --file cookie.txt   # the normal way to establish a session
```

There is no lint config and no test framework in this repo — don't invent commands for
either. `npm run typecheck` is the fast correctness check; there's no faster single-file
equivalent since `tsc` type-checks the whole project graph at once.

The `.claude/skills/*/scripts/*.mjs` files are plain Node scripts, not compiled — run
them directly with `node path/to/script.mjs`, and re-run `npm run build` first if you've
touched anything in `src/` they import from.

## Architecture

### Two authentication paths, one is effectively dead

The site's login form carries a Cloudflare Turnstile checkbox that never worked
reliably (`src/browser.ts`, `src/login.ts`, `src/turnstile.ts` — the Playwright-driven
password flow, `npm run login`). In practice **only the cookie flow is used**: paste
`document.cookie` from an already-logged-in browser via `npm run import-cookie`, which
decodes the chunked `sb-<project>-auth-token.0`/`.1` cookie (`src/supabase.ts`,
`decodeSession`) into a Playwright `storageState` file at `data/storage-state.json`
(0600 permissions). From then on `ensureFreshSession` (`src/session.ts`) refreshes the
60-minute access token before each run and persists the rotated refresh token — Supabase
rotates refresh tokens on every use, so losing a persisted rotation breaks the chain
permanently. There is **no Cloudflare WAF** protecting the API itself (confirmed via a
HAR capture) — only the login form has Turnstile — so the browser-automation code paths
are essentially dead weight kept for the rare case the cookie flow can't be used.

### The API surface and its real behavior, not its documented one

Everything talks to Next.js API routes on wiki-masters.com (not directly to Supabase,
except for the auth refresh itself) via `probeSession`/`postJson` in `src/session.ts`,
which build a Playwright `APIRequestContext` from the saved storageState — no browser
launch, which is what makes the hourly schedule cheap. Two behaviors worth knowing before
trusting this API's surface-level contract:

- `POST /api/user-cards/bulk-discard` (`{ card_ids: [...] }`) returns **HTTP 200 even
  when every card fails** (`{ discarded_count: 0, failed: [{card_id, error}, ...] }`).
  Never treat a 200 as success for this endpoint — read the body
  (`parseDiscardResult` in `.claude/skills/collection-cleanup/scripts/serve-review.mjs`).
- Despite the request field being named `card_ids`, the endpoint actually wants each
  collection row's own `id` (not the `card_id` of the underlying card both are present
  on every `/api/my-collection` row). Confirmed live, not inferred from naming.
- `/api/packs/open` gates behind periodic human verification
  (`pack_human_verified_at`, observed holding ~12h) and the account carries visible
  anti-automation fields (`cheat_strikes`, `activity_blocked_until`,
  `last_sanction_type`) that the bot checks and refuses to run against
  (`assertNotSanctioned` in `src/run.ts`).

### Error handling has a real security constraint, not just a style preference

Playwright's error message for a failed network request embeds the full request —
every header, including the session cookie — after the first newline. Every call site
that can see a raw network error from a live request (`probeSession`, `postJson`,
`supabaseCall`, and both top-level catch-alls in `index.ts`/`scheduler.ts`) must pass it
through `safeErrorMessage` (`src/util.ts`, keeps only the first line) before it can reach
a log line, a notification, or stdout. This isn't defensive-programming paranoia — an
uncaught version of exactly this leaked a live session to a terminal during development.
Apply the same pattern at any new call site that touches a live request.

### The pack-opening loop assumes nothing about the response shape

`drainPacks` (`src/packs.ts`) was written before the real `/api/packs/open` response was
observed, so it never fully trusts it: an iteration cap, a wall-clock budget under the
schedule interval, backoff on transient errors, and a stall detector that aborts if
`packs_remaining` stops decreasing. `readRemaining()` is the one function to touch if the
response shape ever changes.

### The `.claude/skills/` scripts are a second app built on the first

`collection-cleanup`, `open-packs`, and `refresh-collection` are standalone `.mjs`
scripts that `import()` from `dist/*.js` by relative `import.meta.url` path (not `npm`
packages), so they always resolve regardless of the caller's cwd but need `npm run build`
to be current. `collection-cleanup` in particular is a small full-stack app in miniature:
`fetch-collection.mjs` paginates the collection (incrementally via `sort=added` and a
watermark in `data/collection-sync-state.json` once a prior fetch exists, falling back to
a full `sort=rarity` walk otherwise), `classify-theme.mjs` buckets cards into themes with
an ordered regex list (JS `\b` silently never matches immediately next to an accented
character — à, é, î, œ — a real bug hit while tuning these rules; drop the boundary
rather than anchor on it), `build-grouped.mjs` produces the rarity→theme→card JSON, and
`serve-review.mjs` is a zero-dependency `node:http` server (127.0.0.1-only) that serves
the static UI and is the *only* thing in the whole skill allowed to call
`bulk-discard` — a rule stated explicitly in that skill's `SKILL.md` because the call is
irreversible. Discards prune **both** `data/collection-raw.json` and
`data/collection-grouped.json` on success; raw has to stay pruned too because incremental
fetch merges new cards on top of it rather than replacing it wholesale.

### Everything under `data/` is gitignored and personal

Session cookies, the pull/collection caches, the discard audit log, and the login
backoff ledger all live under `data/`. Never read these into anything that leaves the
local machine (a commit, a printed log meant for sharing) without checking what's in
them first.
