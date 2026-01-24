import type { z } from 'zod';

import type { MoveMessageInputSchema } from '../contracts.js';
import { encodeMessageId } from '../message-id.js';
import {
  hasCapability,
  makeError,
  makeOk,
  type ToolHint,
  type ToolResult,
  withImapClient,
} from './runtime.js';
import { loadAccountOrError } from '../utils/account.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import { openMailboxLock } from '../utils/mailbox.js';

/**
 * Handle the mail_imap_move_message tool call.
 *
 * Moves a message from one mailbox to another. This operation removes the message
 * from its original mailbox and places it in the destination mailbox. The tool
 * automatically chooses the best strategy based on server capabilities:
 * - If the server supports the MOVE command (RFC 6851), it uses that
 * - Otherwise, it falls back to COPY + DELETE (traditional method)
 *
 * The tool performs the following steps:
 * 1. Validates and decodes the message_id to extract account, mailbox, and UID information
 * 2. Ensures the message_id matches the requested account_id for security
 * 3. Validates that the account is properly configured
 * 4. Establishes an IMAP connection and obtains a write lock on the source mailbox
 * 5. Verifies that the mailbox UIDVALIDITY matches the message_id
 * 6. Detects server capabilities (MOVE and UIDPLUS support)
 * 7. Attempts to move the message using the best available method
 * 8. If UIDPLUS is supported, generates a new message_id for the moved message
 * 9. Releases the mailbox lock
 * 10. Returns confirmation with the new message_id (if available)
 *
 * @example
 * ```ts
 * const result = await handleMoveMessage({
 *   account_id: 'default',
 *   message_id: 'imap:default:INBOX:1234567890:42',
 *   destination_mailbox: 'Archive'
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   source_mailbox: 'INBOX',
 * //   destination_mailbox: 'Archive',
 * //   message_id: 'imap:default:INBOX:1234567890:42',
 * //   new_message_id: 'imap:default:Archive:1234567891:123' // if UIDPLUS supported
 * // }
 * ```
 *
 * @param args - The validated input arguments containing account_id, message_id, and destination_mailbox
 * @returns A ToolResult containing the move confirmation or an error message
 */
export async function handleMoveMessage(
  args: z.infer<typeof MoveMessageInputSchema>,
): Promise<ToolResult> {
  const decodedResult = decodeMessageIdOrError(args.message_id, args.account_id);
  if ('error' in decodedResult) {
    return makeError(decodedResult.error);
  }

  const accountResult = loadAccountOrError(args.account_id);
  if ('error' in accountResult) {
    return makeError(accountResult.error);
  }
  const decoded = decodedResult.decoded;
  const account = accountResult.account;

  return await withImapClient(account, async (client) => {
    // Obtain a write lock on the mailbox and validate UIDVALIDITY
    // The expectedUidvalidity ensures we're operating on the same mailbox snapshot
    // that was used to generate the message_id, preventing issues if the mailbox
    // was recreated or otherwise modified
    const lockResult = await openMailboxLock(client, decoded.mailbox, {
      readOnly: false,
      description: 'mail_imap_move_message',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock } = lockResult;
    try {
      // Check server capabilities to determine the best move strategy
      // MOVE (RFC 6851) is more efficient but not all servers support it
      // UIDPLUS (RFC 4315) allows us to determine the new message UID after moving
      const supportsMove = hasCapability(client, 'MOVE');
      const supportsUidplus = hasCapability(client, 'UIDPLUS');
      let moveResult: { uidMap?: Map<number, number>; uidValidity?: bigint } | false;

      // Prefer the MOVE command if available (more efficient, single operation)
      if (supportsMove) {
        moveResult = await client.messageMove(decoded.uid, args.destination_mailbox, {
          uid: true,
        });
      } else {
        // Fallback to COPY + DELETE if MOVE is not supported
        // This is a two-step process: copy to destination, then delete from source
        // If the delete fails, we've already duplicated the message, which is problematic
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

      // Check if the move operation succeeded
      // Both MOVE and COPY return a result object; DELETE returns a boolean
      if (!moveResult) {
        return makeError('Move failed for this message.', [], {
          // Include metadata about the move strategy for debugging and transparency
          // This helps users understand what happened if issues arise
          move_strategy: supportsMove ? 'move' : 'copy+delete',
        });
      }

      // Generate a new message_id for the moved message if UIDPLUS is supported
      // UIDPLUS provides the mapping from old UIDs to new UIDs, allowing us to
      // create a stable identifier for the message in its new location
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

      // Provide a clear confirmation of the move operation
      const summary = `Moved message ${args.message_id} to ${args.destination_mailbox}.`;
      // Suggest fetching the moved message if we have its new identifier
      // This allows users to verify the move succeeded and see the message in its new location
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
      // Always release the lock, even if an error occurred
      // This prevents deadlock and allows other operations to proceed
      lock.release();
    }
  });
}
