/**
 * Configuration for a single IMAP account.
 *
 * Contains the connection details and credentials needed to authenticate
 * and connect to an IMAP server. All values are read-only.
 */
type AccountConfig = Readonly<{
  /** IMAP server hostname or IP address */
  host: string;
  /** IMAP server port number (typically 993 for SSL, 143 for non-SSL) */
  port: number;
  /** Whether to use TLS/SSL for the connection */
  secure: boolean;
  /** IMAP username for authentication */
  user: string;
  /** IMAP password or app-specific token for authentication */
  pass: string;
}>;

/**
 * Parse an environment variable string into a boolean value.
 *
 * Accepts common truthy values ('1', 'true', 'yes', 'y', 'on') and falsy values
 * ('0', 'false', 'no', 'n', 'off'), case-insensitive. Returns the default value
 * if the input is undefined or doesn't match any known values.
 *
 * @param value - The environment variable string value to parse
 * @param defaultValue - The default value to return if parsing fails
 * @returns The parsed boolean value
 */
function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/**
 * Parse an environment variable string into a numeric value.
 *
 * Converts the string to a number using `Number()`. Returns the default value
 * if the input is undefined or results in NaN/Infinity.
 *
 * @param value - The environment variable string value to parse
 * @param defaultValue - The default value to return if parsing fails
 * @returns The parsed numeric value
 */
function parseNumberEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Normalize an account identifier for use in environment variable names.
 *
 * Converts the identifier to uppercase and replaces non-alphanumeric characters
 * with underscores. This ensures consistent environment variable naming conventions.
 *
 * @example
 * ```ts
 * normalizeEnvSegment('my-account'); // Returns 'MY_ACCOUNT'
 * normalizeEnvSegment('default');    // Returns 'DEFAULT'
 * ```
 *
 * @param value - The account identifier to normalize
 * @returns The normalized identifier suitable for environment variable names
 */
export function normalizeEnvSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

/**
 * Validate that all required environment variables are configured.
 *
 * Scans environment variables for IMAP account configurations and validates
 * that each account has the required fields (HOST, USER, PASS). If no accounts
 * are explicitly configured, validates the default account configuration.
 *
 * @returns An array of error messages describing missing configuration.
 *          Returns an empty array if all configurations are valid.
 */
export function validateEnvironment(): string[] {
  const errors: string[] = [];
  const requiredKeys: Array<{ accountId: string; prefix: string }> = [];
  const hostKeyPattern = /^MAIL_IMAP_(.+)_HOST$/;

  // Scan environment variables for IMAP account configurations
  // We look for keys ending in _HOST to discover configured accounts
  for (const key of Object.keys(process.env)) {
    const match = hostKeyPattern.exec(key);
    if (!match) {
      continue;
    }
    const accountId = match[1] ?? '';
    if (!accountId) {
      continue;
    }
    requiredKeys.push({ accountId, prefix: `MAIL_IMAP_${accountId}_` });
  }

  // If no accounts are explicitly configured, fall back to the default account
  if (requiredKeys.length === 0) {
    requiredKeys.push({ accountId: 'DEFAULT', prefix: 'MAIL_IMAP_DEFAULT_' });
  }

  // Validate that each account has all required fields (HOST, USER, PASS)
  for (const entry of requiredKeys) {
    const missing: string[] = [];
    if (!process.env[`${entry.prefix}HOST`]) {
      missing.push(`${entry.prefix}HOST`);
    }
    if (!process.env[`${entry.prefix}USER`]) {
      missing.push(`${entry.prefix}USER`);
    }
    if (!process.env[`${entry.prefix}PASS`]) {
      missing.push(`${entry.prefix}PASS`);
    }
    if (missing.length > 0) {
      errors.push(
        `Account '${entry.accountId.toLowerCase()}' is missing required env vars: ${missing.join(
          ', ',
        )}`,
      );
    }
  }

  return errors;
}

/**
 * Load IMAP account configuration from environment variables.
 *
 * Retrieves and parses environment variables for the specified account ID.
 * The expected variable names follow the pattern `MAIL_IMAP_{ACCOUNT_ID}_*`
 * where `{ACCOUNT_ID}` is the normalized version of the provided ID.
 *
 * @example
 * ```ts
 * // For account ID "my-account", expects:
 * // MAIL_IMAP_MY_ACCOUNT_HOST=imap.example.com
 * // MAIL_IMAP_MY_ACCOUNT_PORT=993
 * // MAIL_IMAP_MY_ACCOUNT_SECURE=true
 * // MAIL_IMAP_MY_ACCOUNT_USER=user@example.com
 * // MAIL_IMAP_MY_ACCOUNT_PASS=password
 * ```
 *
 * @param accountId - The account identifier to load configuration for
 * @returns The parsed account configuration, or null if required fields are missing
 */
export function loadAccountConfig(accountId: string): AccountConfig | null {
  const prefix = `MAIL_IMAP_${normalizeEnvSegment(accountId)}_`;

  const host = process.env[`${prefix}HOST`];
  const user = process.env[`${prefix}USER`];
  const pass = process.env[`${prefix}PASS`];

  if (!host || !user || !pass) {
    return null;
  }

  const port = parseNumberEnv(process.env[`${prefix}PORT`], 993);
  const secure = parseBooleanEnv(process.env[`${prefix}SECURE`], true);

  return { host, port, secure, user, pass };
}

/** Whether write operations (move, delete, flag updates) are enabled for this server instance */
export const WRITE_ENABLED = parseBooleanEnv(process.env['MAIL_IMAP_WRITE_ENABLED'], false);
/** Maximum time in milliseconds to wait for an IMAP connection to be established */
export const CONNECT_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_CONNECT_TIMEOUT_MS'],
  30_000,
);
/** Maximum time in milliseconds to wait for the IMAP server greeting message */
export const GREETING_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_GREETING_TIMEOUT_MS'],
  15_000,
);
/** Maximum time in milliseconds to wait for activity on the IMAP socket before timing out */
export const SOCKET_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_SOCKET_TIMEOUT_MS'],
  300_000,
);

export type { AccountConfig };
