import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { log } from './logger.js';

/**
 * Appends the raw response of each opened pack to the all-pulled log as one
 * JSON line (JSONL), timestamped. Append-only, so `tail`/`jq` just work.
 * A failure to write is logged and swallowed: bookkeeping must never abort a
 * run that has already opened (and spent) a pack.
 */
export function recordPulls(cfg: Config, pack: number, body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  try {
    mkdirSync(dirname(cfg.allPulledPath), { recursive: true });
    appendFileSync(
      cfg.allPulledPath,
      `${JSON.stringify({ pulled_at: new Date().toISOString(), pack, ...body })}\n`,
    );
  } catch (error) {
    log.warn('could not write the all-pulled log', { path: cfg.allPulledPath, error: String(error) });
  }
}
