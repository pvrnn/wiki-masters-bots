export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Inclusive-ish random integer in [min, max]. */
export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** A delay somewhere in the configured window, so the cadence isn't machine-exact. */
export function jitteredDelay(minMs: number, maxMs: number): number {
  return randInt(minMs, Math.max(minMs, maxMs));
}

/** Exponential backoff for attempt 1, 2, 3 ... capped. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(capMs, raw);
}

/**
 * Turns a promise into one that resolves only on success and otherwise hangs.
 * Lets Promise.race pick the first thing that actually happened rather than
 * the first thing that failed.
 */
export function onlyOnSuccess<T>(p: Promise<T>): Promise<T> {
  return p.catch(() => new Promise<never>(() => {}));
}

export function truncate(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max)}... [${s.length} bytes total]`;
}

/**
 * A caught error's message, safe to log, return, or notify with.
 *
 * Playwright's network-error messages embed a full request "Call log" after
 * the first newline -- every header verbatim, including Cookie and
 * Authorization. A live crash during development leaked a full session this
 * way (uncaught network error -> default error formatting -> printed
 * straight to a terminal). Only the first line is ever safe to surface; the
 * short human-readable message is always on it, the header dump never is.
 * Use this at every point an error that might have come from a Playwright
 * request could otherwise be stringified.
 */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0]?.trim() || raw;
}
