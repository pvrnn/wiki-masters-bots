import { resolve } from 'node:path';
import { ConfigError } from './errors.js';
import { isLogLevel, type LogLevel } from './logger.js';

/**
 * Used when no browser UA has been recorded -- i.e. the cookie flow, where no
 * browser is ever launched. Identifying as Playwright/undici to the site would
 * be a needless tell, so we present an ordinary desktop Chrome instead.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/153.0.0.0 Safari/537.36';

export type Config = {
  /** Only the `login` mode needs these; the cookie flow does not. */
  email: string | undefined;
  password: string | undefined;
  baseUrl: string;

  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Raw Cookie header, imported on startup when no session exists yet. */
  cookie: string | undefined;
  /** Refresh the access token this long before it actually expires. */
  tokenSkewMs: number;
  /** Read the account profile before opening anything. */
  preflight: boolean;
  /** Run even if the account shows strikes or a sanction. */
  allowWhenStruck: boolean;

  statePath: string;
  metaPath: string;
  profileDir: string;
  lockPath: string;
  ledgerPath: string;
  debugDir: string;

  /** Undefined means "use the real browser's own UA", which is what we want. */
  userAgent: string | undefined;
  /** 'chrome' for real Google Chrome; undefined for bundled Chromium. */
  browserChannel: string | undefined;
  locale: string;
  timezone: string;
  headless: boolean;

  intervalMinutes: number;

  openDelayMinMs: number;
  openDelayMaxMs: number;
  requestTimeoutMs: number;
  turnstileTimeoutMs: number;
  maxPacks: number;
  runBudgetMs: number;
  maxConsecutiveErrors: number;
  stallLimit: number;

  loginBackoffBaseMs: number;
  loginBackoffMaxMs: number;

  notifyWebhookUrl: string | undefined;
  probePath: string | undefined;
  logLevel: LogLevel;
};

function str(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Returns undefined when unset OR explicitly set empty, so a var can be cleared. */
function optional(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name} must be a number, got "${raw}"`);
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
}

export function loadConfig(): Config {
  const logLevel = str('WM_LOG_LEVEL', 'info');
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(`WM_LOG_LEVEL must be debug|info|warn|error, got "${logLevel}"`);
  }

  const openDelayMinMs = num('WM_OPEN_DELAY_MIN_MS', 3_000, 0, 600_000);
  const openDelayMaxMs = num('WM_OPEN_DELAY_MAX_MS', 4_000, 0, 600_000);
  if (openDelayMaxMs < openDelayMinMs) {
    throw new ConfigError(
      `WM_OPEN_DELAY_MAX_MS (${openDelayMaxMs}) must be >= WM_OPEN_DELAY_MIN_MS (${openDelayMinMs})`,
    );
  }

  const intervalMinutes = num('WM_INTERVAL_MINUTES', 61, 1, 10_080);
  const runBudgetMs = num('WM_RUN_BUDGET_MS', 2_700_000, 10_000, 86_400_000);
  if (runBudgetMs >= intervalMinutes * 60_000) {
    throw new ConfigError(
      `WM_RUN_BUDGET_MS (${runBudgetMs}) must be less than the schedule interval ` +
        `(${intervalMinutes} min = ${intervalMinutes * 60_000} ms), or runs will overlap`,
    );
  }

  const loginBackoffBaseMs = num('WM_LOGIN_BACKOFF_BASE_MS', 7_200_000, 0, 604_800_000);
  const loginBackoffMaxMs = num('WM_LOGIN_BACKOFF_MAX_MS', 86_400_000, 0, 604_800_000);
  if (loginBackoffMaxMs < loginBackoffBaseMs) {
    throw new ConfigError(
      `WM_LOGIN_BACKOFF_MAX_MS (${loginBackoffMaxMs}) must be >= ` +
        `WM_LOGIN_BACKOFF_BASE_MS (${loginBackoffBaseMs})`,
    );
  }

  const baseUrl = str('WM_BASE_URL', 'https://www.wiki-masters.com').replace(/\/+$/, '');
  try {
    new URL(baseUrl);
  } catch {
    throw new ConfigError(`WM_BASE_URL is not a valid URL: "${baseUrl}"`);
  }

  return {
    email: optional('WM_EMAIL'),
    password: optional('WM_PASSWORD'),
    baseUrl,

    supabaseUrl: str('WM_SUPABASE_URL', 'https://cyrxjeppjqsxxjayfrur.supabase.co').replace(
      /\/+$/,
      '',
    ),
    // Public by design -- this key is shipped to every visitor's browser.
    supabaseAnonKey: str(
      'WM_SUPABASE_ANON_KEY',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg',
    ),
    cookie: optional('WM_COOKIE'),
    tokenSkewMs: num('WM_TOKEN_SKEW_MS', 120_000, 0, 3_000_000),
    preflight: bool('WM_PREFLIGHT', true),
    allowWhenStruck: bool('WM_ALLOW_WHEN_STRUCK', false),

    statePath: resolve(str('WM_STATE_PATH', './data/storage-state.json')),
    metaPath: resolve(str('WM_META_PATH', './data/session-meta.json')),
    profileDir: resolve(str('WM_PROFILE_DIR', './data/profile')),
    lockPath: resolve(str('WM_LOCK_PATH', './data/bot.lock')),
    ledgerPath: resolve(str('WM_LEDGER_PATH', './data/auth-ledger.json')),
    debugDir: resolve(str('WM_DEBUG_DIR', './data/debug')),

    userAgent: optional('WM_USER_AGENT'),
    browserChannel: optional('WM_BROWSER_CHANNEL') ?? 'chrome',
    locale: str('WM_LOCALE', 'fr-FR'),
    timezone: str('WM_TIMEZONE', 'Europe/Paris'),
    headless: bool('WM_HEADLESS', false),

    intervalMinutes,

    openDelayMinMs,
    openDelayMaxMs,
    requestTimeoutMs: num('WM_REQUEST_TIMEOUT_MS', 180_000, 1_000, 900_000),
    turnstileTimeoutMs: num('WM_TURNSTILE_TIMEOUT_MS', 60_000, 1_000, 600_000),
    maxPacks: num('WM_MAX_PACKS', 200, 1, 10_000),
    runBudgetMs,
    maxConsecutiveErrors: num('WM_MAX_CONSECUTIVE_ERRORS', 4, 1, 100),
    stallLimit: num('WM_STALL_LIMIT', 3, 1, 100),

    loginBackoffBaseMs,
    loginBackoffMaxMs,

    notifyWebhookUrl: optional('WM_NOTIFY_WEBHOOK_URL'),
    probePath: optional('WM_PROBE_PATH'),
    logLevel,
  };
}

/**
 * The password login needs credentials; the cookie flow does not, so they are
 * only demanded at the point of use.
 */
export function requireCredentials(cfg: Config): { email: string; password: string } {
  if (!cfg.email || !cfg.password) {
    throw new ConfigError(
      'WM_EMAIL and WM_PASSWORD are required for `login` mode. If you are supplying a ' +
        'session cookie instead, use `npm run import-cookie`.',
    );
  }
  return { email: cfg.email, password: cfg.password };
}
