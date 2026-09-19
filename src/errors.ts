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

/** The pack loop stopped early for a reason that needs a human. */
export class PackRunAbortedError extends Error {}
