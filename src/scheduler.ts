import type { Config } from './config.js';
import {
  AccountSanctionedError,
  HumanVerificationRequiredError,
  LoginFailedError,
  SessionImportError,
} from './errors.js';
import { log } from './logger.js';
import { notify } from './notify.js';
import { runOnce } from './run.js';
import { sleep } from './util.js';

/** Never let the loop spin, even if a run somehow overruns the whole period. */
const MIN_GAP_MS = 60_000;

/**
 * Long-running mode for the container: run, wait out the rest of the period,
 * repeat. The wait is anchored to when the run *started*, so the cadence is a
 * true interval rather than "interval plus however long the run took".
 *
 * Plain cron cannot express 61 minutes, which is why this exists.
 */
export async function runDaemon(cfg: Config): Promise<void> {
  const controller = new AbortController();
  let stopping = false;

  const stop = (reason: string): void => {
    if (stopping) {
      log.warn('second shutdown signal; exiting now');
      process.exit(0);
    }
    stopping = true;
    log.info(`received ${reason}; finishing up and shutting down`);
    controller.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const periodMs = cfg.intervalMinutes * 60_000;
  log.info('daemon started', {
    intervalMinutes: cfg.intervalMinutes,
    baseUrl: cfg.baseUrl,
  });

  // Run immediately, so a redeploy doesn't sit idle for an hour.
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const outcome = await runOnce(cfg, controller.signal);
      log.info('run finished', outcome);
    } catch (error) {
      // One bad run must never take down the daemon.
      log.error('run failed', { error: error instanceof Error ? error.message : String(error) });
      // These all need a person; the rest are transient and just get logged.
      if (error instanceof LoginFailedError) {
        await notify(cfg, `wiki-masters bot: login failed (${error.reason}) — ${error.message}`);
      } else if (error instanceof HumanVerificationRequiredError) {
        await notify(cfg, 'wiki-masters bot: needs a human verification before opening more packs');
      } else if (error instanceof AccountSanctionedError) {
        await notify(cfg, `wiki-masters bot: account flagged — ${error.message}`);
      } else if (error instanceof SessionImportError) {
        await notify(cfg, `wiki-masters bot: session needs re-importing — ${error.message}`);
      }
    }

    if (stopping) break;

    const waitMs = Math.max(MIN_GAP_MS, periodMs - (Date.now() - startedAt));
    log.info('next run scheduled', {
      at: new Date(Date.now() + waitMs).toISOString(),
      waitMs,
    });
    await sleep(waitMs, controller.signal);
  }

  log.info('daemon stopped');
}
