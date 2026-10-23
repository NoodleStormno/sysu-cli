export class CliError extends Error {
  constructor(code, message, { hint, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    if (hint) this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

export const EXIT_CODES = Object.freeze({
  USAGE_ERROR: 2,
  UNKNOWN_COMMAND: 2,
  INVALID_ARGUMENT: 2,
  LOGIN_REQUIRED: 3,
  AUTH_LOGIN_INCOMPLETE: 3,
  AUTH_LOGIN_TIMEOUT: 3,
  PERMISSION_DENIED: 4,
  RATE_LIMITED: 4,
  UPSTREAM_ERROR: 4,
  UPSTREAM_CHANGED: 4,
  NETWORK_ERROR: 5,
  BROWSER_UNAVAILABLE: 6,
  BROWSER_BUSY: 6,
  BACKEND_UNAVAILABLE: 6
});

export function exitCodeFor(code) {
  return EXIT_CODES[code] ?? 1;
}

export function toErrorPayload(error) {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.details !== undefined ? { details: error.details } : {})
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error)
  };
}

export const LOGIN_HINT = 'Run `sysu-cli auth refresh` to renew from the saved unified-auth session; if that fails, run `sysu-cli auth login` and finish login in the opened browser.';

export function loginRequired(message = 'SYSU JWXT session is missing or expired.', details) {
  return new CliError('LOGIN_REQUIRED', message, { hint: LOGIN_HINT, details });
}

export function invalidArgument(message, details) {
  return new CliError('INVALID_ARGUMENT', message, {
    hint: 'Run `sysu-cli <command> --help` to see supported options.',
    details
  });
}

export function upstreamChanged(message, details) {
  return new CliError('UPSTREAM_CHANGED', message, {
    hint: 'The JWXT API response shape may have changed. Re-run with `--raw`, or capture traffic with `sysu-cli dev capture`, then update the parser.',
    details
  });
}
