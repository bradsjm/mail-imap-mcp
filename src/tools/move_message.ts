import type { z } from 'zod';

import type { MoveMessageInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { decodeMessageId, encodeMessageId } from '../message-id.js';
import {
  hasCapability,
  makeError,
  makeOk,
  type ToolHint,
  type ToolResult,
  withImapClient,
} from './runtime.js';

export async function handleMoveMessage(
  args: z.infer<typeof MoveMessageInputSchema>,
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
      description: 'mail_imap_move_message',
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

      const supportsMove = hasCapability(client, 'MOVE');
      const supportsUidplus = hasCapability(client, 'UIDPLUS');
      let moveResult: { uidMap?: Map<number, number>; uidValidity?: bigint } | false;

      if (supportsMove) {
        moveResult = await client.messageMove(decoded.uid, args.destination_mailbox, {
          uid: true,
        });
      } else {
        moveResult = await client.messageCopy(decoded.uid, args.destination_mailbox, {
          uid: true,
        });
        if (moveResult) {
          const deleted = await client.messageDelete(decoded.uid, { uid: true });
          if (!deleted) {
            return makeError('Move fallback failed: copy succeeded but delete failed.', [], {
              move_strategy: 'copy+delete',
              copy_completed: true,
            });
          }
        }
      }

      if (!moveResult) {
        return makeError('Move failed for this message.', [], {
          move_strategy: supportsMove ? 'move' : 'copy+delete',
        });
      }

      let newMessageId: string | undefined;
      if (supportsUidplus) {
        const newUid = moveResult.uidMap?.get(decoded.uid);
        const newUidvalidity = moveResult.uidValidity ?? undefined;
        if (newUid !== undefined && newUidvalidity !== undefined) {
          newMessageId = encodeMessageId({
            account_id: args.account_id,
            mailbox: args.destination_mailbox,
            uidvalidity: Number(newUidvalidity),
            uid: newUid,
          });
        }
      }

      const summary = `Moved message ${args.message_id} to ${args.destination_mailbox}.`;
      const hints: ToolHint[] = [];
      if (newMessageId) {
        hints.push({
          tool: 'mail_imap_get_message',
          arguments: {
            account_id: args.account_id,
            message_id: newMessageId,
          },
          reason: 'Fetch the moved message in its new mailbox.',
        });
      }

      return makeOk(
        summary,
        {
          account_id: args.account_id,
          source_mailbox: decoded.mailbox,
          destination_mailbox: args.destination_mailbox,
          message_id: args.message_id,
          new_message_id: newMessageId,
        },
        hints,
        {
          move_strategy: supportsMove ? 'move' : 'copy+delete',
          uidplus: supportsUidplus,
        },
      );
    } finally {
      lock.release();
    }
  });
}
