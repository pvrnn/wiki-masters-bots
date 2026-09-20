/** Typed failures, so callers can branch on cause instead of parsing messages. */

/** Bad or missing configuration. Exits 1 -- nothing was attempted. */
export class ConfigError extends Error {}

/**
 * The saved session was rejected. Recoverable: the caller may re-login once.
 */
export class AuthExpiredError extends Error {}

/**
 * Cloudflare blocked the request itself (not the app rejecting our session).
 * A different failure with a different fix, so it is a different type.
 */
export class CloudflareBlockedError extends Error {}

/**
 * The site could not be reached at all -- DNS, firewall, proxy or a wrong
 * WM_BASE_URL. Distinct from a login failure: nothing about our credentials or
 * fingerprint was rejected, so it must not consume the login backoff budget.
 */
export class SiteUnreachableError extends Error {}

/** Login could not complete. `reason` names which wall we hit. */
export class LoginFailedError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'turnstile_blocked'
      | 'two_factor'
      | 'rate_limited'
      | 'bad_credentials'
      | 'form_not_found'
      | 'unconfirmed',
  ) {
    super(message);
  }
}

/** Login is in backoff after earlier failures. Not an error condition. */
export class LoginSuppressedError extends Error {
  constructor(readonly until: Date) {
    super(`login suppressed until ${until.toISOString()}`);
  }
}

/**
 * A supplied cookie could not be decoded, or its refresh token is spent.
 * Distinct from LoginFailedError: the password flow was never involved, so this
 * must not consume the login backoff ledger.
 */
export class SessionImportError extends Error {}

/**
 * The site wants a fresh human verification before it will open more packs
 * (the `pack_human_verified_at` gate). No amount of retrying helps -- a person
 * has to open a pack in a real browser.
 */
export class HumanVerificationRequiredError extends Error {}

/**
 * The account carries strikes, a sanction or an activity block. We stop rather
 * than keep poking it.
 */
export class AccountSanctionedError extends Error {}

/** The pack loop stopped early for a reason that needs a human. */
export class PackRunAbortedError extends Error {}
