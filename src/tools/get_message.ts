import { htmlToText } from 'html-to-text';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import type { z } from 'zod';

import type { GetMessageInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { decodeMessageId, encodeMessageId } from '../message-id.js';
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
import { truncateText } from './text.js';

const parseMailSource = simpleParser as unknown as (
  source: NodeJS.ReadableStream | Buffer,
) => Promise<ParsedMail>;

export async function handleGetMessage(
  args: z.infer<typeof GetMessageInputSchema>,
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
      readOnly: true,
      description: 'mail_imap_get_message',
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

      const fetched = await client.fetchOne(
        decoded.uid,
        { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
        { uid: true },
      );
      if (!fetched) {
        return makeError('Message not found.');
      }

      const maxBytes = Math.min(args.body_max_chars * 4, 500_000);
      const download = await client.download(decoded.uid, undefined, {
        uid: true,
        maxBytes,
      });
      const parsed = await parseMailSource(download.content);

      const envelopeSummary = summarizeEnvelope(fetched.envelope);
      const parsedHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
      const bodyHtml = parsedHtml ? sanitizeHtml(parsedHtml, SANITIZE_HTML_POLICY) : undefined;
      const textFromHtml = bodyHtml ? htmlToText(bodyHtml, { wordwrap: false }) : undefined;
      const rawText = parsed.text ?? textFromHtml ?? '';

      const bodyText = rawText ? truncateText(rawText, args.body_max_chars) : undefined;
      const limitedHtml =
        args.include_html && bodyHtml ? truncateText(bodyHtml, args.body_max_chars) : undefined;

      let headers: Record<string, string> | undefined;
      if (args.include_headers || args.include_all_headers) {
        headers = collectHeaders(parsed.headers, {
          include_all_headers: args.include_all_headers,
        });
      }

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
      );

      const messageId = encodeMessageId({
        account_id: args.account_id,
        mailbox: decoded.mailbox,
        uidvalidity,
        uid: decoded.uid,
      });

      const summaryText = [
        `Message ${messageId}`,
        `Date: ${envelopeSummary.date}`,
        envelopeSummary.from ? `From: ${envelopeSummary.from}` : 'From: (unknown sender)',
        envelopeSummary.subject ? `Subject: ${envelopeSummary.subject}` : 'Subject: (none)',
        bodyText ? `Body snippet: ${truncateText(bodyText, 240)}` : 'Body snippet: (none)',
      ].join('\n');

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
      lock.release();
    }
  });
}
