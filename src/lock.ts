import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { log } from './logger.js';

export type Lock = { release(): void };

type LockFile = { pid: number; startedAt: string };

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockFile(path: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockFile>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

function isStale(lock: LockFile | undefined, cfg: Config): boolean {
  if (!lock) return true; // unreadable or corrupt -- treat as abandoned
  if (!isAlive(lock.pid)) return true;
  const age = Date.now() - new Date(lock.startedAt).getTime();
  return Number.isNaN(age) || age > cfg.runBudgetMs * 2;
}

/**
 * Single-instance guard, so a slow run can't overlap the next scheduled one.
 * Returns undefined when another run genuinely holds the lock -- that is a
 * normal skip, not a failure.
 */
export function acquireLock(cfg: Config): Lock | undefined {
  mkdirSync(dirname(cfg.lockPath), { recursive: true });

  const write = (): Lock => {
    // 'wx' fails if the path exists, which makes the create atomic.
    const fd = openSync(cfg.lockPath, 'wx');
    try {
      const payload: LockFile = { pid: process.pid, startedAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(payload));
    } finally {
      closeSync(fd);
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Detach first: the daemon acquires a lock per run, and leaving handlers
      // behind would pile up listeners over a long-lived process.
      process.removeListener('exit', release);
      try {
        rmSync(cfg.lockPath, { force: true });
      } catch (error) {
        log.warn('could not remove lock file', { error: String(error) });
      }
    };

    // Safety net for an abrupt exit. Signal handling itself lives in the
    // entrypoint, so the lock never decides the process's fate.
    process.once('exit', release);

    return { release };
  };

  try {
    return write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const existing = readLockFile(cfg.lockPath);
    if (!isStale(existing, cfg)) {
      log.warn('another run holds the lock; skipping this one', {
        pid: existing?.pid,
        startedAt: existing?.startedAt,
      });
      return undefined;
    }

    log.warn('clearing stale lock', { pid: existing?.pid, startedAt: existing?.startedAt });
    rmSync(cfg.lockPath, { force: true });
    try {
      return write();
    } catch (raceError) {
      // Another process won the race for the freed lock. Still just a skip.
      if ((raceError as NodeJS.ErrnoException).code === 'EEXIST') {
        log.warn('lost the race for the freed lock; skipping this run');
        return undefined;
      }
      throw raceError;
    }
  }
}
