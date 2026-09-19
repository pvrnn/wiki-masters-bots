import type { Config } from './config.js';
import {
  AuthExpiredError,
  CloudflareBlockedError,
  LoginSuppressedError,
} from './errors.js';
import { acquireLock } from './lock.js';
import { log } from './logger.js';
import { drainPacks, type DrainSummary } from './packs.js';
import {
  acquireBrowserTransport,
  acquireTransport,
  type PackTransport,
} from './session.js';

export type RunOutcome =
  | { status: 'drained'; summary: DrainSummary }
  | { status: 'partial'; summary: DrainSummary }
  | { status: 'skipped' }
  | { status: 'suppressed'; until: Date };

/**
 * One complete pass: take the lock, get a session, drain the packs, save the
 * refreshed cookies.
 *
 * Two escalations are allowed, each at most once: a rejected saved session
 * triggers one re-login, and a Cloudflare block on the plain HTTP path moves the
 * calls into a real browser page.
 */
export async function runOnce(cfg: Config, signal?: AbortSignal): Promise<RunOutcome> {
  const lock = acquireLock(cfg);
  if (!lock) return { status: 'skipped' };

  try {
    let transport: PackTransport;
    let fresh: boolean;
    try {
      const acquired = await acquireTransport(cfg);
      transport = acquired.transport;
      fresh = acquired.fresh;
    } catch (error) {
      if (error instanceof LoginSuppressedError) {
        log.warn('login is in backoff after earlier failures; not touching the site', {
          until: error.until.toISOString(),
        });
        return { status: 'suppressed', until: error.until };
      }
      throw error;
    }

    let usedRelogin = false;
    let usedBrowserFallback = false;

    try {
      for (;;) {
        try {
          const summary = await drainPacks(transport, cfg, signal);
          await transport
            .persist()
            .catch((error: unknown) =>
              log.warn('could not save refreshed cookies', { error: String(error) }),
            );
          return {
            status: summary.stopReason === 'drained' ? 'drained' : 'partial',
            summary,
          };
        } catch (error) {
          if (error instanceof AuthExpiredError && !fresh && !usedRelogin) {
            usedRelogin = true;
            log.warn('saved session was rejected; logging in again', {
              detail: error.message,
            });
            await transport.dispose();
            const reacquired = await acquireTransport(cfg, { force: true });
            transport = reacquired.transport;
            fresh = true;
            continue;
          }

          if (error instanceof CloudflareBlockedError && !usedBrowserFallback) {
            usedBrowserFallback = true;
            log.warn('Cloudflare blocked the direct API path; retrying from a real browser page', {
              detail: error.message,
            });
            await transport.dispose();
            transport = await acquireBrowserTransport(cfg);
            continue;
          }

          throw error;
        }
      }
    } finally {
      await transport.dispose();
    }
  } finally {
    lock.release();
  }
}
