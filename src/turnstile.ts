import type { Page } from 'playwright';
import type { Config } from './config.js';
import { humanMouseTo } from './browser.js';
import { log } from './logger.js';

/**
 * absent  -- no challenge on the page
 * auto    -- the widget issued a token on its own (the good case)
 * clicked -- we clicked the checkbox and it then issued a token
 * blocked -- no token before the deadline; a hard stop, never retried in-run
 */
export type TurnstileOutcome = 'absent' | 'auto' | 'clicked' | 'blocked';

const WIDGET_FRAME = 'iframe[src*="challenges.cloudflare.com"]';
const TOKEN_INPUT = 'input[name="cf-turnstile-response"]';

/**
 * Anything that indicates a challenge is on the page.
 *
 * Presence is tested with count(), not isVisible(): the token input is always
 * hidden, and the iframe often has no box yet while it boots. An earlier version
 * probed visibility and so concluded 'absent' on a page that really did have a
 * widget -- which silently skipped the click entirely.
 */
const PRESENCE_SELECTORS = [
  WIDGET_FRAME,
  '.cf-turnstile',
  '[data-sitekey]',
  'div[id^="cf-chl-widget"]',
  '#cf-chl-widget',
  TOKEN_INPUT,
];

/**
 * The widget writes its token into a hidden input in the host document. That
 * input is the only authoritative "solved" signal -- a ticked-looking checkbox
 * does not mean a token was issued, so we never infer from pixels.
 */
function waitForToken(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .waitForFunction(
      (selector: string) => {
        const el = document.querySelector<HTMLInputElement>(selector);
        return Boolean(el?.value && el.value.length > 20);
      },
      TOKEN_INPUT,
      { timeout: timeoutMs },
    )
    .then(
      () => true,
      () => false,
    );
}

async function detectWidget(page: Page): Promise<string | undefined> {
  for (const selector of PRESENCE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return selector;
  }
  return undefined;
}

export async function handleTurnstile(page: Page, cfg: Config): Promise<TurnstileOutcome> {
  // Give the widget a moment to inject itself before deciding it is absent.
  let matched = await detectWidget(page);
  if (!matched) {
    await page.waitForTimeout(2_000);
    matched = await detectWidget(page);
  }

  if (!matched) {
    log.debug('no turnstile widget on the page');
    return 'absent';
  }
  log.info('turnstile challenge present', { matchedBy: matched });

  // Often it just issues a token by itself; that is the good case.
  if (await waitForToken(page, 15_000)) {
    log.info('turnstile solved without interaction');
    return 'auto';
  }

  log.info('turnstile did not self-solve; clicking the checkbox');
  const frame = page.locator(WIDGET_FRAME).first();
  const hasFrame = (await frame.count().catch(() => 0)) > 0;

  if (hasFrame) {
    const checkbox = page.frameLocator(WIDGET_FRAME).locator('input[type="checkbox"]').first();
    try {
      await humanMouseTo(page, frame);
      await checkbox.click({ timeout: 10_000 });
    } catch (error) {
      // Some widget versions expose no real checkbox element; the frame itself
      // covers the same hit-target.
      log.debug('checkbox not directly clickable; clicking the widget frame', {
        error: String(error),
      });
      await frame.click({ timeout: 5_000 }).catch(() => {});
    }
  } else {
    // No iframe yet -- click the container and hope it boots.
    log.debug('no widget iframe found; clicking the container instead', { matchedBy: matched });
    await page
      .locator(matched)
      .first()
      .click({ timeout: 5_000 })
      .catch((error: unknown) => log.debug('container click failed', { error: String(error) }));
  }

  if (await waitForToken(page, cfg.turnstileTimeoutMs)) {
    log.info('turnstile solved after click');
    return 'clicked';
  }

  log.error('turnstile issued no token before the deadline', {
    timeoutMs: cfg.turnstileTimeoutMs,
    matchedBy: matched,
  });
  return 'blocked';
}
