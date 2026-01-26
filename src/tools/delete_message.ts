import type { z } from 'zod';

import type { DeleteMessageInputSchema } from '../contracts.js';
import { makeError, makeOk, type ToolHint, type ToolResult, withImapClient } from './runtime.js';
import { loadAccountOrError } from '../utils/account.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import { openMailboxLock } from '../utils/mailbox.js';

/**
 * Handle the imap_delete_message tool call.
 *
 * Permanently deletes a specific message from an IMAP mailbox. This operation
 * is destructive and requires explicit confirmation via the confirm=true
 * parameter to prevent accidental deletions.
 *
 * The tool performs the following steps:
 * 1. Validates and decodes the message_id to extract account, mailbox, and UID information
 * 2. Ensures the message_id matches the requested account_id for security
 * 3. Validates that the account is properly configured
 * 4. Establishes an IMAP connection and obtains a write lock on the target mailbox
 * 5. Verifies that the mailbox UIDVALIDITY matches the message_id (prevents operations on changed mailboxes)
 * 6. Deletes the message using the IMAP DELETE command
 * 7. Releases the mailbox lock
 * 8. Returns confirmation and suggests reviewing remaining messages
 *
 * Note: This is a destructive operation. Once deleted, messages cannot be recovered
 * unless the IMAP server has a trash/backup mechanism.
 *
 * @example
 * ```ts
 * const result = await handleDeleteMessage({
 *   account_id: 'default',
 *   message_id: 'imap:default:INBOX:1234567890:42',
 *   confirm: true
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   mailbox: 'INBOX',
 * //   message_id: 'imap:default:INBOX:1234567890:42'
 * // }
 * ```
 *
 * @param args - The validated input arguments containing account_id, message_id, and confirm flag
 * @returns A ToolResult containing deletion confirmation or an error message
 */
export async function handleDeleteMessage(
  args: z.infer<typeof DeleteMessageInputSchema>,
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
      description: 'imap_delete_message',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock } = lockResult;
    try {
      // Perform the delete operation using the IMAP DELETE command with UID mode
      // UID mode ensures we're deleting the specific message regardless of its
      // current sequence number
      const deleted = await client.messageDelete(decoded.uid, { uid: true });
      if (!deleted) {
        return makeError('Delete failed for this message.');
      }

      // Provide a clear confirmation that the deletion was successful
      const summary = `Deleted message ${args.message_id}.`;

      // Suggest reviewing remaining messages to help the user understand
      // the impact of the deletion and decide on next actions
      const hints: ToolHint[] = [
        {
          tool: 'imap_search_messages',
          arguments: {
            account_id: args.account_id,
            mailbox: decoded.mailbox,
            limit: 10,
          },
          reason: 'Review remaining messages in the mailbox.',
        },
      ];

      // Return the deletion confirmation with structured data
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
      // Always release the lock, even if an error occurred
      // This prevents deadlock and allows other operations to proceed
      lock.release();
    }
  });
}
