import type { z } from 'zod';

import type { ListAccountsInputSchema } from '../contracts.js';
import { DEFAULT_PORT, DEFAULT_SECURE, getAccountEnvEntries } from '../config.js';
import { makeOk, type ToolHint, type ToolResult } from './runtime.js';

type AccountConnection = Readonly<{
  account_id: string;
  host: string;
  port: number;
  secure: boolean;
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

function toAccountConnection(accountIdSegment: string, prefix: string): AccountConnection | null {
  const host = process.env[`${prefix}HOST`];
  if (!host) {
    return null;
  }
  const port = parseNumberEnv(process.env[`${prefix}PORT`], DEFAULT_PORT);
  const secure = parseBooleanEnv(process.env[`${prefix}SECURE`], DEFAULT_SECURE);

  return {
    account_id: accountIdSegment.toLowerCase(),
    host,
    port,
    secure,
  };
}

export function handleListAccounts(_args: z.infer<typeof ListAccountsInputSchema>): ToolResult {
  const entries = getAccountEnvEntries();
  const accounts = entries
    .map((entry) => toAccountConnection(entry.accountId, entry.prefix))
    .filter((account): account is AccountConnection => account !== null)
    .slice(0, 50);

  const hints: ToolHint[] = [];
  const firstAccountId = accounts[0]?.account_id;
  if (firstAccountId) {
    hints.push({
      tool: 'imap_verify_account',
      arguments: { account_id: firstAccountId },
      reason: 'Verify connectivity and authentication for the first configured account.',
    });
  }

  const summary =
    accounts.length === 1
      ? 'Discovered 1 configured IMAP account.'
      : `Discovered ${accounts.length} configured IMAP accounts.`;

  return makeOk(summary, { accounts }, hints);
}
