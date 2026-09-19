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
 * The widget writes its token into a hidden input in the host document. That
 * input is the only authoritative "solved" signal -- the checkbox rendering as
 * ticked does not mean a token was issued, so we never infer from pixels.
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

export async function handleTurnstile(page: Page, cfg: Config): Promise<TurnstileOutcome> {
  const widget = page.locator(WIDGET_FRAME).first();
  const widgetVisible = await widget.isVisible({ timeout: 5_000 }).catch(() => false);

  // Invisible mode issues a token with no widget at all, so check for one
  // briefly even when nothing is on screen.
  if (await waitForToken(page, widgetVisible ? 15_000 : 2_000)) {
    log.info('turnstile solved without interaction', { widgetVisible });
    return widgetVisible ? 'auto' : 'absent';
  }

  if (!widgetVisible) {
    log.debug('no turnstile widget on the page');
    return 'absent';
  }

  log.info('turnstile did not self-solve; clicking the checkbox');
  const checkbox = page.frameLocator(WIDGET_FRAME).locator('input[type="checkbox"]').first();
  try {
    await humanMouseTo(page, widget);
    await checkbox.click({ timeout: 10_000 });
  } catch (error) {
    // Some widget versions don't expose a real checkbox element. Clicking the
    // frame itself hits the same hit-target.
    log.debug('checkbox not directly clickable; clicking the widget frame', {
      error: String(error),
    });
    await widget.click({ timeout: 5_000 }).catch(() => {});
  }

  if (await waitForToken(page, cfg.turnstileTimeoutMs)) {
    log.info('turnstile solved after click');
    return 'clicked';
  }

  log.error('turnstile issued no token before the deadline', {
    timeoutMs: cfg.turnstileTimeoutMs,
  });
  return 'blocked';
}
