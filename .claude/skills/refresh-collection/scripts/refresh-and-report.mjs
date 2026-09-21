#!/usr/bin/env node
// Refreshes the collection-cleanup review page: re-fetches the live
// collection, re-classifies it into data/collection-grouped.json, makes sure
// the review server is actually running, and reports what changed --
// instead of the two-manual-script-plus-manual-server-check dance this
// replaces.
//
// Run from the repo root:
//   node .claude/skills/refresh-collection/scripts/refresh-and-report.mjs [port]

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const CLEANUP_SCRIPTS = resolve(REPO_ROOT, '.claude/skills/collection-cleanup/scripts');
const RAW_PATH = resolve(REPO_ROOT, 'data/collection-raw.json');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4545);

function previousTotal() {
  if (!existsSync(RAW_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(RAW_PATH, 'utf8')).total;
  } catch {
    return undefined;
  }
}

/** Runs a child script to completion and returns its combined stdout+stderr text. */
function runToCompletion(scriptPath, args = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [scriptPath, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${scriptPath} exited ${code}:\n${output}`));
    });
    child.on('error', rejectPromise);
  });
}

/** Same trick as open-packs' parser: the logger's message text never contains '{'. */
function extractLoggerMeta(output, message) {
  const line = output.split('\n').find((l) => l.includes(message) && l.includes('{'));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(line.indexOf('{')));
  } catch {
    return undefined;
  }
}

async function isServerUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/collection`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerRunning(port) {
  if (await isServerUp(port)) return { started: false };

  const child = spawn('node', [resolve(CLEANUP_SCRIPTS, 'serve-review.mjs'), String(port)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    detached: true,
  });
  child.unref(); // survive after this script exits

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isServerUp(port)) return { started: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { started: true, notConfirmed: true };
}

const before = previousTotal();

console.log('Récupération de la collection…');
const fetchOutput = await runToCompletion(resolve(CLEANUP_SCRIPTS, 'fetch-collection.mjs'));
const fetchMeta = extractLoggerMeta(fetchOutput, 'wrote raw collection');
const totalCards = fetchMeta?.cards;

console.log('Classification par thème…');
const buildOutput = await runToCompletion(resolve(CLEANUP_SCRIPTS, 'build-grouped.mjs'));
const autresMatch = /Autres \/ non class[ée]": (\d+) cards \(([\d.]+)%\)/.exec(buildOutput);
const autresCount = autresMatch ? Number(autresMatch[1]) : undefined;
const autresPct = autresMatch ? autresMatch[2] : undefined;

const server = await ensureServerRunning(PORT);

console.log('\n--- Résumé ---');
if (typeof totalCards === 'number') {
  const delta = typeof before === 'number' ? totalCards - before : undefined;
  const deltaTxt = delta === undefined ? '' : delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : ' (inchangé)';
  console.log(`Cartes : ${totalCards}${deltaTxt}`);
} else {
  console.log('Cartes : nombre non détecté dans la sortie -- vérifiez data/collection-raw.json');
}
if (autresCount !== undefined) {
  console.log(`Non classées ("Autres") : ${autresCount} (${autresPct}%)`);
}
if (server.started && !server.notConfirmed) {
  console.log(`Serveur : démarré -> http://127.0.0.1:${PORT}`);
} else if (server.started && server.notConfirmed) {
  console.log(`Serveur : lancé mais pas encore confirmé opérationnel -- réessayez http://127.0.0.1:${PORT} dans un instant`);
} else {
  console.log(`Serveur : déjà en cours -> http://127.0.0.1:${PORT}`);
}
console.log(`\nOuvrez ou rechargez : http://127.0.0.1:${PORT}`);
