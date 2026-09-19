import type { Config } from './config.js';
import { log } from './logger.js';

/**
 * Best-effort alert on a failure that needs a human. Off unless
 * WM_NOTIFY_WEBHOOK_URL is set.
 *
 * The body carries the message under three keys so one URL shape works for
 * Discord (`content`), Slack (`text`) and generic receivers (`message`).
 * A failed notification is never allowed to fail the run.
 */
export async function notify(cfg: Config, message: string): Promise<void> {
  if (!cfg.notifyWebhookUrl) return;
  try {
    const res = await fetch(cfg.notifyWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn('notification webhook rejected', { status: res.status });
    else log.debug('notification sent');
  } catch (error) {
    log.warn('notification webhook failed', { error: String(error) });
  }
}
