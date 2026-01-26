import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { htmlToText } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import type { ImapFlow } from 'imapflow';

import type { AccountConfig } from '../config.js';
import { loadAccountOrError } from '../utils/account.js';
import { openMailboxLock } from '../utils/mailbox.js';
import { parseMailSource } from '../utils/mailparser.js';
import { truncateText } from '../utils/text.js';
import { collectAttachmentSummaries } from '../utils/attachments.js';
import { extractTextFromPdf } from '../utils/pdf.js';
import {
  SANITIZE_HTML_POLICY,
  summarizeEnvelope,
  formatFlags,
  collectHeaders,
  mapImapError,
  nowUtcIso,
  UNTRUSTED_EMAIL_CONTENT_NOTE,
  withImapClient,
} from '../tools/runtime.js';
import {
  attachmentResourceUri,
  attachmentTextResourceUri,
  decodeMailboxSegment,
  messageRawResourceUri,
  messageResourceUri,
  type AttachmentLocator,
  type MessageLocator,
} from './uri.js';

const DEFAULT_MESSAGE_BODY_MAX_CHARS = 2000;
const DEFAULT_MESSAGE_RAW_MAX_BYTES = 200_000;
const DEFAULT_ATTACHMENT_TEXT_MAX_CHARS = 10_000;

// Base64 encoding overhead + token bloat can get painful quickly; keep a tight default.
const DEFAULT_ATTACHMENT_BLOB_MAX_BYTES = 2_000_000;
const HARD_ATTACHMENT_BLOB_MAX_BYTES = 5_000_000;

type AsyncIterableLike = {
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const maybe = value as Partial<AsyncIterableLike>;
  return typeof maybe[Symbol.asyncIterator] === 'function';
}

async function bufferFromDownloadContent(content: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }
  // imapflow download may return an async iterable stream
  if (isAsyncIterable(content)) {
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        // Best-effort fallback for odd stream chunk types; avoid stringifying plain objects.
        chunks.push(
          typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean'
            ? Buffer.from(String(chunk))
            : Buffer.from(''),
        );
      }
    }
    return Buffer.concat(chunks);
  }
  if (content === null || content === undefined) {
    return Buffer.from('');
  }
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    return Buffer.from(String(content));
  }
  // Avoid default object stringification ("[object Object]").
  return Buffer.from('');
}

function parseNumberOrThrow(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${name}.`);
  }
  return n;
}

function getTemplateVar(
  variables: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = variables[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  throw new McpError(ErrorCode.InvalidParams, `Missing ${name}.`);
}

function loadAccountOrThrow(account_id: string): AccountConfig {
  const result = loadAccountOrError(account_id);
  if ('error' in result) {
    throw new McpError(ErrorCode.InvalidParams, result.error);
  }
  return result.account;
}

async function withMailboxReadLock<T>(
  account: AccountConfig,
  mailbox: string,
  uidvalidity: number,
  fn: (args: { client: ImapFlow; uidvalidity: number }) => Promise<T>,
): Promise<T> {
  return await withImapClient(account, async (client) => {
    const lockResult = await openMailboxLock(client, mailbox, {
      readOnly: true,
      description: 'resources/read',
      expectedUidvalidity: uidvalidity,
    });
    if ('error' in lockResult) {
      throw new McpError(ErrorCode.InvalidParams, lockResult.error);
    }
    const { lock, uidvalidity: currentUidvalidity } = lockResult;
    try {
      return await fn({ client, uidvalidity: currentUidvalidity });
    } finally {
      lock.release();
    }
  });
}

export function registerImapResources(server: McpServer): void {
  // Message (parsed) resource
  server.registerResource(
    'imap_message',
    new ResourceTemplate('imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}', {
      list: undefined,
    }),
    {
      title: 'IMAP Message',
      description:
        'Read-only view of a single message (parsed, sanitized, token-bounded). Use tools for richer options.',
    },
    async (uri, variables) => {
      const account_id = getTemplateVar(variables, 'account_id');
      const mailbox = decodeMailboxSegment(getTemplateVar(variables, 'mailbox'));
      const uidvalidity = parseNumberOrThrow(
        getTemplateVar(variables, 'uidvalidity'),
        'uidvalidity',
      );
      const uid = parseNumberOrThrow(getTemplateVar(variables, 'uid'), 'uid');

      const account = loadAccountOrThrow(account_id);

      try {
        const locator: MessageLocator = { account_id, mailbox, uidvalidity, uid };
        const result = await withMailboxReadLock(
          account,
          mailbox,
          uidvalidity,
          async ({ client }) => {
            const fetched = await client.fetchOne(
              uid,
              { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
              { uid: true },
            );
            if (!fetched) {
              throw new McpError(ErrorCode.InvalidParams, 'Message not found.');
            }

            const maxBytes = Math.min(DEFAULT_MESSAGE_BODY_MAX_CHARS * 4, 500_000);
            const download = await client.download(uid, undefined, { uid: true, maxBytes });
            const parsed = await parseMailSource(download.content);

            const envelopeSummary = summarizeEnvelope(fetched.envelope);
            const parsedHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
            const bodyHtml = parsedHtml
              ? sanitizeHtml(parsedHtml, SANITIZE_HTML_POLICY)
              : undefined;
            const textFromHtml = bodyHtml ? htmlToText(bodyHtml, { wordwrap: false }) : undefined;
            const rawText = parsed.text ?? textFromHtml ?? '';
            const bodyText = rawText
              ? truncateText(rawText, DEFAULT_MESSAGE_BODY_MAX_CHARS)
              : undefined;

            const headers = collectHeaders(parsed.headers, { include_all_headers: false });

            const attachments: Array<{
              filename?: string;
              content_type: string;
              size_bytes: number;
              part_id: string;
              attachment_uri: string;
              attachment_text_uri: string;
            }> = [];

            const summaries: Array<{
              filename?: string;
              content_type: string;
              size_bytes: number;
              part_id: string;
            }> = [];
            await collectAttachmentSummaries(
              fetched.bodyStructure,
              summaries,
              null,
              0,
              false,
              0,
              50,
            );
            for (const s of summaries) {
              const a: AttachmentLocator = { ...locator, part_id: s.part_id };
              attachments.push({
                ...s,
                attachment_uri: attachmentResourceUri(a),
                attachment_text_uri: attachmentTextResourceUri(a),
              });
            }

            return {
              account_id,
              message: {
                message_uri: messageResourceUri(locator),
                message_raw_uri: messageRawResourceUri(locator),
                mailbox,
                uidvalidity,
                uid,
                date: envelopeSummary.date,
                from: envelopeSummary.from,
                to: envelopeSummary.to,
                cc: envelopeSummary.cc,
                subject: envelopeSummary.subject,
                flags: formatFlags(fetched.flags),
                headers,
                body_text: bodyText,
                attachments,
              },
              _meta: {
                now_utc: nowUtcIso(),
                read_side_effects: 'none',
                security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
              },
            };
          },
        );

        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'application/json',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const mapped = mapImapError(error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, mapped.message);
      }
    },
  );

  // Message raw (RFC822) resource
  server.registerResource(
    'imap_message_raw',
    new ResourceTemplate('imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/raw', {
      list: undefined,
    }),
    {
      title: 'IMAP Message Raw',
      description: 'Read-only raw RFC822 source (truncated). Prefer tools for larger reads.',
      mimeType: 'message/rfc822',
    },
    async (uri, variables) => {
      const account_id = getTemplateVar(variables, 'account_id');
      const mailbox = decodeMailboxSegment(getTemplateVar(variables, 'mailbox'));
      const uidvalidity = parseNumberOrThrow(
        getTemplateVar(variables, 'uidvalidity'),
        'uidvalidity',
      );
      const uid = parseNumberOrThrow(getTemplateVar(variables, 'uid'), 'uid');

      const account = loadAccountOrThrow(account_id);

      try {
        const result = await withMailboxReadLock(
          account,
          mailbox,
          uidvalidity,
          async ({ client }) => {
            const download = await client.download(uid, undefined, {
              uid: true,
              maxBytes: DEFAULT_MESSAGE_RAW_MAX_BYTES,
            });
            const raw = await bufferFromDownloadContent(download.content);
            return { size_bytes: raw.byteLength, raw_source: raw.toString('utf8') };
          },
        );

        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'message/rfc822',
              text: result.raw_source,
              _meta: {
                account_id,
                mailbox,
                uidvalidity,
                uid,
                size_bytes: result.size_bytes,
                now_utc: nowUtcIso(),
                read_side_effects: 'none',
                security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
                truncated_to_bytes: DEFAULT_MESSAGE_RAW_MAX_BYTES,
              },
            },
          ],
        };
      } catch (error: unknown) {
        const mapped = mapImapError(error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, mapped.message);
      }
    },
  );

  // Attachment bytes as blob
  server.registerResource(
    'imap_attachment',
    new ResourceTemplate(
      'imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/attachment/{part_id}',
      { list: undefined },
    ),
    {
      title: 'IMAP Attachment',
      description:
        'Read-only attachment bytes (base64 blob) with a conservative size cap. For text extraction, use the /text sub-resource.',
    },
    async (uri, variables) => {
      const account_id = getTemplateVar(variables, 'account_id');
      const mailbox = decodeMailboxSegment(getTemplateVar(variables, 'mailbox'));
      const uidvalidity = parseNumberOrThrow(
        getTemplateVar(variables, 'uidvalidity'),
        'uidvalidity',
      );
      const uid = parseNumberOrThrow(getTemplateVar(variables, 'uid'), 'uid');
      const part_id = decodeURIComponent(getTemplateVar(variables, 'part_id'));

      const account = loadAccountOrThrow(account_id);

      try {
        const result = await withMailboxReadLock(
          account,
          mailbox,
          uidvalidity,
          async ({ client }) => {
            const fetched = await client.fetchOne(
              uid,
              { uid: true, bodyStructure: true },
              { uid: true },
            );
            if (!fetched) {
              throw new McpError(ErrorCode.InvalidParams, 'Message not found.');
            }

            // Best-effort size guard using the structure, then enforce maxBytes on download.
            const summaries: Array<{
              filename?: string;
              content_type: string;
              size_bytes: number;
              part_id: string;
            }> = [];
            await collectAttachmentSummaries(
              fetched.bodyStructure,
              summaries,
              null,
              0,
              false,
              0,
              200,
            );
            const meta = summaries.find((s) => s.part_id === part_id);
            if (!meta) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Attachment not found (unknown part_id).',
              );
            }
            const cap = Math.min(DEFAULT_ATTACHMENT_BLOB_MAX_BYTES, HARD_ATTACHMENT_BLOB_MAX_BYTES);
            if (meta.size_bytes > cap) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Attachment is ${meta.size_bytes} bytes which exceeds the ${cap} byte resource limit.`,
              );
            }

            const download = await client.download(uid, part_id, { uid: true, maxBytes: cap });
            const buffer = await bufferFromDownloadContent(download.content);

            return {
              mimeType: meta.content_type,
              filename: meta.filename,
              size_bytes: buffer.byteLength,
              blob_base64: buffer.toString('base64'),
            };
          },
        );

        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: result.mimeType,
              blob: result.blob_base64,
              _meta: {
                filename: result.filename,
                size_bytes: result.size_bytes,
                now_utc: nowUtcIso(),
                read_side_effects: 'none',
                security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
              },
            },
          ],
        };
      } catch (error: unknown) {
        const mapped = mapImapError(error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, mapped.message);
      }
    },
  );

  // Attachment text extraction
  server.registerResource(
    'imap_attachment_text',
    new ResourceTemplate(
      'imap://{account_id}/mailbox/{mailbox}/message/{uidvalidity}/{uid}/attachment/{part_id}/text',
      { list: undefined },
    ),
    {
      title: 'IMAP Attachment Text',
      description:
        'Read-only text extraction for text/* attachments and PDFs (bounded). For raw bytes, use the attachment resource.',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const account_id = getTemplateVar(variables, 'account_id');
      const mailbox = decodeMailboxSegment(getTemplateVar(variables, 'mailbox'));
      const uidvalidity = parseNumberOrThrow(
        getTemplateVar(variables, 'uidvalidity'),
        'uidvalidity',
      );
      const uid = parseNumberOrThrow(getTemplateVar(variables, 'uid'), 'uid');
      const part_id = decodeURIComponent(getTemplateVar(variables, 'part_id'));

      const account = loadAccountOrThrow(account_id);

      try {
        const result = await withMailboxReadLock(
          account,
          mailbox,
          uidvalidity,
          async ({ client }) => {
            const fetched = await client.fetchOne(
              uid,
              { uid: true, bodyStructure: true },
              { uid: true },
            );
            if (!fetched) {
              throw new McpError(ErrorCode.InvalidParams, 'Message not found.');
            }

            const summaries: Array<{
              filename?: string;
              content_type: string;
              size_bytes: number;
              part_id: string;
            }> = [];
            await collectAttachmentSummaries(
              fetched.bodyStructure,
              summaries,
              null,
              0,
              false,
              0,
              200,
            );
            const meta = summaries.find((s) => s.part_id === part_id);
            if (!meta) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Attachment not found (unknown part_id).',
              );
            }

            if (!meta.content_type.startsWith('text/') && meta.content_type !== 'application/pdf') {
              return {
                content_type: meta.content_type,
                filename: meta.filename,
                size_bytes: meta.size_bytes,
                extracted_text: `Attachment content-type ${meta.content_type} is not supported for text extraction. Use the blob attachment resource instead.`,
              };
            }

            const maxBytes = Math.min(Math.max(meta.size_bytes, 0), HARD_ATTACHMENT_BLOB_MAX_BYTES);
            const download = await client.download(uid, part_id, { uid: true, maxBytes });
            const buffer = await bufferFromDownloadContent(download.content);

            if (meta.content_type === 'application/pdf') {
              const extracted = await extractTextFromPdf(buffer);
              return {
                content_type: meta.content_type,
                filename: meta.filename,
                size_bytes: buffer.byteLength,
                extracted_text: extracted
                  ? truncateText(extracted, DEFAULT_ATTACHMENT_TEXT_MAX_CHARS)
                  : '(No extractable text found in PDF.)',
              };
            }

            const text = buffer.toString('utf8');
            return {
              content_type: meta.content_type,
              filename: meta.filename,
              size_bytes: buffer.byteLength,
              extracted_text: truncateText(text, DEFAULT_ATTACHMENT_TEXT_MAX_CHARS),
            };
          },
        );

        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/plain',
              text: result.extracted_text,
              _meta: {
                account_id,
                mailbox,
                uidvalidity,
                uid,
                part_id,
                content_type: result.content_type,
                filename: result.filename,
                size_bytes: result.size_bytes,
                now_utc: nowUtcIso(),
                read_side_effects: 'none',
                security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
              },
            },
          ],
        };
      } catch (error: unknown) {
        const mapped = mapImapError(error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, mapped.message);
      }
    },
  );
}
