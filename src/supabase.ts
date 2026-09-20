import { request } from 'playwright';
import { DEFAULT_USER_AGENT, type Config } from './config.js';
import { SessionImportError } from './errors.js';
import { log } from './logger.js';
import { truncate } from './util.js';

/**
 * Everything that knows the site runs on Supabase lives here.
 *
 * The session is held in @supabase/ssr's chunked cookies:
 *   sb-<ref>-auth-token.0 = "base64-<first 3180 chars>"
 *   sb-<ref>-auth-token.1 = "<the rest>"
 * Concatenated and base64url-decoded, that is a JSON blob holding the access
 * token, the refresh token and the expiry.
 */

/** @supabase/ssr splits cookie values at exactly this many characters. */
const MAX_CHUNK_SIZE = 3180;
const BASE64_PREFIX = 'base64-';
const AUTH_COOKIE = /^sb-(?<ref>.+?)-auth-token(?:\.(?<index>\d+))?$/;

/** Supabase issues 1-hour access tokens, so cookies must outlive them by far. */
const COOKIE_TTL_SECONDS = 400 * 24 * 60 * 60;

export type SupabaseSession = {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  username?: string;
  email?: string;
  /** The project ref the cookies were issued for. */
  ref: string;
};

export type Cookie = { name: string; value: string };

/** Splits a raw `Cookie:` header. Tolerates newlines and a trailing semicolon. */
export function parseCookieHeader(raw: string): Cookie[] {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return { name: part, value: '' };
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
}

function decodeValue(raw: string): string {
  if (raw.startsWith(BASE64_PREFIX)) {
    return Buffer.from(raw.slice(BASE64_PREFIX.length), 'base64url').toString('utf8');
  }
  // Older/unchunked form: plain JSON, possibly percent-encoded.
  return raw.includes('%') ? decodeURIComponent(raw) : raw;
}

/** Reassembles the chunked auth cookie and pulls the session out of it. */
export function decodeSession(cookies: Cookie[]): SupabaseSession {
  const chunks: { index: number; value: string; ref: string }[] = [];
  for (const cookie of cookies) {
    const match = AUTH_COOKIE.exec(cookie.name);
    const ref = match?.groups?.['ref'];
    if (!match || !ref) continue;
    chunks.push({
      index: Number(match.groups?.['index'] ?? 0),
      value: cookie.value,
      ref,
    });
  }

  if (chunks.length === 0) {
    throw new SessionImportError(
      'no Supabase auth cookie found. Expected something named sb-<project>-auth-token ' +
        '(usually with .0 / .1 suffixes). Copy the whole Cookie header, not just one entry.',
    );
  }

  chunks.sort((a, b) => a.index - b.index);
  const ref = chunks[0]?.ref ?? '';
  // Chunks are pieces of one string, so the base64- prefix is only on the first.
  const joined = chunks.map((chunk) => chunk.value).join('');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeValue(joined)) as unknown;
  } catch (error) {
    throw new SessionImportError(
      `the auth cookie did not decode to JSON (${String(error)}). It is probably truncated -- ` +
        `got ${joined.length} characters across ${chunks.length} chunk(s).`,
    );
  }

  const session = parsed as Record<string, unknown>;
  const accessToken = session['access_token'];
  const refreshToken = session['refresh_token'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new SessionImportError(
      'the auth cookie decoded but holds no access_token/refresh_token pair',
    );
  }

  const user = (session['user'] ?? {}) as Record<string, unknown>;
  const meta = (user['user_metadata'] ?? {}) as Record<string, unknown>;
  const expiresAt =
    typeof session['expires_at'] === 'number'
      ? session['expires_at']
      : expiryFromJwt(accessToken) ?? 0;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    ref,
    ...(typeof meta['username'] === 'string' ? { username: meta['username'] } : {}),
    ...(typeof user['email'] === 'string' ? { email: user['email'] } : {}),
  };
}

/** Reads `exp` straight from the access token when the wrapper lacks expires_at. */
export function expiryFromJwt(jwt: string): number | undefined {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof decoded.exp === 'number' ? decoded.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The inverse of decodeSession: back into cookies the site's own middleware can
 * read. Chunking must match @supabase/ssr or the site cannot parse what we write.
 */
export function encodeSessionCookies(session: SupabaseSession, raw: unknown): Cookie[] {
  const name = `sb-${session.ref}-auth-token`;
  const encoded =
    BASE64_PREFIX + Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');

  if (encoded.length <= MAX_CHUNK_SIZE) return [{ name, value: encoded }];

  const cookies: Cookie[] = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < encoded.length; i += 1) {
    cookies.push({
      name: `${name}.${i}`,
      value: encoded.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE),
    });
  }
  return cookies;
}

export type StorageState = {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax' | 'Strict' | 'None';
  }[];
  origins: never[];
};

/** Wraps cookies as a Playwright storageState, which the rest of the bot already consumes. */
export function toStorageState(cookies: Cookie[], cfg: Config): StorageState {
  const domain = new URL(cfg.baseUrl).hostname;
  const expires = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  return {
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain,
      path: '/',
      expires,
      // Set by the browser client via document.cookie, so not httpOnly.
      httpOnly: false,
      secure: cfg.baseUrl.startsWith('https:'),
      sameSite: 'Lax' as const,
    })),
    origins: [],
  };
}

export function isExpired(session: SupabaseSession, skewMs: number): boolean {
  return session.expiresAt * 1000 - skewMs <= Date.now();
}

export function describeExpiry(session: SupabaseSession): string {
  const ms = session.expiresAt * 1000 - Date.now();
  const minutes = Math.round(ms / 60_000);
  const at = new Date(session.expiresAt * 1000).toISOString();
  return ms <= 0 ? `expired ${-minutes} min ago (${at})` : `valid for ${minutes} min (${at})`;
}

async function supabaseCall(
  cfg: Config,
  path: string,
  init: { method: 'GET' | 'POST'; bearer: string; body?: unknown },
): Promise<{ status: number; body: unknown; text: string }> {
  const ctx = await request.newContext({
    baseURL: cfg.supabaseUrl,
    timeout: cfg.requestTimeoutMs,
    extraHTTPHeaders: {
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${init.bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': cfg.userAgent ?? DEFAULT_USER_AGENT,
    },
  });
  try {
    const res =
      init.method === 'GET'
        ? await ctx.get(path)
        : await ctx.post(path, { data: init.body ?? {} });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    return { status: res.status(), body, text };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

/**
 * Trades the refresh token for a fresh 60-minute access token.
 *
 * Supabase ROTATES refresh tokens, so the caller must persist the result
 * immediately -- dropping a rotated token breaks the chain for good.
 */
export async function refreshSession(
  session: SupabaseSession,
  cfg: Config,
): Promise<{ session: SupabaseSession; raw: unknown }> {
  log.info('refreshing the access token', { expiry: describeExpiry(session) });
  const { status, body, text } = await supabaseCall(cfg, '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    bearer: cfg.supabaseAnonKey,
    body: { refresh_token: session.refreshToken },
  });

  if (status !== 200 || typeof body !== 'object' || body === null) {
    throw new SessionImportError(
      `refresh failed with status ${status}: ${truncate(text, 300)}. The refresh token is ` +
        'probably spent or revoked -- re-import a fresh cookie from your browser.',
    );
  }

  const data = body as Record<string, unknown>;
  const accessToken = data['access_token'];
  const refreshToken = data['refresh_token'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new SessionImportError(`refresh returned no tokens: ${truncate(text, 300)}`);
  }

  const expiresAt =
    typeof data['expires_at'] === 'number'
      ? data['expires_at']
      : expiryFromJwt(accessToken) ??
        Math.floor(Date.now() / 1000) + Number(data['expires_in'] ?? 3600);

  const refreshed: SupabaseSession = {
    ...session,
    accessToken,
    refreshToken,
    expiresAt,
  };
  log.info('access token refreshed', { expiry: describeExpiry(refreshed) });
  return { session: refreshed, raw: body };
}

export type Profile = {
  username?: string;
  packsRemaining?: number;
  packsLastRegenAt?: string;
  cheatStrikes?: number;
  activityBlockedUntil?: string | null;
  lastSanctionType?: string | null;
  packHumanVerifiedAt?: string | null;
};

/**
 * Read-only account state, including the pack count. Lets a run decide whether
 * there is anything to do without opening a pack to find out.
 */
export async function fetchProfile(
  session: SupabaseSession,
  cfg: Config,
): Promise<Profile | undefined> {
  const { status, body, text } = await supabaseCall(cfg, '/rest/v1/rpc/get_my_profile', {
    method: 'POST',
    bearer: session.accessToken,
    body: {},
  });
  if (status !== 200 || typeof body !== 'object' || body === null) {
    log.warn('could not read the account profile; continuing without the pre-flight', {
      status,
      body: truncate(text, 200),
    });
    return undefined;
  }
  const p = body as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof p[k] === 'number' ? (p[k] as number) : undefined;
  const str = (k: string): string | null | undefined =>
    typeof p[k] === 'string' || p[k] === null ? (p[k] as string | null) : undefined;

  return {
    ...(typeof p['username'] === 'string' ? { username: p['username'] } : {}),
    ...(num('packs_remaining') === undefined ? {} : { packsRemaining: num('packs_remaining') }),
    ...(str('packs_last_regen_at') ? { packsLastRegenAt: str('packs_last_regen_at') as string } : {}),
    ...(num('cheat_strikes') === undefined ? {} : { cheatStrikes: num('cheat_strikes') }),
    ...(str('activity_blocked_until') === undefined
      ? {}
      : { activityBlockedUntil: str('activity_blocked_until') ?? null }),
    ...(str('last_sanction_type') === undefined
      ? {}
      : { lastSanctionType: str('last_sanction_type') ?? null }),
    ...(str('pack_human_verified_at') === undefined
      ? {}
      : { packHumanVerifiedAt: str('pack_human_verified_at') ?? null }),
  };
}
