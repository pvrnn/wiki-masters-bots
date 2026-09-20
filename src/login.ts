import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import { requireCredentials, type Config } from './config.js';
import { humanMouseTo, humanType, readUserAgent } from './browser.js';
import { LoginFailedError, SiteUnreachableError } from './errors.js';
import { log } from './logger.js';
import { handleTurnstile } from './turnstile.js';
import { onlyOnSuccess, randInt, sleep } from './util.js';

/**
 * The login page was never inspected (the site is unreachable from the
 * development sandbox), so each field is looked up through an ordered list of
 * candidates, most semantic first. French patterns are included because the
 * site is French-facing.
 */
function emailCandidates(page: Page): Locator[] {
  return [
    page.getByLabel(/e-?mail|courriel/i),
    page.getByPlaceholder(/e-?mail|courriel/i),
    page.locator('input[type="email"]'),
    page.locator('input[name="email" i], input#email, input[autocomplete="username"]'),
  ];
}

function passwordCandidates(page: Page): Locator[] {
  return [
    page.getByLabel(/password|mot de passe/i),
    page.getByPlaceholder(/password|mot de passe/i),
    page.locator('input[type="password"]'),
    page.locator('input[name="password" i], input#password'),
  ];
}

function submitCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /log ?in|sign ?in|se connecter|connexion|valider/i }),
    page.locator('button[type="submit"], input[type="submit"]'),
    page.getByRole('button', { name: /continue|continuer|suivant/i }),
  ];
}

const ERROR_SELECTOR =
  '[role="alert"], .error, .errors, .alert-danger, .alert-error, [class*="error" i], [data-error]';

async function firstVisible(
  candidates: Locator[],
  label: string,
  perCandidateMs = 2_500,
): Promise<Locator> {
  for (const [index, candidate] of candidates.entries()) {
    const target = candidate.first();
    try {
      await target.waitFor({ state: 'visible', timeout: perCandidateMs });
      log.debug('resolved form field', { label, candidate: index });
      return target;
    } catch {
      // Expected for every candidate but the matching one.
    }
  }
  throw new LoginFailedError(`could not find the ${label} field on the login page`, 'form_not_found');
}

/** Cookies the app sets to identify a session, as opposed to Cloudflare's own. */
function looksLikeAuthCookie(name: string): boolean {
  if (/^(cf_|__cf|_ga|_gid|_gat|_fb|__stripe)/i.test(name)) return false;
  return /sess|token|auth|sid|jwt|remember|login|identity|connect/i.test(name);
}

async function authCookieNames(context: BrowserContext): Promise<string[]> {
  const cookies = await context.cookies();
  return cookies.filter((c) => looksLikeAuthCookie(c.name)).map((c) => c.name);
}

function onLoginPage(page: Page): boolean {
  try {
    return /\/login/i.test(new URL(page.url()).pathname);
  } catch {
    return false;
  }
}

/** Screenshot + HTML, so an unreachable page can still be diagnosed after the fact. */
async function dumpDebug(page: Page, cfg: Config, tag: string): Promise<string | undefined> {
  try {
    mkdirSync(cfg.debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(cfg.debugDir, `${tag}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    writeFileSync(`${base}.html`, await page.content());
    log.info('wrote debug artifacts', { base });
    return base;
  } catch (error) {
    log.warn('could not write debug artifacts', { error: String(error) });
    return undefined;
  }
}

async function detectWall(page: Page): Promise<'two_factor' | 'rate_limited' | undefined> {
  const text = (await page.textContent('body').catch(() => '')) ?? '';
  if (/two[- ]factor|verification code|code de vérification|authenticator|2fa/i.test(text)) {
    return 'two_factor';
  }
  if (/too many attempts|trop de tentatives|rate limit|temporarily locked|compte bloqué/i.test(text)) {
    return 'rate_limited';
  }
  return undefined;
}

export type LoginResult = { userAgent: string | undefined; turnstile: string };

/**
 * Drives the real login form and leaves the context authenticated.
 * Throws LoginFailedError with a `reason` naming which wall we hit.
 */
export async function performLogin(
  context: BrowserContext,
  cfg: Config,
): Promise<LoginResult> {
  const { email: emailValue, password: passwordValue } = requireCredentials(cfg);
  const page = await context.newPage();
  try {
    const loginUrl = `${cfg.baseUrl}/login`;
    log.info('opening the login page', { url: loginUrl });
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/net::ERR_|ERR_PROXY|NS_ERROR|Timeout .* exceeded/i.test(detail)) {
        throw new SiteUnreachableError(
          `could not reach ${loginUrl} -- ${detail.split('\n')[0] ?? detail}`,
        );
      }
      throw error;
    }
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});

    const email = await firstVisible(emailCandidates(page), 'email');
    const password = await firstVisible(passwordCandidates(page), 'password');

    await humanType(page, email, emailValue);
    await humanType(page, password, passwordValue);

    // Before submitting: many forms keep the submit button disabled until the
    // Turnstile token exists.
    const turnstile = await handleTurnstile(page, cfg);
    if (turnstile === 'blocked') {
      await dumpDebug(page, cfg, 'turnstile-blocked');
      throw new LoginFailedError(
        'Cloudflare Turnstile issued no token; cannot log in from this IP right now',
        'turnstile_blocked',
      );
    }

    const wall = await detectWall(page);
    if (wall) {
      await dumpDebug(page, cfg, wall);
      throw new LoginFailedError(`login is gated by ${wall.replace('_', ' ')}`, wall);
    }

    const before = new Set(await authCookieNames(context));
    const submit = await firstVisible(submitCandidates(page), 'submit button');
    await humanMouseTo(page, submit);
    await sleep(randInt(150, 500));
    log.info('submitting the login form');
    await submit.click({ delay: randInt(40, 120) });

    // Whichever happens first tells us where we stand. Waiting on navigation
    // alone would hang on a single-page app that never leaves /login.
    const settleMs = 45_000;
    const outcome = await Promise.race([
      onlyOnSuccess(
        page.waitForURL((url) => !/\/login/i.test(url.pathname), { timeout: settleMs }),
      ).then(() => 'navigated' as const),
      onlyOnSuccess(
        page.waitForFunction(
          (names: string[]) =>
            document.cookie.split(';').some((c) => {
              const name = c.split('=')[0]?.trim() ?? '';
              return name.length > 0 && !names.includes(name);
            }),
          [...before],
          { timeout: settleMs },
        ),
      ).then(() => 'cookie' as const),
      onlyOnSuccess(
        page.locator(ERROR_SELECTOR).first().waitFor({ state: 'visible', timeout: settleMs }),
      ).then(() => 'error' as const),
      sleep(settleMs).then(() => 'timeout' as const),
    ]);
    log.debug('post-submit outcome', { outcome, url: page.url() });

    // httpOnly session cookies never appear in document.cookie, so the
    // authoritative check is the context's own cookie jar.
    await sleep(1_500);
    const after = await authCookieNames(context);
    const gained = after.filter((name) => !before.has(name));
    const offLogin = !onLoginPage(page);

    if (gained.length === 0 && !offLogin) {
      const message = (await page.locator(ERROR_SELECTOR).first().textContent().catch(() => null))
        ?.trim()
        .slice(0, 200);
      await dumpDebug(page, cfg, 'login-failed');
      throw new LoginFailedError(
        message
          ? `login rejected: ${message}`
          : 'login did not complete: still on /login with no new session cookie',
        message ? 'bad_credentials' : 'unconfirmed',
      );
    }

    if (gained.length === 0) {
      // Left /login but nothing matched our auth-cookie heuristic. Probably a
      // differently-named cookie; proceed, but say so, because the first API
      // call is what will really settle it.
      log.warn('left the login page but no recognisable session cookie was set', {
        url: page.url(),
        cookies: after,
      });
    }

    log.info('login succeeded', {
      url: page.url(),
      turnstile,
      newCookies: gained,
    });
    return { userAgent: await readUserAgent(page), turnstile };
  } finally {
    await page.close().catch(() => {});
  }
}
