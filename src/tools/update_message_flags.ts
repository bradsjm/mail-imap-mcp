import type { z } from 'zod';

import type { UpdateMessageFlagsInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { decodeMessageId } from '../message-id.js';
import { makeError, makeOk, type ToolHint, type ToolResult, withImapClient } from './runtime.js';

export async function handleUpdateMessageFlags(
  args: z.infer<typeof UpdateMessageFlagsInputSchema>,
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
      description: 'mail_imap_update_message_flags',
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

      const fetched = await client.fetchOne(decoded.uid, { uid: true, flags: true }, { uid: true });
      if (!fetched) {
        return makeError('Message not found.');
      }

      if (args.add_flags) {
        await client.messageFlagsAdd(decoded.uid, args.add_flags, { uid: true });
      }
      if (args.remove_flags) {
        await client.messageFlagsRemove(decoded.uid, args.remove_flags, { uid: true });
      }

      const updated = await client.fetchOne(decoded.uid, { uid: true, flags: true }, { uid: true });
      if (!updated) {
        return makeError('Message not found after updating flags.');
      }

      const summary = `Updated flags for ${args.message_id}.`;
      const hints: ToolHint[] = [
        {
          tool: 'mail_imap_get_message',
          arguments: {
            account_id: args.account_id,
            message_id: args.message_id,
          },
          reason: 'Fetch the updated message details.',
        },
      ];

      return makeOk(
        summary,
        {
          account_id: args.account_id,
          message_id: args.message_id,
          flags: updated.flags ?? [],
        },
        hints,
      );
    } finally {
      lock.release();
    }
  });
}
