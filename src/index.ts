import { loadConfig, type Config } from './config.js';
import {
  AuthExpiredError,
  CloudflareBlockedError,
  ConfigError,
  LoginFailedError,
  LoginSuppressedError,
  PackRunAbortedError,
} from './errors.js';
import { configureLogger, log } from './logger.js';
import { notify } from './notify.js';
import { runOnce } from './run.js';
import { runDaemon } from './scheduler.js';
import { describeSavedSession, loginAndSaveState, probeSession } from './session.js';

const MODES = ['run', 'daemon', 'login', 'probe'] as const;
type Mode = (typeof MODES)[number];

/** 0 success/no-op · 1 config · 2 auth or Turnstile · 3 API failure */
const EXIT = { ok: 0, config: 1, auth: 2, api: 3 } as const;

const USAGE = `wiki-masters pack bot

  run      open every available pack once, then exit (default)
  daemon   run on a repeating schedule; used by the container
  login    force a fresh browser login and save the session
  probe    check the saved session without opening any packs

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
    case 'partial':
      log.warn('stopped before the queue was empty', outcome.summary);
      return EXIT.api;
    case 'skipped':
      return EXIT.ok;
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
    log.info('no saved session; logging in first');
    await loginAndSaveState(cfg);
  } else {
    log.info('found a saved session', saved);
  }

  if (!cfg.probePath) {
    log.warn(
      'cannot verify the session end to end: the only known API call opens a pack, which is ' +
        'irreversible, so this probe stops here',
      { hint: 'set WM_PROBE_PATH to an authenticated GET and this becomes a real check' },
    );
    log.info('probe complete: a session exists and no packs were opened');
    return EXIT.ok;
  }

  const result = await probeSession(cfg, cfg.probePath);
  log.info('probe response', { path: cfg.probePath, kind: result.kind, status: result.status });
  switch (result.kind) {
    case 'json':
      log.info('the saved session is valid', { body: result.body });
      return EXIT.ok;
    case 'unauthenticated':
      log.error('the saved session is no longer accepted; run `npm run login`');
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

  configureLogger(cfg.logLevel, [cfg.password]);
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
      case 'run':
        return await doRun(cfg);
    }
  } catch (error) {
    if (error instanceof LoginSuppressedError) {
      log.warn(error.message);
      return EXIT.ok;
    }
    if (error instanceof LoginFailedError) {
      log.error(`login failed (${error.reason}): ${error.message}`);
      if (error.reason === 'turnstile_blocked') {
        log.error(
          'Cloudflare refused to issue a token from this IP. Fastest fix: run `npm run login` ' +
            'on your own machine and copy data/storage-state.json and data/session-meta.json ' +
            'onto this host -- keep WM_USER_AGENT consistent. See the README.',
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
