#!/usr/bin/env node
// Local-only review server for the collection-cleanup UI.
//
//  GET  /                       -> public/index.html (and its assets)
//  GET  /api/collection         -> data/collection-grouped.json
//  POST /api/discard {card_ids} -> relays to the REAL
//                                   POST /api/user-cards/bulk-discard,
//                                   using the bot's own authenticated
//                                   session, and appends an audit line.
//
// The browser never sees the site's session cookie: it only ever talks to
// this local server, which is the one thing that knows how to authenticate.
// That also sidesteps any cross-origin/cookie problem a page served from
// localhost would otherwise have calling wiki-masters.com directly.
//
// Binds to 127.0.0.1 only. Run from the repo root:
//   node .claude/skills/collection-cleanup/scripts/serve-review.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const distConfig = new URL('../../../../dist/config.js', import.meta.url);
const distSession = new URL('../../../../dist/session.js', import.meta.url);
const distLogger = new URL('../../../../dist/logger.js', import.meta.url);

const { loadConfig } = await import(distConfig);
const { ensureFreshSession, postJson } = await import(distSession);
const { configureLogger, log } = await import(distLogger);

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const PUBLIC_DIR = resolve(new URL('../public/', import.meta.url).pathname);
const GROUPED_PATH = resolve(REPO_ROOT, 'data/collection-grouped.json');
const RAW_PATH = resolve(REPO_ROOT, 'data/collection-raw.json');
const AUDIT_PATH = resolve(REPO_ROOT, 'data/discard-audit.log');
const DISCARD_PATH = '/api/user-cards/bulk-discard';

process.chdir(REPO_ROOT);
process.loadEnvFile?.('.env');
const cfg = loadConfig();
configureLogger(cfg.logLevel, [cfg.password, cfg.cookie].filter(Boolean));

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4545);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function serveStatic(req, res) {
  const path = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(PUBLIC_DIR, path);
  // Guard against ../ escaping the public dir.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

async function serveCollection(res) {
  if (!existsSync(GROUPED_PATH)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'data/collection-grouped.json does not exist yet -- run fetch-collection.mjs then build-grouped.mjs' }));
    return;
  }
  const body = await readFile(GROUPED_PATH);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function audit(entry) {
  await mkdir(resolve(REPO_ROOT, 'data'), { recursive: true });
  await appendFile(AUDIT_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Removes the just-discarded cards from the on-disk grouped JSON, so a page
 * reload (or a second browser tab) sees the same state the current tab does
 * without needing a full re-fetch from the live site. Mirrors app.js's own
 * removeCardsFromData, but persisted server-side instead of in-memory only.
 *
 * Only ever called with ids the site actually confirmed discarding -- see
 * parseDiscardResult below. Pruning ids that were only *requested* would
 * desync the local file from a still-true state, in the same direction as
 * the bug this whole thing was written to fix in the first place.
 */
async function pruneFromGroupedFile(rowIds) {
  if (rowIds.length === 0) return;
  if (!existsSync(GROUPED_PATH)) return;
  const idSet = new Set(rowIds);
  let data;
  try {
    data = JSON.parse(await readFile(GROUPED_PATH, 'utf8'));
  } catch (error) {
    log.warn('could not read collection-grouped.json to prune it; leaving it as-is', { error: String(error) });
    return;
  }

  let removed = 0;
  for (const group of data.groups ?? []) {
    for (const theme of group.themes ?? []) {
      const before = theme.cards.length;
      theme.cards = theme.cards.filter((c) => !idSet.has(c.row_id));
      const delta = before - theme.cards.length;
      theme.count = theme.cards.length;
      group.count -= delta;
      removed += delta;
    }
  }
  data.total = (data.total ?? 0) - removed;

  await writeFile(GROUPED_PATH, JSON.stringify(data, null, 2));
  log.info('pruned discarded cards from collection-grouped.json', { removed, requested: rowIds.length });
}

/**
 * Also prune data/collection-raw.json, not just the grouped view.
 *
 * fetch-collection.mjs's incremental mode merges newly-added cards ON TOP OF
 * whatever is already in this file rather than replacing it -- so a
 * discarded card left in here would persist forever and reappear the next
 * time build-grouped.mjs regenerates the grouped view from it, silently
 * undoing this exact prune. Both files need to agree with reality.
 */
async function pruneFromRawFile(rowIds) {
  if (rowIds.length === 0) return;
  if (!existsSync(RAW_PATH)) return;
  const idSet = new Set(rowIds);
  let data;
  try {
    data = JSON.parse(await readFile(RAW_PATH, 'utf8'));
  } catch (error) {
    log.warn('could not read collection-raw.json to prune it; leaving it as-is', { error: String(error) });
    return;
  }
  const before = data.collection?.length ?? 0;
  data.collection = (data.collection ?? []).filter((item) => !idSet.has(item.id));
  data.total = data.collection.length;
  await writeFile(RAW_PATH, JSON.stringify(data, null, 2));
  log.info('pruned discarded cards from collection-raw.json', { removed: before - data.collection.length });
}

/**
 * The site returns 200 with a JSON body EVEN WHEN EVERY CARD FAILS -- a live
 * test sent 33 ids and got back { discarded_count: 0, failed: [...33 entries
 * with error "card_not_owned"...] }. HTTP status alone is not a success
 * signal for this endpoint; the body has to be read.
 *
 * requestedIds and the response's failed[].card_id are matched positionally
 * as a fallback if the count doesn't line up, since the response's own
 * per-entry id field is just an echo of whatever we sent (confusingly still
 * called "card_id" in the response schema even though we send row ids under
 * that field -- see the id-field note on the postJson call below).
 */
function parseDiscardResult(requestedIds, body) {
  const failedEntries = Array.isArray(body?.failed) ? body.failed : [];
  const failedIds = new Set(failedEntries.map((f) => f.card_id ?? f.id).filter(Boolean));
  const failed = failedEntries.map((f) => ({ id: f.card_id ?? f.id, error: f.error ?? 'unknown' }));
  const succeededIds = requestedIds.filter((id) => !failedIds.has(id));
  const discardedCount = typeof body?.discarded_count === 'number' ? body.discarded_count : succeededIds.length;
  return { succeededIds, failed, discardedCount };
}

async function handleDiscard(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }

  // Named row_ids, not card_ids, because that's genuinely what these are --
  // see the note on the postJson call below for why.
  const rowIds = Array.isArray(payload?.row_ids) ? payload.row_ids.filter((x) => typeof x === 'string') : [];
  if (rowIds.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'row_ids must be a non-empty array of strings' }));
    return;
  }

  log.info('discard requested from the review UI', { count: rowIds.length });

  try {
    // The UI may sit open for a long time; make sure the token used for this
    // call is fresh rather than trusting whatever was last loaded at server
    // start.
    await ensureFreshSession(cfg);
  } catch (error) {
    await audit({ requested: rowIds, outcome: 'session-refresh-failed', error: String(error) });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `could not refresh the session: ${String(error)}` }));
    return;
  }

  // NOTE on the id field, RESOLVED by a live test (not a guess -- see
  // discard-audit.log entries from 2026-09-20): the collection API returns
  // each row with both an `id` (this specific owned copy) and a `card_id`
  // (the underlying card). Sending card_id values under the site's own
  // "card_ids" request field returned 200 with discarded_count: 0 and every
  // single id marked "card_not_owned" -- the site's field is misleadingly
  // named; it actually wants the row id. So: row ids in, still under the
  // site's own "card_ids" key, because that field name is the site's
  // contract, not a description of what it semantically holds.
  const result = await postJson(cfg, DISCARD_PATH, { card_ids: rowIds });

  await audit({
    requested: rowIds,
    outcome: result.kind,
    status: result.status,
    body: result.kind === 'json' ? result.body : ('snippet' in result ? result.snippet : undefined),
  });

  if (result.kind === 'json') {
    const { succeededIds, failed, discardedCount } = parseDiscardResult(rowIds, result.body);
    log.info('discard call completed', {
      requested: rowIds.length,
      discardedCount,
      failed: failed.length,
      status: result.status,
    });

    await pruneFromGroupedFile(succeededIds).catch((error) =>
      log.warn('discard succeeded but pruning collection-grouped.json failed', { error: String(error) }),
    );
    await pruneFromRawFile(succeededIds).catch((error) =>
      log.warn('discard succeeded but pruning collection-raw.json failed', { error: String(error) }),
    );

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: result.status, discardedCount, succeededIds, failed, raw: result.body }));
    return;
  }

  log.error('discard call did not return JSON', result);
  res.writeHead(200, { 'content-type': 'application/json' }); // 200 so the browser reads the JSON error body
  res.end(
    JSON.stringify({
      ok: false,
      status: result.status,
      error:
        result.kind === 'unauthenticated'
          ? 'session was rejected -- re-import a cookie and reload'
          : result.kind === 'human-verification'
            ? 'the site wants a fresh human verification before this will work'
            : ('snippet' in result ? result.snippet : result.kind),
    }),
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/collection') return void (await serveCollection(res));
    if (req.method === 'POST' && req.url === '/api/discard') return void (await handleDiscard(req, res));
    if (req.method === 'GET') return void (await serveStatic(req, res));
    res.writeHead(405).end('method not allowed');
  } catch (error) {
    log.error('request handler crashed', { error: String(error) });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(error) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log.info('collection-cleanup review server ready', { url: `http://127.0.0.1:${PORT}` });
  console.log(`\nOpen: http://127.0.0.1:${PORT}\n`);
});
