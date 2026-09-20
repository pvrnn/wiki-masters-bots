import type { Config } from './config.js';
import {
  AuthExpiredError,
  CloudflareBlockedError,
  HumanVerificationRequiredError,
  PackRunAbortedError,
} from './errors.js';
import { log } from './logger.js';
import type { PackTransport } from './session.js';
import { backoffMs, jitteredDelay, sleep, truncate } from './util.js';
import { recordPulls } from './pullslog.js';

export type DrainSummary = {
  opened: number;
  remaining: number | undefined;
  stopReason: 'drained' | 'iteration-cap' | 'budget-exhausted';
};

/**
 * Pulls the pack count out of the response.
 *
 * The exact shape was never observed (the site is unreachable from the
 * development sandbox), so this is the single place to adjust if the real
 * payload nests it differently. Everything else keys off this one function.
 */
export function readRemaining(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidates: unknown[] = [];
  const top = body as Record<string, unknown>;
  candidates.push(top['packs_remaining'], top['packsRemaining']);
  for (const wrapper of ['data', 'result', 'user', 'account']) {
    const nested = top[wrapper];
    if (typeof nested === 'object' && nested !== null) {
      const inner = nested as Record<string, unknown>;
      candidates.push(inner['packs_remaining'], inner['packsRemaining']);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

/** A compact view of the response for the log, without dumping the whole payload. */
function summarize(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length <= 12 ? body : { keys: keys.slice(0, 12), truncatedKeys: keys.length };
}

/**
 * Opens packs until the API reports none remaining.
 *
 * Every exit is bounded. Because the response shape is unverified, the loop
 * refuses to run on without a decreasing count -- an unknown payload must never
 * turn into an unbounded hammering of a slow endpoint.
 */
export async function drainPacks(
  transport: PackTransport,
  cfg: Config,
  signal?: AbortSignal,
  /** Count from the profile pre-flight, so a stall is caught from the first open. */
  knownRemaining?: number,
): Promise<DrainSummary> {
  let opened = 0;
  let consecutiveErrors = 0;
  let stalls = 0;
  let unknownShapeStreak = 0;
  let lastRemaining: number | undefined = knownRemaining;
  const deadline = Date.now() + cfg.runBudgetMs;

  for (;;) {
    if (signal?.aborted) {
      throw new PackRunAbortedError('run cancelled while draining packs');
    }
    if (opened >= cfg.maxPacks) {
      log.warn('stopping: hit the iteration cap', { opened, maxPacks: cfg.maxPacks });
      return { opened, remaining: lastRemaining, stopReason: 'iteration-cap' };
    }
    if (Date.now() > deadline) {
      log.warn('stopping: run budget exhausted', { opened, runBudgetMs: cfg.runBudgetMs });
      return { opened, remaining: lastRemaining, stopReason: 'budget-exhausted' };
    }

    const result = await transport.openPack();

    switch (result.kind) {
      case 'cloudflare':
        throw new CloudflareBlockedError(
          `Cloudflare blocked the pack endpoint (status ${result.status}): ${result.snippet}`,
        );

      case 'human-verification':
        throw new HumanVerificationRequiredError(
          `the site wants a fresh human verification before opening more packs ` +
            `(status ${result.status}): ${result.snippet}`,
        );

      case 'unauthenticated':
        throw new AuthExpiredError(`session rejected with status ${result.status}`);

      case 'retryable': {
        consecutiveErrors += 1;
        if (consecutiveErrors > cfg.maxConsecutiveErrors) {
          throw new PackRunAbortedError(
            `giving up after ${consecutiveErrors} consecutive failures: ${result.detail}`,
          );
        }
        const wait = result.retryAfterMs ?? backoffMs(consecutiveErrors, 5_000, 60_000);
        log.warn('transient failure; backing off', {
          attempt: consecutiveErrors,
          status: result.status,
          detail: truncate(result.detail, 200),
          waitMs: wait,
        });
        await sleep(wait, signal);
        continue; // no pack was opened, so nothing else advances
      }

      case 'http-error':
        // The site gates pack opening behind a periodic human check
        // (`pack_human_verified_at`). Retrying cannot clear it.
        if (/human|verif|captcha|turnstile/i.test(result.snippet)) {
          throw new HumanVerificationRequiredError(
            `the site wants a fresh human verification before opening more packs ` +
              `(status ${result.status}): ${result.snippet}`,
          );
        }
        throw new PackRunAbortedError(
          `pack endpoint returned ${result.status}: ${result.snippet}`,
        );

      case 'json':
        break;
    }

    consecutiveErrors = 0;
    opened += 1;
    const remaining = readRemaining(result.body);
    log.info('opened a pack', {
      n: opened,
      status: result.status,
      ms: result.ms,
      remaining,
      response: summarize(result.body),
    });
    recordPulls(cfg, opened, result.body);

    if (remaining === 0) {
      log.info('all packs opened', { opened });
      return { opened, remaining: 0, stopReason: 'drained' };
    }

    if (remaining === undefined) {
      unknownShapeStreak += 1;
      if (unknownShapeStreak >= 2) {
        throw new PackRunAbortedError(
          'cannot find packs_remaining in the response, so there is no safe way to know ' +
            'when to stop; adjust readRemaining() to match the real payload',
        );
      }
      log.warn('response has no recognisable packs_remaining field', {
        response: summarize(result.body),
      });
    } else {
      unknownShapeStreak = 0;
      if (lastRemaining !== undefined && remaining >= lastRemaining) {
        stalls += 1;
        log.warn('packs_remaining did not go down', { previous: lastRemaining, remaining, stalls });
        if (stalls >= cfg.stallLimit) {
          throw new PackRunAbortedError(
            `packs_remaining stuck at ${remaining} across ${stalls} opens; stopping rather ` +
              'than hammering the endpoint',
          );
        }
      } else {
        stalls = 0;
      }
      lastRemaining = remaining;
    }

    // Between calls only -- never after the one that finished the queue.
    await sleep(jitteredDelay(cfg.openDelayMinMs, cfg.openDelayMaxMs), signal);
  }
}
