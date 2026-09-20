import { readFileSync } from 'node:fs';
import { loadConfig, type Config } from './config.js';
import {
  AccountSanctionedError,
  AuthExpiredError,
  CloudflareBlockedError,
  ConfigError,
  HumanVerificationRequiredError,
  LoginFailedError,
  LoginSuppressedError,
  PackRunAbortedError,
  SessionImportError,
  SiteUnreachableError,
} from './errors.js';
import { configureLogger, log } from './logger.js';
import { notify } from './notify.js';
import { runOnce } from './run.js';
import { runDaemon } from './scheduler.js';
import {
  describeSavedSession,
  ensureFreshSession,
  importCookie,
  loginAndSaveState,
  probeSession,
} from './session.js';
import { describeExpiry, fetchProfile } from './supabase.js';

const MODES = ['run', 'daemon', 'login', 'probe', 'import-cookie'] as const;
type Mode = (typeof MODES)[number];

/** 0 success/no-op · 1 config · 2 auth or verification · 3 API failure */
const EXIT = { ok: 0, config: 1, auth: 2, api: 3 } as const;

const USAGE = `wiki-masters pack bot

  run             open every available pack once, then exit (default)
  daemon          run on a repeating schedule; used by the container
  import-cookie   store a session cookie copied from your browser
  login           force a fresh browser login and save the session
  probe           check the saved session without opening any packs

  import-cookie accepts the cookie as --file <path>, on stdin, or via WM_COOKIE:
    npm run import-cookie -- --file cookie.txt
    pbpaste | npm run import-cookie

Configuration comes from the environment or .env -- see .env.example.`;

function parseMode(argv: string[]): Mode {
  const raw = argv[2];
  if (raw === undefined || raw === '') return 'run';
  if (raw === '-h' || raw === '--help') {
    console.log(USAGE);
    process.exit(EXIT.ok);
  }
  if ((MODES as readonly string[]).includes(raw)) return raw as Mode;
  console.error(`Unknown mode "${raw}".\n\n${USAGE}`);
  process.exit(EXIT.config);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readCookieInput(argv: string[], cfg: Config): Promise<string> {
  const fileFlag = argv.indexOf('--file');
  if (fileFlag !== -1) {
    const path = argv[fileFlag + 1];
    if (!path) throw new ConfigError('--file needs a path');
    return readFileSync(path, 'utf8');
  }

  const positional = argv[3];
  if (positional && !positional.startsWith('-')) {
    log.warn('passing the cookie as an argument leaves it in your shell history', {
      hint: 'prefer --file <path> or piping it on stdin',
    });
    return positional;
  }

  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
  }

  if (cfg.cookie) return cfg.cookie;

  throw new ConfigError(
    'no cookie supplied. Pass --file <path>, pipe it on stdin, or set WM_COOKIE.',
  );
}

async function doImportCookie(cfg: Config, argv: string[]): Promise<number> {
  const raw = await readCookieInput(argv, cfg);
  const session = importCookie(raw, cfg);
  log.info('session imported', {
    username: session.username,
    email: session.email,
    project: session.ref,
    accessToken: describeExpiry(session),
  });
  if (session.expiresAt * 1000 <= Date.now()) {
    log.info(
      'that access token has already expired, which is normal -- it will be refreshed ' +
        'automatically from the refresh token on the next run.',
    );
  }
  log.info('no packs were opened. Run `npm run probe` to confirm the session works.');
  return EXIT.ok;
}

async function doRun(cfg: Config): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: string): void => {
    log.info(`received ${reason}; stopping after the current request`);
    controller.abort();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const outcome = await runOnce(cfg, controller.signal);
  switch (outcome.status) {
    case 'drained':
      log.info('done: no packs remaining', { opened: outcome.summary.opened });
      return EXIT.ok;
    case 'nothing-to-do':
      return EXIT.ok;
    case 'partial':
      log.warn('stopped before the queue was empty', outcome.summary);
      return EXIT.api;
    case 'skipped':
    case 'suppressed':
      return EXIT.ok;
  }
}

async function doLogin(cfg: Config): Promise<number> {
  await loginAndSaveState(cfg);
  log.info('login complete; the session is saved and no packs were opened');
  return EXIT.ok;
}

async function doProbe(cfg: Config): Promise<number> {
  const saved = describeSavedSession(cfg);
  if (!saved.exists) {
    if (cfg.cookie) {
      const imported = importCookie(cfg.cookie, cfg);
      log.info('imported the session from WM_COOKIE', { username: imported.username });
    } else {
      log.error('no saved session. Run `npm run import-cookie` or `npm run login` first.');
      return EXIT.auth;
    }
  }

  // A Supabase cookie session can be verified end to end without opening a pack.
  const session = await ensureFreshSession(cfg);
  if (session) {
    log.info('session', {
      username: session.username,
      email: session.email,
      accessToken: describeExpiry(session),
    });
    const profile = await fetchProfile(session, cfg);
    if (!profile) {
      log.error('the session was rejected by Supabase; re-import a fresh cookie');
      return EXIT.auth;
    }
    log.info('the session is valid; no packs were opened', {
      username: profile.username,
      packsRemaining: profile.packsRemaining,
      packsLastRegenAt: profile.packsLastRegenAt,
      cheatStrikes: profile.cheatStrikes,
      activityBlockedUntil: profile.activityBlockedUntil,
      packHumanVerifiedAt: profile.packHumanVerifiedAt,
    });
    return EXIT.ok;
  }

  // Password-login session: no Supabase cookie to inspect.
  log.info('found a saved session', saved);
  if (!cfg.probePath) {
    log.warn(
      'this session has no Supabase cookie to inspect, and the only known site API call ' +
        'opens a pack, so the probe stops here',
      { hint: 'set WM_PROBE_PATH to an authenticated GET for a real check' },
    );
    return EXIT.ok;
  }

  const result = await probeSession(cfg, cfg.probePath);
  log.info('probe response', { path: cfg.probePath, kind: result.kind, status: result.status });
  switch (result.kind) {
    case 'json':
      log.info('the saved session is valid', { body: result.body });
      return EXIT.ok;
    case 'unauthenticated':
      log.error('the saved session is no longer accepted');
      return EXIT.auth;
    case 'cloudflare':
      log.error('Cloudflare blocked the probe', { snippet: result.snippet });
      return EXIT.auth;
    default:
      log.error('probe did not return JSON', result);
      return EXIT.api;
  }
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv);

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      return EXIT.config;
    }
    throw error;
  }

  configureLogger(
    cfg.logLevel,
    [cfg.password, cfg.cookie].filter((v): v is string => Boolean(v)),
  );
  log.debug('configuration loaded', { mode, baseUrl: cfg.baseUrl, headless: cfg.headless });

  try {
    switch (mode) {
      case 'daemon':
        await runDaemon(cfg);
        return EXIT.ok;
      case 'login':
        return await doLogin(cfg);
      case 'probe':
        return await doProbe(cfg);
      case 'import-cookie':
        return await doImportCookie(cfg, process.argv);
      case 'run':
        return await doRun(cfg);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      return EXIT.config;
    }
    if (error instanceof SessionImportError) {
      log.error(`session problem: ${error.message}`);
      await notify(cfg, `wiki-masters bot: session problem — ${error.message}`);
      return EXIT.auth;
    }
    if (error instanceof HumanVerificationRequiredError) {
      log.error(error.message);
      log.error(
        'Open https://www.wiki-masters.com/pulls in your browser, open one pack by hand to ' +
          'clear the check, then re-import the cookie. This gate cannot be automated away.',
      );
      await notify(cfg, 'wiki-masters bot: needs a human verification before opening more packs');
      return EXIT.auth;
    }
    if (error instanceof AccountSanctionedError) {
      log.error(`stopping: ${error.message}`);
      await notify(cfg, `wiki-masters bot: account flagged — ${error.message}`);
      return EXIT.auth;
    }
    if (error instanceof LoginSuppressedError) {
      log.warn(error.message);
      return EXIT.ok;
    }
    if (error instanceof LoginFailedError) {
      log.error(`login failed (${error.reason}): ${error.message}`);
      if (error.reason === 'turnstile_blocked') {
        log.error(
          'Turnstile refused a token. The cookie flow avoids this entirely: copy the Cookie ' +
            'header from your browser and run `npm run import-cookie`. See the README.',
        );
      }
      await notify(cfg, `wiki-masters bot: login failed (${error.reason}) — ${error.message}`);
      return EXIT.auth;
    }
    if (error instanceof AuthExpiredError) {
      log.error(`could not authenticate: ${error.message}`);
      await notify(cfg, `wiki-masters bot: authentication failed — ${error.message}`);
      return EXIT.auth;
    }
    if (error instanceof CloudflareBlockedError) {
      log.error(`Cloudflare blocked the run: ${error.message}`);
      await notify(cfg, `wiki-masters bot: blocked by Cloudflare — ${error.message}`);
      return EXIT.auth;
    }
    if (error instanceof SiteUnreachableError) {
      log.error(error.message);
      log.error(
        'The site is not reachable from this machine. Check network access, DNS, any proxy ' +
          'or firewall, and that WM_BASE_URL is correct.',
      );
      return EXIT.api;
    }
    if (error instanceof PackRunAbortedError) {
      log.error(`run aborted: ${error.message}`);
      return EXIT.api;
    }
    log.error('unexpected failure', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return EXIT.api;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('fatal', error);
    process.exit(EXIT.api);
  },
);
