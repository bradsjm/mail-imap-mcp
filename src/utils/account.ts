import type { AccountConfig } from '../config.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';

export type AccountLookupResult = Readonly<{ account: AccountConfig } | { error: string }>;

/**
 * Resolve an account config or return a human-friendly error message.
 *
 * Centralizes the env var requirements so tool handlers stay focused on IMAP logic.
 */
export function loadAccountOrError(accountId: string): AccountLookupResult {
  const account = loadAccountConfig(accountId);
  if (account) {
    return { account };
  }

  const prefix = `MAIL_IMAP_${normalizeEnvSegment(accountId)}_`;
  return {
    error: [
      `Account '${accountId}' is not configured.`,
      'Set env vars:',
      `- ${prefix}HOST`,
      `- ${prefix}USER`,
      `- ${prefix}PASS`,
      `Optional: ${prefix}PORT (default 993), ${prefix}SECURE (default true)`,
    ].join('\n'),
  };
}
