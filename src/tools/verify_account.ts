import type { ImapFlow } from 'imapflow';
import type { z } from 'zod';

import type { VerifyAccountInputSchema } from '../contracts.js';
import { loadAccountOrError } from '../utils/account.js';
import { makeError, makeOk, nowUtcIso, type ToolResult } from './runtime.js';
import { withImapClient } from './runtime.js';

function extractCapabilities(capabilities: ImapFlow['capabilities']): string[] {
  const names: string[] = [];
  for (const [name, value] of capabilities) {
    if (value === false) {
      continue;
    }
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names.slice(0, 256);
}

export async function handleVerifyAccount(
  args: z.infer<typeof VerifyAccountInputSchema>,
): Promise<ToolResult> {
  const accountResult = loadAccountOrError(args.account_id);
  if ('error' in accountResult) {
    return makeError(accountResult.error);
  }
  const account = accountResult.account;

  const startedAtNs = process.hrtime.bigint();
  let capabilities: string[] = [];

  await withImapClient(account, async (client) => {
    await client.noop();
    capabilities = extractCapabilities(client.capabilities);
  });

  const latencyMs = Math.max(
    0,
    Math.round(Number(process.hrtime.bigint() - startedAtNs) / 1_000_000),
  );

  return makeOk(
    `Verified IMAP connectivity for account '${args.account_id}' in ${latencyMs} ms.`,
    {
      account_id: args.account_id,
      ok: true,
      latency_ms: latencyMs,
      server: {
        host: account.host,
        port: account.port,
        secure: account.secure,
      },
      capabilities,
    },
    [],
    { verified_at: nowUtcIso() },
  );
}
