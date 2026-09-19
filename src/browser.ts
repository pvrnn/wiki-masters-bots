import { mkdirSync } from 'node:fs';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Config } from './config.js';
import { log } from './logger.js';
import { randInt, sleep } from './util.js';

/**
 * Launches a browser tuned to look like an ordinary one.
 *
 * Ordered by how much each actually matters against Turnstile:
 *  1. headed (the caller runs us under Xvfb in Docker) -- headless is the
 *     single biggest tell;
 *  2. real Google Chrome rather than bundled Chromium;
 *  3. the automation flags stripped;
 *  4. a persistent profile, so device trust and cookies survive restarts;
 *  5. a coherent locale/timezone/viewport.
 *
 * Deliberately no navigator.webdriver patching: --disable-blink-features=
 * AutomationControlled already covers it, and a hand-written getter is itself
 * detectable.
 */
export async function launchHardenedContext(cfg: Config): Promise<BrowserContext> {
  mkdirSync(cfg.profileDir, { recursive: true });

  const options = {
    headless: cfg.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      // Required in most containers; harmless elsewhere.
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1280, height: 800 },
    locale: cfg.locale,
    timezoneId: cfg.timezone,
    baseURL: cfg.baseUrl,
    ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
  };

  if (cfg.browserChannel) {
    try {
      const context = await chromium.launchPersistentContext(cfg.profileDir, {
        ...options,
        channel: cfg.browserChannel,
      });
      log.debug('launched browser', { channel: cfg.browserChannel, headless: cfg.headless });
      return context;
    } catch (error) {
      // Real Chrome isn't installed here. Bundled Chromium is a weaker
      // fingerprint but still works, so degrade rather than fail the run.
      log.warn('could not launch browser channel; falling back to bundled Chromium', {
        channel: cfg.browserChannel,
        error: String(error),
        hint: 'install it with: npx playwright install chrome',
      });
    }
  }

  const context = await chromium.launchPersistentContext(cfg.profileDir, options);
  log.debug('launched bundled Chromium', { headless: cfg.headless });
  return context;
}

/** The UA the browser really sends, so API calls can match it exactly. */
export async function readUserAgent(page: Page): Promise<string | undefined> {
  try {
    return await page.evaluate(() => navigator.userAgent);
  } catch {
    return undefined;
  }
}

/** Moves the pointer to an element in several steps rather than teleporting. */
export async function humanMouseTo(page: Page, locator: Locator): Promise<void> {
  try {
    const box = await locator.boundingBox({ timeout: 5_000 });
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: randInt(8, 18),
    });
    await sleep(randInt(80, 260));
  } catch {
    // Pointer choreography is a nice-to-have; never fail the flow for it.
  }
}

/** Clicks and types key by key, instead of setting the value in one shot. */
export async function humanType(page: Page, locator: Locator, text: string): Promise<void> {
  await humanMouseTo(page, locator);
  await locator.click({ delay: randInt(40, 120) });
  await sleep(randInt(60, 200));
  await locator.pressSequentially(text, { delay: randInt(55, 145) });
  await sleep(randInt(100, 350));
}
