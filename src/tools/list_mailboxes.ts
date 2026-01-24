import type { z } from 'zod';

import type { ListMailboxesInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { makeError, makeOk, type ToolResult, type ToolHint } from './runtime.js';
import { withImapClient } from './runtime.js';

export async function handleListMailboxes(
  args: z.infer<typeof ListMailboxesInputSchema>,
): Promise<ToolResult> {
  const account = loadAccountConfig(args.account_id);
  if (!account) {
    const prefix = `MAIL_IMAP_${normalizeEnvSegment(args.account_id)}_`;
    return makeError(
      [
        `Account '${args.account_id}' is not configured.`,
        `Set env vars:`,
        `- ${prefix}HOST`,
        `- ${prefix}USER`,
        `- ${prefix}PASS`,
        `Optional: ${prefix}PORT (default 993), ${prefix}SECURE (default true)`,
      ].join('\n'),
    );
  }

  const mailboxes = await withImapClient(account, (client) => client.list());
  const mailboxSummaries = mailboxes
    .map((mailbox) => ({
      name: mailbox.path,
      delimiter: mailbox.delimiter != '/' ? mailbox.delimiter : undefined,
    }))
    .filter((mailbox) => typeof mailbox.name === 'string');
  const summaryText = `Mailboxes (${mailboxSummaries.length}) fetched.`;
  const hints: ToolHint[] = [];
  const firstMailbox = mailboxSummaries[0]?.name;
  if (firstMailbox) {
    hints.push({
      tool: 'mail_imap_search_messages',
      arguments: {
        account_id: args.account_id,
        mailbox: firstMailbox,
        limit: 10,
      },
      reason: 'Search the first mailbox to list recent messages.',
    });
  }

  return makeOk(
    summaryText,
    {
      account_id: args.account_id,
      mailboxes: mailboxSummaries,
    },
    hints,
  );
}
