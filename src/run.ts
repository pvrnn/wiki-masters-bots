import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import {
  AccountSanctionedError,
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
  ensureFreshSession,
  importCookie,
  type PackTransport,
} from './session.js';
import { fetchProfile, type Profile, type SupabaseSession } from './supabase.js';

export type RunOutcome =
  | { status: 'drained'; summary: DrainSummary }
  | { status: 'partial'; summary: DrainSummary }
  | { status: 'nothing-to-do'; packsLastRegenAt?: string }
  | { status: 'skipped' }
  | { status: 'suppressed'; until: Date };

/**
 * Refuses to touch an account the site has flagged. Continuing to hammer a
 * struck or blocked account only deepens the hole.
 */
function assertNotSanctioned(profile: Profile, cfg: Config): void {
  const blockedUntil = profile.activityBlockedUntil
    ? new Date(profile.activityBlockedUntil)
    : undefined;
  const blocked = blockedUntil && !Number.isNaN(blockedUntil.getTime()) && blockedUntil > new Date();
  const struck = (profile.cheatStrikes ?? 0) > 0 || Boolean(profile.lastSanctionType);

  if (blocked) {
    throw new AccountSanctionedError(
      `the account is blocked from activity until ${blockedUntil.toISOString()}`,
    );
  }
  if (struck && !cfg.allowWhenStruck) {
    throw new AccountSanctionedError(
      `the account shows cheat_strikes=${profile.cheatStrikes ?? 0}` +
        `${profile.lastSanctionType ? ` and a "${profile.lastSanctionType}" sanction` : ''}. ` +
        'Stopping. Set WM_ALLOW_WHEN_STRUCK=true to override.',
    );
  }
}

/** Read-only look at the account before anything destructive happens. */
async function preflight(
  session: SupabaseSession,
  cfg: Config,
): Promise<{ knownRemaining?: number; profile?: Profile }> {
  const profile = await fetchProfile(session, cfg);
  if (!profile) return {};

  log.info('account pre-flight', {
    username: profile.username,
    packsRemaining: profile.packsRemaining,
    packsLastRegenAt: profile.packsLastRegenAt,
    cheatStrikes: profile.cheatStrikes,
    activityBlockedUntil: profile.activityBlockedUntil,
    packHumanVerifiedAt: profile.packHumanVerifiedAt,
  });

  assertNotSanctioned(profile, cfg);
  return {
    profile,
    ...(profile.packsRemaining === undefined ? {} : { knownRemaining: profile.packsRemaining }),
  };
}

/**
 * One complete pass: take the lock, make sure the session is usable, check
 * whether there is anything to do, drain the packs, save refreshed cookies.
 *
 * Two escalations are allowed, each at most once: a rejected session triggers
 * one re-login, and a Cloudflare block moves the calls into a real browser.
 */
export async function runOnce(cfg: Config, signal?: AbortSignal): Promise<RunOutcome> {
  const lock = acquireLock(cfg);
  if (!lock) return { status: 'skipped' };

  try {
    // Seed from WM_COOKIE on first boot, so a container can be fed one without a shell.
    if (!existsSync(cfg.statePath) && cfg.cookie) {
      const imported = importCookie(cfg.cookie, cfg);
      log.info('imported the session from WM_COOKIE', {
        username: imported.username,
        email: imported.email,
      });
    }

    // Supabase access tokens last 60 min and we run every 61, so this refresh is
    // the normal path rather than an exception.
    const session = await ensureFreshSession(cfg);

    let knownRemaining: number | undefined;
    if (session && cfg.preflight) {
      const result = await preflight(session, cfg);
      knownRemaining = result.knownRemaining;
      if (knownRemaining === 0) {
        log.info('no packs available; nothing to do', {
          packsLastRegenAt: result.profile?.packsLastRegenAt,
        });
        return {
          status: 'nothing-to-do',
          ...(result.profile?.packsLastRegenAt
            ? { packsLastRegenAt: result.profile.packsLastRegenAt }
            : {}),
        };
      }
    }

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
          const summary = await drainPacks(transport, cfg, signal, knownRemaining);
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
            log.warn('saved session was rejected; logging in again', { detail: error.message });
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
