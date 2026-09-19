import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { log } from './logger.js';
import { backoffMs } from './util.js';

export type Ledger = {
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
  nextLoginAllowedAt?: string;
  lastSuccessAt?: string;
};

const EMPTY: Ledger = { consecutiveFailures: 0 };

export function readLedger(cfg: Config): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(cfg.ledgerPath, 'utf8')) as Partial<Ledger>;
    return {
      consecutiveFailures: Number(parsed.consecutiveFailures) || 0,
      ...(parsed.lastFailureAt ? { lastFailureAt: parsed.lastFailureAt } : {}),
      ...(parsed.lastFailureReason ? { lastFailureReason: parsed.lastFailureReason } : {}),
      ...(parsed.nextLoginAllowedAt ? { nextLoginAllowedAt: parsed.nextLoginAllowedAt } : {}),
      ...(parsed.lastSuccessAt ? { lastSuccessAt: parsed.lastSuccessAt } : {}),
    };
  } catch {
    // Missing or corrupt: a fresh ledger is the right recovery, not a crash.
    return { ...EMPTY };
  }
}

function write(cfg: Config, ledger: Ledger): void {
  mkdirSync(dirname(cfg.ledgerPath), { recursive: true });
  writeFileSync(cfg.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * When a login may next be attempted. Only login is ever suppressed -- opening
 * packs on a session that still works is untouched by backoff.
 */
export function loginBlockedUntil(cfg: Config, now = Date.now()): Date | undefined {
  const { nextLoginAllowedAt } = readLedger(cfg);
  if (!nextLoginAllowedAt) return undefined;
  const until = new Date(nextLoginAllowedAt);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now) return undefined;
  return until;
}

/**
 * Records a failed login and lengthens the wait: 2h, 4h, 8h ... capped at 24h.
 * Retrying a refused Turnstile every hour only degrades the IP's reputation.
 */
export function recordLoginFailure(cfg: Config, reason: string): Date {
  const previous = readLedger(cfg);
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const wait = backoffMs(consecutiveFailures, cfg.loginBackoffBaseMs, cfg.loginBackoffMaxMs);
  const nextAllowed = new Date(Date.now() + wait);
  write(cfg, {
    consecutiveFailures,
    lastFailureAt: new Date().toISOString(),
    lastFailureReason: reason,
    nextLoginAllowedAt: nextAllowed.toISOString(),
    ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
  });
  log.warn('login failure recorded; backing off', {
    consecutiveFailures,
    reason,
    nextLoginAllowedAt: nextAllowed.toISOString(),
  });
  return nextAllowed;
}

export function recordLoginSuccess(cfg: Config): void {
  write(cfg, { consecutiveFailures: 0, lastSuccessAt: new Date().toISOString() });
}
