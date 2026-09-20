#!/usr/bin/env node
// Runs the pack-opener bot (`dist/index.js run`) once, parses its structured
// log output, and prints a clean human-readable summary instead of raw JSON
// log lines -- what "open the packs and tell me what happened" needs.
//
// Cooperates safely with the background daemon: it goes through the same
// lock file (acquireLock in src/lock.ts), so if the daemon is mid-run this
// invocation just reports "already running, nothing new" rather than
// colliding with it.
//
// Run from the repo root:
//   node .claude/skills/open-packs/scripts/run-and-report.mjs
//
// Also writes data/last-run-report.json (machine-readable) after every
// invocation, so a caller can inspect the last outcome without re-running.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);

const RARITY_LABEL = { L: 'Légendaire', UR: 'Ultra Rare', SR: 'Super Rare', R: 'Rare', PC: 'Peu Commune', C: 'Commune' };
const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
const rarityRank = (r) => { const i = RARITY_ORDER.indexOf(r); return i === -1 ? RARITY_ORDER.length : i; };

/**
 * The logger (src/logger.ts) always writes one line as:
 *   <ISO timestamp> <LEVEL padded to 5> <message>[ <JSON meta>]
 * and meta, when present, is always a trailing JSON object/array -- the
 * message text itself never contains a literal '{'. That lets us split on
 * the first '{' rather than needing a real log-format parser.
 */
function parseLine(line) {
  const m = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/.exec(line);
  if (!m) return undefined;
  const [, timestamp, level, rest] = m;
  const braceIdx = rest.indexOf('{');
  const message = (braceIdx === -1 ? rest : rest.slice(0, braceIdx)).trim();
  let meta;
  if (braceIdx !== -1) {
    try {
      meta = JSON.parse(rest.slice(braceIdx));
    } catch {
      meta = undefined; // malformed/truncated meta -- keep the message, drop the data
    }
  }
  return { timestamp, level, message, meta };
}

function runBot() {
  return new Promise((resolvePromise) => {
    const child = spawn('node', ['--env-file-if-exists=.env', 'dist/index.js', 'run'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events = [];
    let buffer = '';
    const onChunk = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed) events.push(parsed);
        else if (line.trim()) events.push({ timestamp: '', level: 'RAW', message: line, meta: undefined });
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('close', (code) => {
      if (buffer.trim()) {
        const parsed = parseLine(buffer);
        events.push(parsed ?? { timestamp: '', level: 'RAW', message: buffer, meta: undefined });
      }
      resolvePromise({ code, events });
    });
  });
}

function summarize({ code, events }) {
  const cardsPulled = [];
  let packsBefore;
  let packsAfter;
  let opened = 0;
  let skipped = false;
  let stopReason;
  const notable = []; // every WARN/ERROR, verbatim -- resilient to future log-message changes

  for (const e of events) {
    if (e.level === 'WARN' || e.level === 'ERROR') {
      notable.push(e);
      if (e.message === 'another run holds the lock; skipping this one') skipped = true;
      if (e.message === 'stopped before the queue was empty') stopReason = e.meta?.stopReason;
    }
    if (e.message === 'account pre-flight' && typeof e.meta?.packsRemaining === 'number') {
      packsBefore = e.meta.packsRemaining;
    }
    if (e.message === 'opened a pack' && e.meta) {
      opened = e.meta.n ?? opened;
      packsAfter = e.meta.remaining;
      const cards = e.meta.response?.cards;
      if (Array.isArray(cards)) {
        for (const c of cards) {
          cardsPulled.push({
            title: c.wikipedia_title ?? c.title ?? '(sans titre)',
            rarity: c.rarity ?? '?',
            category: c.category ?? null,
            atk: c.atk ?? null,
            def: c.def ?? null,
          });
        }
      }
    }
    if (e.message === 'no packs available; nothing to do') {
      packsBefore = 0;
      packsAfter = 0;
    }
  }

  cardsPulled.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity));

  let status;
  if (skipped) status = 'skipped';
  else if (code === 0) status = 'ok';
  else if (code === 2) status = 'blocked';
  else if (code === 3) status = 'partial';
  else status = 'error';

  return { status, exitCode: code, packsBefore, packsAfter, opened, cardsPulled, stopReason, notable };
}

function printReport(summary) {
  const { status, packsBefore, packsAfter, opened, cardsPulled, stopReason, notable } = summary;

  const STATUS_LINE = {
    skipped: '⏳ Une autre exécution était déjà en cours (probablement le daemon) -- rien de nouveau à signaler, réessayez dans un instant.',
    ok: opened > 0 ? `✅ ${opened} paquet(s) ouvert(s), collection vidée.` : '✅ Aucun paquet disponible pour le moment.',
    blocked: '⛔ Bloqué -- authentification, vérification humaine, ou compte signalé. Voir les détails ci-dessous.',
    partial: `⚠️ Arrêté avant la fin de la file (${stopReason ?? 'raison inconnue'}). ${opened} paquet(s) ouvert(s) avant l'arrêt.`,
    error: '❌ Échec inattendu. Voir les détails ci-dessous.',
  };

  console.log(STATUS_LINE[status] ?? `(statut inconnu: ${status})`);

  if (typeof packsBefore === 'number') {
    console.log(`Paquets disponibles avant : ${packsBefore}`);
  }
  if (typeof packsAfter === 'number') {
    console.log(`Paquets restants après    : ${packsAfter}`);
  }

  if (cardsPulled.length > 0) {
    console.log(`\nCartes obtenues (${cardsPulled.length}) :`);
    for (const c of cardsPulled) {
      const label = RARITY_LABEL[c.rarity] ?? c.rarity;
      const stats = c.atk !== null && c.def !== null ? `  ATK ${c.atk} / DEF ${c.def}` : '';
      const cat = c.category ? ` — ${c.category}` : '';
      console.log(`  [${c.rarity.padEnd(2)}] ${label.padEnd(12)} ${c.title}${cat}${stats}`);
    }
  }

  if (notable.length > 0 && status !== 'skipped') {
    console.log(`\nAvertissements / erreurs :`);
    for (const n of notable) {
      console.log(`  ${n.level.padEnd(5)} ${n.message}`);
    }
  }
}

const REPORT_PATH = resolve(REPO_ROOT, 'data/last-run-report.json');

const { code, events } = await runBot();
const summary = summarize({ code, events });
printReport(summary);

mkdirSync(resolve(REPO_ROOT, 'data'), { recursive: true });
writeFileSync(
  REPORT_PATH,
  JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2),
);

process.exit(summary.status === 'skipped' ? 0 : code);
