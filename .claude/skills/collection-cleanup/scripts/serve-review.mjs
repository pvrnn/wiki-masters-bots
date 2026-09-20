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
import { readFile, appendFile, mkdir } from 'node:fs/promises';
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

async function handleDiscard(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }

  const cardIds = Array.isArray(payload?.card_ids) ? payload.card_ids.filter((x) => typeof x === 'string') : [];
  if (cardIds.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'card_ids must be a non-empty array of strings' }));
    return;
  }

  log.info('discard requested from the review UI', { count: cardIds.length });

  try {
    // The UI may sit open for a long time; make sure the token used for this
    // call is fresh rather than trusting whatever was last loaded at server
    // start.
    await ensureFreshSession(cfg);
  } catch (error) {
    await audit({ requested: cardIds, outcome: 'session-refresh-failed', error: String(error) });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `could not refresh the session: ${String(error)}` }));
    return;
  }

  // NOTE on the id field: the collection API returns each row with both an
  // `id` (this specific owned copy) and a `card_id` (the underlying card).
  // This is sent as card_id, inferred from the request field being named
  // "card_ids" (plural of the response's own "card_id" field) -- not
  // empirically confirmed against a real call. If a live test shows the
  // server wants the row id instead, change `card.card_id` below to
  // `card.row_id`.
  const result = await postJson(cfg, DISCARD_PATH, { card_ids: cardIds });

  await audit({
    requested: cardIds,
    outcome: result.kind,
    status: result.status,
    body: result.kind === 'json' ? result.body : ('snippet' in result ? result.snippet : undefined),
  });

  if (result.kind === 'json') {
    log.info('discard succeeded', { count: cardIds.length, status: result.status });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: result.status, body: result.body }));
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
