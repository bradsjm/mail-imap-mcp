import { htmlToText } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import type { z } from 'zod';

import type { GetMessageInputSchema } from '../contracts.js';
import { encodeMessageId } from '../message-id.js';
import {
  SANITIZE_HTML_POLICY,
  collectAttachmentSummaries,
  collectHeaders,
  formatFlags,
  makeError,
  makeOk,
  nowUtcIso,
  summarizeEnvelope,
  type ToolHint,
  type ToolResult,
  UNTRUSTED_EMAIL_CONTENT_NOTE,
  withImapClient,
} from './runtime.js';
import { truncateText } from '../utils/text.js';
import { parseMailSource } from '../utils/mailparser.js';
import { loadAccountOrError } from '../utils/account.js';
import { decodeMessageIdOrError } from '../utils/message_id.js';
import { openMailboxLock } from '../utils/mailbox.js';

/**
 * Handle the mail_imap_get_message tool call.
 *
 * Retrieves a single email message by its stable identifier and returns
 * parsed headers, body text (and optionally HTML), and attachment summaries.
 * This tool provides a safe, bounded view of email content with options to
 * extract text from PDF attachments.
 *
 * The tool performs the following steps:
 * 1. Validates and decodes the message_id to extract account, mailbox, and UID information
 * 2. Ensures the message_id matches the requested account_id for security
 * 3. Validates that the account is properly configured
 * 4. Establishes an IMAP connection and obtains a read lock on the target mailbox
 * 5. Verifies that the mailbox UIDVALIDITY matches the message_id
 * 6. Fetches message metadata (envelope, flags, structure, internal date)
 * 7. Downloads the message body (bounded by max_bytes to prevent memory issues)
 * 8. Parses the RFC822 source into structured components
 * 9. Sanitizes HTML content and converts to plain text for safety
 * 10. Truncates text content to the requested maximum length
 * 11. Optionally extracts text from PDF attachments (if requested)
 * 12. Collects attachment metadata (filename, content type, size, extracted text)
 * 13. Releases the mailbox lock
 * 14. Returns the parsed message data with security notes
 *
 * @example
 * ```ts
 * const result = await handleGetMessage({
 *   account_id: 'default',
 *   message_id: 'imap:default:INBOX:1234567890:42',
 *   body_max_chars: 2000,
 *   include_headers: true,
 *   include_html: false,
 *   extract_attachment_text: true
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   message: {
 * //     message_id: 'imap:default:INBOX:1234567890:42',
 * //     mailbox: 'INBOX',
 * //     uidvalidity: 1234567890,
 * //     uid: 42,
 * //     date: '2024-01-15T10:30:00.000Z',
 * //     from: 'sender@example.com',
 * //     subject: 'Test email',
 * //     body_text: 'Hello world...',
 * //     attachments: [...]
 * //   }
 * // }
 * ```
 *
 * @param args - The validated input arguments containing account_id, message_id, and formatting options
 * @returns A ToolResult containing the parsed message data or an error message
 */
export async function handleGetMessage(
  args: z.infer<typeof GetMessageInputSchema>,
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
    // Obtain a read lock on the mailbox and validate UIDVALIDITY
    // The expectedUidvalidity ensures we're reading from the same mailbox snapshot
    // that was used to generate the message_id, preventing issues if the mailbox
    // was recreated or otherwise modified
    const lockResult = await openMailboxLock(client, decoded.mailbox, {
      readOnly: true,
      description: 'mail_imap_get_message',
      expectedUidvalidity: decoded.uidvalidity,
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock, uidvalidity } = lockResult;
    try {
      // Fetch message metadata without downloading the full body yet
      // This gives us envelope info, flags, and structure for attachment detection
      const fetched = await client.fetchOne(
        decoded.uid,
        { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
        { uid: true },
      );
      if (!fetched) {
        return makeError('Message not found.');
      }

      // Calculate a safe download limit: take the user's requested maximum,
      // multiply by 4 (for UTF-8 worst case), and cap at 500KB to prevent
      // excessive memory usage from large messages
      const maxBytes = Math.min(args.body_max_chars * 4, 500_000);
      const download = await client.download(decoded.uid, undefined, {
        uid: true,
        maxBytes,
      });
      // Parse the RFC822 source into structured components (headers, body, attachments)
      const parsed = await parseMailSource(download.content);

      // Extract envelope information (from, to, subject, date) into a consistent format
      const envelopeSummary = summarizeEnvelope(fetched.envelope);

      // Process HTML content safely:
      // 1. Check if parsed HTML exists
      // 2. Sanitize it to remove scripts, dangerous tags, and untrusted attributes
      // 3. Convert to plain text as a fallback if no plain text body exists
      const parsedHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
      const bodyHtml = parsedHtml ? sanitizeHtml(parsedHtml, SANITIZE_HTML_POLICY) : undefined;
      const textFromHtml = bodyHtml ? htmlToText(bodyHtml, { wordwrap: false }) : undefined;

      // Use the plain text body if available, otherwise fall back to converted HTML
      const rawText = parsed.text ?? textFromHtml ?? '';

      // Truncate text content to the user's requested maximum
      // This prevents large emails from consuming excessive tokens or output space
      const bodyText = rawText ? truncateText(rawText, args.body_max_chars) : undefined;
      const limitedHtml =
        args.include_html && bodyHtml ? truncateText(bodyHtml, args.body_max_chars) : undefined;

      // Collect headers based on user preferences:
      // - include_all_headers: returns all headers (may be noisy/large)
      // - include_headers (without include_all_headers): returns only critical headers
      let headers: Record<string, string> | undefined;
      if (args.include_headers || args.include_all_headers) {
        headers = collectHeaders(parsed.headers, {
          include_all_headers: args.include_all_headers,
        });
      }

      // Collect attachment metadata from the message structure
      // If extract_attachment_text is enabled, we'll also download and parse PDFs
      const attachments: Array<{
        filename?: string;
        content_type: string;
        size_bytes: number;
        part_id: string;
        extracted_text?: string;
      }> = [];
      await collectAttachmentSummaries(
        fetched.bodyStructure,
        attachments,
        client,
        decoded.uid,
        args.extract_attachment_text,
        args.attachment_text_max_chars,
        50,
      );

      // Re-encode the message ID with the current mailbox state
      // This ensures the returned ID reflects the actual UIDVALIDITY we used
      const messageId = encodeMessageId({
        account_id: args.account_id,
        mailbox: decoded.mailbox,
        uidvalidity,
        uid: decoded.uid,
      });

      // Build a human-readable summary with the most important message information
      // This gives users a quick overview without needing to parse the full JSON
      const summaryText = [
        `Message ${messageId}`,
        `Date: ${envelopeSummary.date}`,
        envelopeSummary.from ? `From: ${envelopeSummary.from}` : 'From: (unknown sender)',
        envelopeSummary.subject ? `Subject: ${envelopeSummary.subject}` : 'Subject: (none)',
        bodyText ? `Body snippet: ${truncateText(bodyText, 240)}` : 'Body snippet: (none)',
      ].join('\n');

      // Provide actionable hints to guide the user's next steps
      const hints: ToolHint[] = [];
      hints.push({
        tool: 'mail_imap_search_messages',
        arguments: {
          account_id: args.account_id,
          mailbox: decoded.mailbox,
          limit: 10,
        },
        reason: 'Return to the mailbox list of messages.',
      });

      // Return the successful result with structured data, hints, and metadata
      // The metadata includes a security note warning users about untrusted email content
      return makeOk(
        summaryText,
        {
          account_id: args.account_id,
          message: {
            message_id: messageId,
            mailbox: decoded.mailbox,
            uidvalidity,
            uid: decoded.uid,
            date: envelopeSummary.date,
            from: envelopeSummary.from,
            to: envelopeSummary.to,
            cc: envelopeSummary.cc,
            subject: envelopeSummary.subject,
            flags: formatFlags(fetched.flags),
            headers,
            body_text: bodyText,
            body_html: args.include_html ? limitedHtml : undefined,
            attachments,
          },
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
