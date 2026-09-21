#!/usr/bin/env node
// Pulls the user's card collection from wiki-masters.com and writes/updates
// data/collection-raw.json. Two modes:
//
//   incremental (default, once a prior fetch exists): paginates
//   GET /api/my-collection?sort=added&page=N -- newest obtained_at first --
//   and stops as soon as it reaches cards it already has, instead of
//   re-walking all 13+ pages every time. Falls back to a full fetch
//   automatically if there's nothing to be incremental against yet.
//
//   full (--full, or automatically on a first run): paginates
//   ?sort=rarity&page=N until a short page ends it, exactly as before.
//
// Read-only. Never touches bulk-discard. Run from the repo root:
//   node .claude/skills/collection-cleanup/scripts/fetch-collection.mjs [--full]
//
// Reuses the bot's own auth plumbing (dist/config.js, dist/session.js) rather
// than reimplementing cookie handling -- one source of truth for how we talk
// to this site.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const distConfig = new URL('../../../../dist/config.js', import.meta.url);
const distSession = new URL('../../../../dist/session.js', import.meta.url);
const distLogger = new URL('../../../../dist/logger.js', import.meta.url);

const { loadConfig } = await import(distConfig);
const { ensureFreshSession, probeSession } = await import(distSession);
const { configureLogger, log } = await import(distLogger);

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const PAGE_SIZE = 50;
// Politeness delay between page fetches. This is a listing endpoint, not the
// slow pack-opener, so it can be much shorter than the pack loop's delay --
// but a bare loop with zero delay is still bad manners against someone else's
// server.
const PAGE_DELAY_MS = 250;
const RAW_PATH = resolve(REPO_ROOT, 'data/collection-raw.json');
const SYNC_STATE_PATH = resolve(REPO_ROOT, 'data/collection-sync-state.json');
const CATEGORIES_PATH = resolve(REPO_ROOT, 'data/collection-categories.json');

const forceFull = process.argv.includes('--full');

process.chdir(REPO_ROOT);
process.loadEnvFile?.('.env');

const cfg = loadConfig();
configureLogger(cfg.logLevel, [cfg.password, cfg.cookie].filter(Boolean));

// The listing endpoint reads the same session cookie as everything else, and
// this script may run long after the last refresh, so make sure it is fresh
// (and persist the rotated refresh token) before the first call.
const session = await ensureFreshSession(cfg);
if (!session) {
  console.error('No saved session found. Run `npm run import-cookie` or `npm run login` first.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log.warn('could not read existing file; ignoring it', { path, error: String(error) });
    return undefined;
  }
}

// The listing endpoint has shown sporadic transient 500s in practice (a
// different page failing on each retry, i.e. not a systematic problem with
// one page) -- worth a short retry rather than making every failure a manual
// re-run of the whole fetch.
const MAX_RETRIES_PER_PAGE = 3;

async function fetchPage(sort, page, statsFlag) {
  for (let attempt = 1; ; attempt++) {
    const result = await probeSession(cfg, `/api/my-collection?sort=${sort}&page=${page}&stats=${statsFlag}`);
    if (result.kind === 'json') return result;

    const retryable = result.kind === 'retryable' || result.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES_PER_PAGE) return result;

    const wait = 1000 * 2 ** (attempt - 1);
    log.warn('transient failure fetching a collection page; retrying', {
      page,
      attempt,
      kind: result.kind,
      status: result.status,
      waitMs: wait,
    });
    await sleep(wait);
  }
}

function fail(page, result) {
  console.error(`Unexpected response on page ${page}: ${result.kind} (status ${result.status})`);
  if ('snippet' in result) console.error(result.snippet);
  if ('detail' in result) console.error(result.detail);
  process.exit(1);
}

/** Full walk of every page, sorted by rarity (order doesn't matter for a full fetch). */
async function fetchFull() {
  const collection = [];
  let total;
  let rarityCounts;

  for (let page = 0; ; page++) {
    const statsFlag = page === 0 ? 1 : 0; // only page 0 needs the authoritative totals
    const result = await fetchPage('rarity', page, statsFlag);
    if (result.kind !== 'json') fail(page, result);

    const items = Array.isArray(result.body.collection) ? result.body.collection : [];
    if (page === 0) {
      total = result.body.total ?? undefined;
      rarityCounts = result.body.rarityCounts ?? undefined;
    }
    collection.push(...items);
    log.info('fetched collection page', { mode: 'full', page, items: items.length, runningTotal: collection.length });

    if (items.length < PAGE_SIZE) break; // short page = last page
    await sleep(PAGE_DELAY_MS);
  }

  if (typeof total === 'number' && total !== collection.length) {
    log.warn('pagination count does not match the API-reported total', { fetched: collection.length, apiTotal: total });
  }
  return { collection, total: total ?? collection.length, rarityCounts: rarityCounts ?? {} };
}

/**
 * Walks pages sorted newest-added-first, stopping as soon as it reaches
 * cards obtained at or before the watermark -- everything past that point is
 * already in the existing file. Degrades gracefully to a full walk if the
 * watermark is old enough (or wrong enough) that no boundary is ever found
 * before a short page ends it naturally.
 */
async function fetchIncremental(watermark) {
  const newItems = [];
  let total;
  let rarityCounts;
  let reachedBoundary = false;

  for (let page = 0; !reachedBoundary; page++) {
    const statsFlag = page === 0 ? 1 : 0;
    const result = await fetchPage('added', page, statsFlag);
    if (result.kind !== 'json') fail(page, result);

    const items = Array.isArray(result.body.collection) ? result.body.collection : [];
    if (page === 0) {
      total = result.body.total ?? undefined;
      rarityCounts = result.body.rarityCounts ?? undefined;
    }

    for (const item of items) {
      if (item.obtained_at && item.obtained_at <= watermark) {
        reachedBoundary = true;
        break; // sort=added is newest-first, so everything after this is older too
      }
      newItems.push(item);
    }

    log.info('fetched collection page', { mode: 'incremental', page, newSoFar: newItems.length, reachedBoundary });

    if (items.length < PAGE_SIZE) break; // ran out of pages before finding the boundary -- fine, that's everything
    if (!reachedBoundary) await sleep(PAGE_DELAY_MS);
  }

  return { newItems, total, rarityCounts };
}

const existingRaw = forceFull ? undefined : readJsonIfExists(RAW_PATH);
const syncState = forceFull ? undefined : readJsonIfExists(SYNC_STATE_PATH);

let collection;
let total;
let rarityCounts;
let mode;

if (existingRaw?.collection && syncState?.lastSeenObtainedAt) {
  mode = 'incremental';
  const { newItems, total: freshTotal, rarityCounts: freshCounts } = await fetchIncremental(syncState.lastSeenObtainedAt);

  // Merge new items on top of what's already on disk. Dedupe by row id
  // defensively -- shouldn't happen given the watermark logic, but a
  // duplicate silently doubling a card in the view would be a worse failure
  // mode than a redundant filter.
  const byId = new Map(existingRaw.collection.map((item) => [item.id, item]));
  for (const item of newItems) byId.set(item.id, item);
  collection = [...byId.values()];
  total = freshTotal ?? collection.length;
  rarityCounts = freshCounts ?? existingRaw.rarityCounts ?? {};

  log.info('incremental fetch complete', { newCards: newItems.length, totalNow: collection.length });
} else {
  mode = 'full';
  if (forceFull) log.info('full fetch requested (--full)');
  else log.info('no prior fetch to sync against; doing a full fetch');
  ({ collection, total, rarityCounts } = await fetchFull());
}

const lastSeenObtainedAt = collection.reduce(
  (max, item) => (item.obtained_at && (!max || item.obtained_at > max) ? item.obtained_at : max),
  syncState?.lastSeenObtainedAt,
);

mkdirSync(dirname(RAW_PATH), { recursive: true });
writeFileSync(
  RAW_PATH,
  JSON.stringify({ fetchedAt: new Date().toISOString(), total, rarityCounts, collection }, null, 2),
);
writeFileSync(
  SYNC_STATE_PATH,
  JSON.stringify({ lastRefreshAt: new Date().toISOString(), lastSeenObtainedAt, mode }, null, 2),
);

log.info('wrote raw collection', { path: RAW_PATH, cards: collection.length, mode });

// Print the distinct categories for the next step (theme classification) to
// consume. Cards with a null category fall back to their title so nothing is
// silently dropped from clustering.
const categories = new Map();
for (const item of collection) {
  const key = item.card?.category?.trim() || `(untitled: ${item.card?.wikipedia_title ?? item.card_id})`;
  categories.set(key, (categories.get(key) ?? 0) + 1);
}
const sorted = [...categories.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync(CATEGORIES_PATH, JSON.stringify(sorted.map(([category, count]) => ({ category, count })), null, 2));
log.info('wrote distinct categories for theme classification', { path: CATEGORIES_PATH, uniqueCategories: sorted.length });
