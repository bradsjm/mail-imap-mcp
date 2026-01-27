import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_GREETING_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_SECURE,
  DEFAULT_SOCKET_TIMEOUT_MS,
  DEFAULT_WRITE_ENABLED,
  getAccountEnvEntries,
} from './config.js';

type EnvValueSource = 'default' | 'env' | 'unset';

type ResolvedEnvValue = Readonly<{
  value: string;
  source: EnvValueSource;
}>;

function resolveStringEnv(name: string, redact = false): ResolvedEnvValue {
  const raw = process.env[name];
  if (raw === undefined) {
    return { value: '<unset>', source: 'unset' };
  }
  if (redact) {
    return { value: '<redacted>', source: 'env' };
  }
  return { value: raw, source: 'env' };
}

function resolveNumberEnv(name: string, defaultValue: number): ResolvedEnvValue {
  const raw = process.env[name];
  if (raw === undefined) {
    return { value: String(defaultValue), source: 'default' };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { value: String(defaultValue), source: 'default' };
  }
  return { value: String(parsed), source: 'env' };
}

function resolveBooleanEnv(name: string, defaultValue: boolean): ResolvedEnvValue {
  const raw = process.env[name];
  if (raw === undefined) {
    return { value: String(defaultValue), source: 'default' };
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return { value: 'true', source: 'env' };
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return { value: 'false', source: 'env' };
  }
  return { value: String(defaultValue), source: 'default' };
}

function formatEnvLine(name: string, resolved: ResolvedEnvValue): string {
  const suffix = resolved.source === 'default' ? ' (default)' : '';
  return `  ${name}=${resolved.value}${suffix}`;
}

function formatAccountSection(accountId: string, prefix: string): string[] {
  const lines: string[] = [];
  lines.push(`  Account: ${accountId.toLowerCase()} (${prefix}*)`);
  lines.push(formatEnvLine(`${prefix}HOST`, resolveStringEnv(`${prefix}HOST`)));
  lines.push(formatEnvLine(`${prefix}PORT`, resolveNumberEnv(`${prefix}PORT`, DEFAULT_PORT)));
  lines.push(
    formatEnvLine(`${prefix}SECURE`, resolveBooleanEnv(`${prefix}SECURE`, DEFAULT_SECURE)),
  );
  lines.push(formatEnvLine(`${prefix}USER`, resolveStringEnv(`${prefix}USER`)));
  lines.push(
    formatEnvLine(`${prefix}PASS`, resolveStringEnv(`${prefix}PASS`, true)).replace(
      '<redacted>',
      '<redacted> (set)',
    ),
  );
  return lines;
}

export function getHelpText(): string {
  const lines: string[] = [];
  lines.push('mail-imap-mcp');
  lines.push('');
  lines.push('Usage:');
  lines.push('  mail-imap-mcp [--help|-h]');
  lines.push('');
  lines.push('Environment:');
  lines.push('  Secrets are redacted in this output.');
  lines.push('  Accounts are discovered via MAIL_IMAP_*_HOST.');
  lines.push('  If none are set, the default account is used.');
  lines.push('');

  const accountEntries = getAccountEnvEntries();
  for (const entry of accountEntries) {
    lines.push(...formatAccountSection(entry.accountId, entry.prefix));
    lines.push('');
  }

  lines.push('  Server settings:');
  lines.push(
    formatEnvLine(
      'MAIL_IMAP_WRITE_ENABLED',
      resolveBooleanEnv('MAIL_IMAP_WRITE_ENABLED', DEFAULT_WRITE_ENABLED),
    ),
  );
  lines.push(
    formatEnvLine(
      'MAIL_IMAP_CONNECT_TIMEOUT_MS',
      resolveNumberEnv('MAIL_IMAP_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS),
    ),
  );
  lines.push(
    formatEnvLine(
      'MAIL_IMAP_GREETING_TIMEOUT_MS',
      resolveNumberEnv('MAIL_IMAP_GREETING_TIMEOUT_MS', DEFAULT_GREETING_TIMEOUT_MS),
    ),
  );
  lines.push(
    formatEnvLine(
      'MAIL_IMAP_SOCKET_TIMEOUT_MS',
      resolveNumberEnv('MAIL_IMAP_SOCKET_TIMEOUT_MS', DEFAULT_SOCKET_TIMEOUT_MS),
    ),
  );
  lines.push('');
  lines.push('  Prompts:');
  lines.push('  The server also exposes phishing triage prompts via prompts/list and prompts/get.');
  lines.push('  - phishing-triage-json');
  lines.push('  - phishing-header-spoofing-check');
  lines.push('  - phishing-url-cta-risk');
  lines.push('  - phishing-premise-alignment');
  lines.push('  - phishing-user-facing-explanation');
  lines.push('  - classify-email-destination');
  lines.push('  - classify-email-destination-scored');
  lines.push('  - classify-email-destination-thread-aware');
  lines.push('');

  return lines.join('\n');
}
