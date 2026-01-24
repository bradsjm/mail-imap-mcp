import type { z } from 'zod';

import type { DeleteMessageInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { decodeMessageId } from '../message-id.js';
import { makeError, makeOk, type ToolHint, type ToolResult, withImapClient } from './runtime.js';

export async function handleDeleteMessage(
  args: z.infer<typeof DeleteMessageInputSchema>,
): Promise<ToolResult> {
  const decoded = decodeMessageId(args.message_id);
  if (!decoded) {
    return makeError(
      "Invalid message_id. Expected 'imap:{account_id}:{mailbox}:{uidvalidity}:{uid}'.",
    );
  }
  if (decoded.account_id !== args.account_id) {
    return makeError('message_id does not match the requested account_id.');
  }

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

  return await withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(decoded.mailbox, {
      readOnly: false,
      description: 'mail_imap_delete_message',
    });
    try {
      const mailboxInfo = client.mailbox;
      if (!mailboxInfo) {
        return makeError('Mailbox could not be opened.');
      }
      const uidvalidity = Number(mailboxInfo.uidValidity ?? 0n);
      if (uidvalidity !== decoded.uidvalidity) {
        return makeError(
          `message_id uidvalidity mismatch (expected ${decoded.uidvalidity}, mailbox ${uidvalidity}).`,
        );
      }

      const deleted = await client.messageDelete(decoded.uid, { uid: true });
      if (!deleted) {
        return makeError('Delete failed for this message.');
      }

      const summary = `Deleted message ${args.message_id}.`;
      const hints: ToolHint[] = [
        {
          tool: 'mail_imap_search_messages',
          arguments: {
            account_id: args.account_id,
            mailbox: decoded.mailbox,
            limit: 10,
          },
          reason: 'Review remaining messages in the mailbox.',
        },
      ];

      return makeOk(
        summary,
        {
          account_id: args.account_id,
          mailbox: decoded.mailbox,
          message_id: args.message_id,
        },
        hints,
      );
    } finally {
      lock.release();
    }
  });
}
