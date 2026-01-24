import type { z } from 'zod';

import type { GetMessageRawInputSchema } from '../contracts.js';
import {
  makeError,
  makeOk,
  nowUtcIso,
  type ToolHint,
  type ToolResult,
  UNTRUSTED_EMAIL_CONTENT_NOTE,
  withImapClient,
} from './runtime.js';
import { loadAccountOrError } from '../utils/account.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import { openMailboxLock } from '../utils/mailbox.js';

/**
 * Handle the mail_imap_get_message_raw tool call.
 *
 * Retrieves the raw RFC822 source of an email message. This is the complete,
 * unparsed message as received from the mail server, including all headers,
 * body content, attachments, and MIME structure.
 *
 * The tool performs the following steps:
 * 1. Validates and decodes the message_id to extract account, mailbox, and UID information
 * 2. Ensures the message_id matches the requested account_id for security
 * 3. Validates that the account is properly configured
 * 4. Establishes an IMAP connection and obtains a read lock on the target mailbox
 * 5. Verifies that the mailbox UIDVALIDITY matches the message_id
 * 6. Downloads the message content up to the max_bytes limit
 * 7. Converts the downloaded chunks to a UTF-8 string
 * 8. Releases the mailbox lock
 * 9. Returns the raw source with a size count and security warnings
 *
 * Note: This returns the raw email content which may contain untrusted HTML,
 * scripts, or other potentially malicious content. The content is not sanitized
 * and should be treated with caution. Use the get_message tool for a safe,
 * parsed view of email content.
 *
 * @example
 * ```ts
 * const result = await handleGetMessageRaw({
 *   account_id: 'default',
 *   message_id: 'imap:default:INBOX:1234567890:42',
 *   max_bytes: 200000
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   message_id: 'imap:default:INBOX:1234567890:42',
 * //   size_bytes: 15432,
 * //   raw_source: 'From: sender@example.com\nTo: recipient@example.com\n...'
 * // }
 * ```
 *
 * @param args - The validated input arguments containing account_id, message_id, and max_bytes limit
 * @returns A ToolResult containing the raw message source or an error message
 */
export async function handleGetMessageRaw(
  args: z.infer<typeof GetMessageRawInputSchema>,
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
    // Obtain a read lock on the mailbox and validate UIDVALIDITY
    // The expectedUidvalidity ensures we're reading from the same mailbox snapshot
    // that was used to generate the message_id, preventing issues if the mailbox
    // was recreated or otherwise modified
    const lockResult = await openMailboxLock(client, decoded.mailbox, {
      readOnly: true,
      description: 'mail_imap_get_message_raw',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock } = lockResult;
    try {
      // Download the raw message source, limited by max_bytes
      // The max_bytes parameter prevents excessive memory usage from large messages
      const download = await client.download(decoded.uid, undefined, {
        uid: true,
        maxBytes: args.max_bytes,
      });

      // Accumulate downloaded chunks into a single buffer
      // We track the total size to enforce the max_bytes limit
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of download.content) {
        // Ensure we're working with a Buffer (chunks may be Uint8Array)
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;

        // Enforce the size limit during download to prevent memory issues
        if (total > args.max_bytes) {
          return makeError(
            `Raw message exceeds max_bytes (${args.max_bytes}). Increase max_bytes to retrieve more.`,
          );
        }
        chunks.push(buffer);
      }

      // Concatenate all chunks and convert to UTF-8 string
      const rawSource = Buffer.concat(chunks).toString('utf8');

      // Provide a clear summary including the actual size retrieved
      const summary = `Fetched raw message ${args.message_id} (${total} bytes).`;

      // Suggest using get_message for a safer, parsed view of the content
      // Raw email content can be difficult to work with and may contain untrusted HTML/scripts
      const hints: ToolHint[] = [
        {
          tool: 'mail_imap_get_message',
          arguments: {
            account_id: args.account_id,
            message_id: args.message_id,
          },
          reason: 'Fetch the parsed message body and headers instead of raw source.',
        },
      ];

      // Return the successful result with structured data, hints, and metadata
      // The metadata includes a security note warning users about untrusted email content
      return makeOk(
        summary,
        {
          account_id: args.account_id,
          message_id: args.message_id,
          size_bytes: total,
          raw_source: rawSource,
        },
        hints,
        {
          now_utc: nowUtcIso(),
          read_side_effects: 'none',
          security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
        },
      );
    } finally {
      // Always release the lock, even if an error occurred
      // This prevents deadlock and allows other operations to proceed
      lock.release();
    }
  });
}
