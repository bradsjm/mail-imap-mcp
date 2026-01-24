type AccountConfig = Readonly<{
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}>;

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

function parseNumberEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function normalizeEnvSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

export function validateEnvironment(): string[] {
  const errors: string[] = [];
  const requiredKeys: Array<{ accountId: string; prefix: string }> = [];
  const hostKeyPattern = /^MAIL_IMAP_(.+)_HOST$/;

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

  if (requiredKeys.length === 0) {
    requiredKeys.push({ accountId: 'DEFAULT', prefix: 'MAIL_IMAP_DEFAULT_' });
  }

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

export const WRITE_ENABLED = parseBooleanEnv(process.env['MAIL_IMAP_WRITE_ENABLED'], false);
export const CONNECT_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_CONNECT_TIMEOUT_MS'],
  30_000,
);
export const GREETING_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_GREETING_TIMEOUT_MS'],
  15_000,
);
export const SOCKET_TIMEOUT_MS = parseNumberEnv(
  process.env['MAIL_IMAP_SOCKET_TIMEOUT_MS'],
  300_000,
);

export type { AccountConfig };
