import type { z } from 'zod';

import type { UpdateMessageFlagsInputSchema } from '../contracts.js';
import { makeError, makeOk, type ToolHint, type ToolResult, withImapClient } from './runtime.js';
import { loadAccountOrError } from '../utils/account.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import { openMailboxLock } from '../utils/mailbox.js';

/**
 * Handle the mail_imap_update_message_flags tool call.
 *
 * Updates IMAP message flags (also known as labels or tags) on a specific message.
 * Common flags include \Seen (read/unread), \Flagged, \Answered, \Deleted, and user-defined
 * flags. This operation is useful for managing email workflow (marking as read, flagging for follow-up, etc.).
 *
 * The tool performs the following steps:
 * 1. Validates and decodes the message_id to extract account, mailbox, and UID information
 * 2. Ensures the message_id matches the requested account_id for security
 * 3. Validates that the account is properly configured
 * 4. Establishes an IMAP connection and obtains a write lock on the target mailbox
 * 5. Verifies that the mailbox UIDVALIDITY matches the message_id
 * 6. Fetches the current message flags to verify the message exists
 * 7. Adds any flags specified in add_flags (if they're not already set)
 * 8. Removes any flags specified in remove_flags (if they're currently set)
 * 9. Fetches the updated flags to return to the caller
 * 10. Releases the mailbox lock
 * 11. Returns the updated flags and suggests fetching the full message details
 *
 * @example
 * ```ts
 * const result = await handleUpdateMessageFlags({
 *   account_id: 'default',
 *   message_id: 'imap:default:INBOX:1234567890:42',
 *   add_flags: ['\\Seen', '\\Flagged'],
 *   remove_flags: ['\\Draft']
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   message_id: 'imap:default:INBOX:1234567890:42',
 * //   flags: ['\\Seen', '\\Flagged', '\\Recent']
 * // }
 * ```
 *
 * @param args - The validated input arguments containing account_id, message_id, add_flags, and remove_flags
 * @returns A ToolResult containing the updated message flags or an error message
 */
export async function handleUpdateMessageFlags(
  args: z.infer<typeof UpdateMessageFlagsInputSchema>,
): Promise<ToolResult> {
  // Validate and decode the message_id, ensuring it matches the requested account
  const decodedResult = decodeMessageIdOrError(args.message_id, args.account_id);
  if ('error' in decodedResult) {
    return makeError(decodedResult.error);
  }

  // Validate that the account is configured before attempting to connect
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
      description: 'mail_imap_update_message_flags',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock } = lockResult;
    try {
      // Fetch the current message flags to verify the message exists
      // We also need the current flags to ensure we don't duplicate add operations
      const fetched = await client.fetchOne(decoded.uid, { uid: true, flags: true }, { uid: true });
      if (!fetched) {
        return makeError('Message not found.');
      }

      // Add any flags specified in add_flags
      // The IMAP server will handle duplicates (no error if flag already set)
      if (args.add_flags) {
        await client.messageFlagsAdd(decoded.uid, args.add_flags, { uid: true });
      }
      // Remove any flags specified in remove_flags
      // The IMAP server will handle missing flags (no error if flag not set)
      if (args.remove_flags) {
        await client.messageFlagsRemove(decoded.uid, args.remove_flags, { uid: true });
      }

      // Fetch the updated flags to return to the caller
      // This ensures we return the actual state after the operations completed
      const updated = await client.fetchOne(decoded.uid, { uid: true, flags: true }, { uid: true });
      if (!updated) {
        return makeError('Message not found after updating flags.');
      }

      // Provide a clear confirmation that the flags were updated
      const summary = `Updated flags for ${args.message_id}.`;

      // Suggest fetching the full message details to see the impact of the flag changes
      // This helps users verify the update and understand the message's current state
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
      // Always release the lock, even if an error occurred
      // This prevents deadlock and allows other operations to proceed
      lock.release();
    }
  });
}
