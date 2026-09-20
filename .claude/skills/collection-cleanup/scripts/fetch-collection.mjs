#!/usr/bin/env node
// Pulls the user's ENTIRE card collection from wiki-masters.com by paginating
// GET /api/my-collection?sort=rarity&page=N until a short page ends it, and
// writes the raw result to data/collection-raw.json.
//
// Read-only. Never touches bulk-discard. Run from the repo root:
//   node .claude/skills/collection-cleanup/scripts/fetch-collection.mjs
//
// Reuses the bot's own auth plumbing (dist/config.js, dist/session.js) rather
// than reimplementing cookie handling -- one source of truth for how we talk
// to this site.

import { mkdirSync, writeFileSync } from 'node:fs';
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

process.chdir(REPO_ROOT);
process.loadEnvFile?.('.env');

const cfg = loadConfig();
configureLogger(cfg.logLevel, [cfg.password, cfg.cookie].filter(Boolean));

// The listing endpoint reads the same session cookie as everything else, and
// this script may run long after the last refresh, so make sure it is fresh
// (and persist the rotated refresh token) before the first call.
const session = await ensureFreshSession(cfg);
if (!session) {
  console.error(
    'No saved session found. Run `npm run import-cookie` or `npm run login` first.',
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const collection = [];
let total;
let rarityCounts;

for (let page = 0; ; page++) {
  // stats=1 only on the first page: it is the one call that returns the
  // authoritative total and per-rarity counts, used below to sanity-check
  // that pagination actually collected everything.
  const statsFlag = page === 0 ? 1 : 0;
  const result = await probeSession(
    cfg,
    `/api/my-collection?sort=rarity&page=${page}&stats=${statsFlag}`,
  );

  if (result.kind !== 'json') {
    console.error(`Unexpected response on page ${page}: ${result.kind} (status ${result.status})`);
    if ('snippet' in result) console.error(result.snippet);
    process.exit(1);
  }

  const body = result.body;
  const items = Array.isArray(body.collection) ? body.collection : [];
  if (page === 0) {
    total = body.total ?? undefined;
    rarityCounts = body.rarityCounts ?? undefined;
  }

  collection.push(...items);
  log.info('fetched collection page', { page, items: items.length, runningTotal: collection.length });

  if (items.length < PAGE_SIZE) break; // short page = last page
  await sleep(PAGE_DELAY_MS);
}

if (typeof total === 'number' && total !== collection.length) {
  log.warn('pagination count does not match the API-reported total', {
    fetched: collection.length,
    apiTotal: total,
  });
}

const outPath = resolve(REPO_ROOT, 'data/collection-raw.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      total: total ?? collection.length,
      rarityCounts: rarityCounts ?? {},
      collection,
    },
    null,
    2,
  ),
);

log.info('wrote raw collection', { path: outPath, cards: collection.length });

// Print the distinct categories for the next step (theme classification) to
// consume. Cards with a null category fall back to their title so nothing is
// silently dropped from clustering.
const categories = new Map();
for (const item of collection) {
  const key = item.card?.category?.trim() || `(untitled: ${item.card?.wikipedia_title ?? item.card_id})`;
  categories.set(key, (categories.get(key) ?? 0) + 1);
}
const sorted = [...categories.entries()].sort((a, b) => b[1] - a[1]);

const categoriesPath = resolve(REPO_ROOT, 'data/collection-categories.json');
writeFileSync(categoriesPath, JSON.stringify(sorted.map(([category, count]) => ({ category, count })), null, 2));
log.info('wrote distinct categories for theme classification', {
  path: categoriesPath,
  uniqueCategories: sorted.length,
});
