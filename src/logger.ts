export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never printed, whatever the log level. */
const SECRET_KEYS =
  /^(password|passwd|cookie|cookies|set-cookie|authorization|value|token|cf-turnstile-response)$/i;

let minRank = RANK.info;
let secrets: string[] = [];

/**
 * @param secretValues Literal strings scrubbed from all output. Pass the
 *   password so it can never reach a log line by any route.
 */
export function configureLogger(level: LogLevel, secretValues: string[] = []): void {
  minRank = RANK[level];
  // Short values would scrub far too much (e.g. a 2-char password).
  secrets = secretValues.filter((v) => v.length >= 4);
}

function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

function render(meta: unknown): string {
  if (meta === undefined) return '';
  try {
    return ` ${JSON.stringify(meta, (key, value) =>
      SECRET_KEYS.test(key) ? '[redacted]' : value,
    )}`;
  } catch {
    return ' [unserializable meta]';
  }
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (RANK[level] < minRank) return;
  const line = scrub(
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${render(meta)}`,
  );
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};

export function isLogLevel(value: string): value is LogLevel {
  return value in RANK;
}
