import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  request,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from 'playwright';
import { loginBlockedUntil, recordLoginFailure, recordLoginSuccess } from './authledger.js';
import { launchHardenedContext } from './browser.js';
import { DEFAULT_USER_AGENT, type Config } from './config.js';
import { LoginFailedError, LoginSuppressedError } from './errors.js';
import { log } from './logger.js';
import { performLogin } from './login.js';
import {
  decodeSession,
  encodeSessionCookies,
  isExpired,
  describeExpiry,
  parseCookieHeader,
  refreshSession,
  toStorageState,
  type Cookie,
  type StorageState,
  type SupabaseSession,
} from './supabase.js';
import { safeErrorMessage, truncate } from './util.js';

export const OPEN_PACK_PATH = '/api/packs/open';

/**
 * Every outcome of one pack-open attempt, classified once so the loop can
 * branch on cause. Both transports produce the same union.
 */
export type OpenResult =
  | { kind: 'json'; status: number; body: unknown; ms: number }
  | { kind: 'unauthenticated'; status: number }
  | { kind: 'human-verification'; status: number; snippet: string }
  | { kind: 'cloudflare'; status: number; snippet: string }
  | { kind: 'http-error'; status: number; snippet: string }
  | { kind: 'retryable'; status: number; detail: string; retryAfterMs?: number };

export interface PackTransport {
  readonly kind: 'api' | 'browser';
  openPack(): Promise<OpenResult>;
  /** Writes refreshed cookies back to the state file. */
  persist(): Promise<void>;
  dispose(): Promise<void>;
}

type SessionMeta = { userAgent?: string; savedAt: string };

function readMeta(cfg: Config): SessionMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cfg.metaPath, 'utf8')) as Partial<SessionMeta>;
    return { savedAt: parsed.savedAt ?? 'unknown', ...(parsed.userAgent ? { userAgent: parsed.userAgent } : {}) };
  } catch {
    return undefined;
  }
}

function writeMeta(cfg: Config, meta: SessionMeta): void {
  mkdirSync(dirname(cfg.metaPath), { recursive: true });
  writeFileSync(cfg.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function protect(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not all filesystems support this (and Windows ignores it). Not fatal.
  }
}

/**
 * Cloudflare blocking us is a different failure from the app rejecting our
 * session, with a different fix, so it must not be folded into a plain 403.
 */
function isCloudflareBlock(
  status: number,
  headers: Record<string, string>,
  body: string,
): boolean {
  if (headers['cf-mitigated']) return true;
  const fromCloudflare = /cloudflare/i.test(headers['server'] ?? '');
  if (!fromCloudflare) return false;
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return /just a moment|__cf_chl|cf-wrapper|challenge-platform|attention required|cf-error/i.test(
    body,
  );
}

/**
 * Markers for the site's `pack_human_verified_at` gate. Deliberately narrow --
 * a bare /verif/ would also match things like "email_not_verified".
 */
const HUMAN_CHECK =
  /human[_\s-]?verif|verify\s+you\s+are\s+human|pack_human|captcha|turnstile/i;

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = new Date(raw).getTime();
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function classifyResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
  ms: number,
): OpenResult {
  if (isCloudflareBlock(status, headers, body)) {
    return { kind: 'cloudflare', status, snippet: truncate(body, 300) };
  }

  if (status >= 300 && status < 400) {
    const location = headers['location'] ?? '';
    if (/\/login/i.test(location)) return { kind: 'unauthenticated', status };
    return { kind: 'http-error', status, snippet: `unexpected redirect to "${location}"` };
  }

  // Must come before the 401/403 branch: the site returns 403 for its periodic
  // human check, and treating that as an expired session sends us off doing a
  // pointless browser re-login instead of reporting the real blocker.
  if (status >= 400 && HUMAN_CHECK.test(body)) {
    return { kind: 'human-verification', status, snippet: truncate(body, 300) };
  }

  if (status === 401 || status === 403) return { kind: 'unauthenticated', status };
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers);
    return {
      kind: 'retryable',
      status,
      detail: 'rate limited',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (status >= 500) return { kind: 'retryable', status, detail: `server error ${status}` };

  const parsed = tryJson(body);
  if (status >= 400) {
    return { kind: 'http-error', status, snippet: truncate(body, 300) };
  }
  if (parsed === undefined) {
    // 2xx that isn't JSON is nearly always the login page served with 200.
    if (/<html|<!doctype/i.test(body)) return { kind: 'unauthenticated', status };
    return { kind: 'http-error', status, snippet: truncate(body, 300) };
  }
  return { kind: 'json', status, body: parsed, ms };
}

/**
 * The cheap path: plain HTTP with the saved cookies and no browser at all.
 * This is what makes an hourly schedule nearly free.
 */
class ApiTransport implements PackTransport {
  readonly kind = 'api' as const;

  constructor(
    private readonly ctx: APIRequestContext,
    private readonly cfg: Config,
  ) {}

  async openPack(): Promise<OpenResult> {
    const startedAt = Date.now();
    try {
      const res = await this.ctx.post(OPEN_PACK_PATH, { timeout: this.cfg.requestTimeoutMs });
      const body = await res.text();
      return classifyResponse(res.status(), res.headers(), body, Date.now() - startedAt);
    } catch (error) {
      // Timeouts and socket errors land here; both are worth retrying.
      return { kind: 'retryable', status: 0, detail: safeErrorMessage(error) };
    }
  }

  async persist(): Promise<void> {
    await this.ctx.storageState({ path: this.cfg.statePath });
    protect(this.cfg.statePath);
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose().catch(() => {});
  }
}

/**
 * Fallback tier, used only if Cloudflare blocks the plain HTTP path: issue the
 * POST from inside the logged-in page, so it carries the browser's own TLS
 * fingerprint and cookies. Heavier -- it holds a browser open for the drain.
 */
class BrowserTransport implements PackTransport {
  readonly kind = 'browser' as const;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cfg: Config,
  ) {}

  async openPack(): Promise<OpenResult> {
    const startedAt = Date.now();
    try {
      const result = await this.page.evaluate(
        async ({ path, timeoutMs }: { path: string; timeoutMs: number }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(path, {
              method: 'POST',
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            });
            const headers: Record<string, string> = {};
            res.headers.forEach((value, key) => {
              headers[key.toLowerCase()] = value;
            });
            return { status: res.status, headers, body: await res.text() };
          } finally {
            clearTimeout(timer);
          }
        },
        { path: OPEN_PACK_PATH, timeoutMs: this.cfg.requestTimeoutMs },
      );
      return classifyResponse(result.status, result.headers, result.body, Date.now() - startedAt);
    } catch (error) {
      return { kind: 'retryable', status: 0, detail: safeErrorMessage(error) };
    }
  }

  async persist(): Promise<void> {
    await this.context.storageState({ path: this.cfg.statePath });
    protect(this.cfg.statePath);
  }

  async dispose(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

function buildApiTransport(cfg: Config): PackTransport {
  const meta = readMeta(cfg);
  // Priority: explicit override, then the UA the browser login recorded (which
  // is what lets a state file move between machines), then a plausible desktop
  // Chrome for the cookie flow, where no browser was ever involved.
  const userAgent = cfg.userAgent ?? meta?.userAgent ?? DEFAULT_USER_AGENT;

  const ctxPromise = request.newContext({
    baseURL: cfg.baseUrl,
    storageState: cfg.statePath,
    timeout: cfg.requestTimeoutMs,
    // Do not follow redirects: a 302 to /login is how we detect a dead session.
    maxRedirects: 0,
    extraHTTPHeaders: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': `${cfg.locale},${cfg.locale.split('-')[0]};q=0.9`,
      Origin: cfg.baseUrl,
      // The real site calls this from /pulls; mirror it.
      Referer: `${cfg.baseUrl}/pulls`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  });

  // request.newContext is async, so wrap it lazily behind the interface.
  let resolved: APIRequestContext | undefined;
  const ensure = async (): Promise<APIRequestContext> => {
    resolved ??= await ctxPromise;
    return resolved;
  };

  return {
    kind: 'api',
    async openPack() {
      return new ApiTransport(await ensure(), cfg).openPack();
    },
    async persist() {
      await new ApiTransport(await ensure(), cfg).persist();
    },
    async dispose() {
      await new ApiTransport(await ensure(), cfg).dispose();
    },
  };
}

/** Logs in with a real browser and saves the session. */
export async function loginAndSaveState(cfg: Config): Promise<void> {
  const blockedUntil = loginBlockedUntil(cfg);
  if (blockedUntil) throw new LoginSuppressedError(blockedUntil);

  log.info('starting a browser login');
  const context = await launchHardenedContext(cfg);
  try {
    const result = await performLogin(context, cfg);
    mkdirSync(dirname(cfg.statePath), { recursive: true });
    await context.storageState({ path: cfg.statePath });
    protect(cfg.statePath);
    writeMeta(cfg, {
      savedAt: new Date().toISOString(),
      ...(result.userAgent ?? cfg.userAgent
        ? { userAgent: result.userAgent ?? cfg.userAgent }
        : {}),
    });
    recordLoginSuccess(cfg);
    log.info('session saved', { statePath: cfg.statePath, turnstile: result.turnstile });
  } catch (error) {
    if (error instanceof LoginFailedError) recordLoginFailure(cfg, error.reason);
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

export type Acquired = { transport: PackTransport; fresh: boolean };

/**
 * Returns a transport for the pack loop. Reuses the saved session when there is
 * one, so the browser (and therefore Turnstile) is touched only when it must be.
 */
export async function acquireTransport(
  cfg: Config,
  options: { force?: boolean } = {},
): Promise<Acquired> {
  if (!options.force && existsSync(cfg.statePath)) {
    const meta = readMeta(cfg);
    log.info('reusing the saved session', { savedAt: meta?.savedAt ?? 'unknown' });
    return { transport: buildApiTransport(cfg), fresh: false };
  }

  log.info(options.force ? 'session needs replacing' : 'no saved session on disk');
  await loginAndSaveState(cfg);
  return { transport: buildApiTransport(cfg), fresh: true };
}

/** Escalation for a Cloudflare-blocked API path: drive the POSTs from a page. */
export async function acquireBrowserTransport(cfg: Config): Promise<PackTransport> {
  const context = await launchHardenedContext(cfg);
  try {
    if (existsSync(cfg.statePath)) {
      const state = JSON.parse(readFileSync(cfg.statePath, 'utf8')) as {
        cookies?: Parameters<BrowserContext['addCookies']>[0];
      };
      if (state.cookies?.length) await context.addCookies(state.cookies);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.requestTimeoutMs);
    await page.goto(`${cfg.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return new BrowserTransport(context, page, cfg);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export function describeSavedSession(cfg: Config): {
  exists: boolean;
  savedAt?: string;
  userAgent?: string;
} {
  if (!existsSync(cfg.statePath)) return { exists: false };
  const meta = readMeta(cfg);
  return {
    exists: true,
    ...(meta?.savedAt ? { savedAt: meta.savedAt } : {}),
    ...(meta?.userAgent ?? cfg.userAgent ? { userAgent: meta?.userAgent ?? cfg.userAgent } : {}),
  };
}

/**
 * Issues one authenticated GET against a caller-supplied path, so the session
 * can be checked without opening a pack. Only usable if WM_PROBE_PATH is set --
 * no read-only endpoint on this site is known.
 */
export async function probeSession(cfg: Config, path: string): Promise<OpenResult> {
  const meta = readMeta(cfg);
  const userAgent = cfg.userAgent ?? meta?.userAgent;
  const ctx = await request.newContext({
    baseURL: cfg.baseUrl,
    storageState: cfg.statePath,
    timeout: cfg.requestTimeoutMs,
    maxRedirects: 0,
    extraHTTPHeaders: {
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
      Accept: 'application/json, text/plain, */*',
      Referer: `${cfg.baseUrl}/`,
    },
  });
  const startedAt = Date.now();
  try {
    const res = await ctx.get(path, { timeout: cfg.requestTimeoutMs });
    const body = await res.text();
    return classifyResponse(res.status(), res.headers(), body, Date.now() - startedAt);
  } catch (error) {
    // A network-level failure (timeout, reset) here used to propagate
    // uncaught -- crashing the caller with Playwright's raw error, which
    // embeds every request header (session cookie included) in its message.
    // Caught and classified like every other transient failure instead.
    return { kind: 'retryable', status: 0, detail: safeErrorMessage(error) };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

/**
 * Issues one authenticated POST with a JSON body against a caller-supplied
 * path, using the same saved session as everything else. Shares
 * classifyResponse with the pack loop, so callers get the same
 * unauthenticated/cloudflare/human-verification signals for free.
 *
 * Used by tools (like the collection-cleanup skill) that need to call a
 * write endpoint other than /api/packs/open. Does NOT refresh the access
 * token itself -- call ensureFreshSession(cfg) first if the caller might run
 * long after the token was minted.
 */
export async function postJson(cfg: Config, path: string, body: unknown): Promise<OpenResult> {
  const meta = readMeta(cfg);
  const userAgent = cfg.userAgent ?? meta?.userAgent ?? DEFAULT_USER_AGENT;
  const ctx = await request.newContext({
    baseURL: cfg.baseUrl,
    storageState: cfg.statePath,
    timeout: cfg.requestTimeoutMs,
    maxRedirects: 0,
    extraHTTPHeaders: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
      Origin: cfg.baseUrl,
      Referer: `${cfg.baseUrl}/collection`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  });
  const startedAt = Date.now();
  try {
    const res = await ctx.post(path, { data: body, timeout: cfg.requestTimeoutMs });
    const text = await res.text();
    return classifyResponse(res.status(), res.headers(), text, Date.now() - startedAt);
  } catch (error) {
    return { kind: 'retryable', status: 0, detail: safeErrorMessage(error) };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}


// ---------------------------------------------------------------------------
// Cookie-based sessions (Supabase)
// ---------------------------------------------------------------------------

function readStorageState(cfg: Config): StorageState | undefined {
  try {
    return JSON.parse(readFileSync(cfg.statePath, 'utf8')) as StorageState;
  } catch {
    return undefined;
  }
}

function writeStorageState(cfg: Config, state: StorageState): void {
  mkdirSync(dirname(cfg.statePath), { recursive: true });
  writeFileSync(cfg.statePath, `${JSON.stringify(state, null, 2)}\n`);
  protect(cfg.statePath);
}

/** Turns a pasted Cookie header into the session file the rest of the bot uses. */
export function importCookie(raw: string, cfg: Config): SupabaseSession {
  const cookies = parseCookieHeader(raw);
  const session = decodeSession(cookies);
  writeStorageState(cfg, toStorageState(cookies, cfg));
  writeMeta(cfg, {
    savedAt: new Date().toISOString(),
    ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
  });
  return session;
}

/** Pulls the Supabase session out of the saved cookie jar, if there is one. */
export function loadSession(cfg: Config): SupabaseSession | undefined {
  const state = readStorageState(cfg);
  if (!state?.cookies?.length) return undefined;
  try {
    return decodeSession(state.cookies.map((c) => ({ name: c.name, value: c.value })));
  } catch {
    // A password-login session has no Supabase cookie; that is fine.
    return undefined;
  }
}

/** Replaces the auth cookies in the saved jar, leaving any others untouched. */
function persistSessionCookies(cfg: Config, fresh: Cookie[]): void {
  const existing = readStorageState(cfg);
  const isAuth = (name: string): boolean => /^sb-.+-auth-token(\.\d+)?$/.test(name);
  const kept = (existing?.cookies ?? []).filter((c) => !isAuth(c.name));
  const added = toStorageState(fresh, cfg).cookies;
  writeStorageState(cfg, { cookies: [...kept, ...added], origins: [] });
}

/**
 * Guarantees a usable access token.
 *
 * The site issues 60-minute tokens and the bot runs every 30, so the saved token
 * is often still valid but sometimes expired -- refreshing is a routine path,
 * not an exception. The rotated refresh token is written back immediately;
 * losing it would break the chain permanently.
 */
export async function ensureFreshSession(cfg: Config): Promise<SupabaseSession | undefined> {
  const session = loadSession(cfg);
  if (!session) return undefined;

  if (!isExpired(session, cfg.tokenSkewMs)) {
    log.info('access token still valid', { expiry: describeExpiry(session) });
    return session;
  }

  const { session: refreshed, raw } = await refreshSession(session, cfg);
  persistSessionCookies(cfg, encodeSessionCookies(refreshed, raw));
  return refreshed;
}
