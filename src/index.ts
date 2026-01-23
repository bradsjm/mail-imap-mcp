import { ImapFlow } from 'imapflow';
import type {
  FetchMessageObject,
  MessageAddressObject,
  MessageEnvelopeObject,
  SearchObject,
} from 'imapflow';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { htmlToText } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import { z } from 'zod';
import type { ZodError } from 'zod';
import { fileURLToPath } from 'node:url';
import {
  TOOL_DEFINITIONS,
  type ToolName,
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  GetMessageRawInputSchema,
  ListMailboxesInputSchema,
  MoveMessageInputSchema,
  SearchMessagesInputSchema,
  UpdateMessageFlagsInputSchema,
} from './contracts.js';
import { decodeMessageId, encodeMessageId } from './message-id.js';
import { CursorStore } from './pagination.js';

type AccountConfig = Readonly<{
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}>;

type ToolHint = Readonly<{
  tool: ToolName;
  arguments: Record<string, unknown>;
  reason: string;
}>;

type ToolJsonResponse = Readonly<{
  summary: string;
  data?: unknown;
  error?: { message: string };
  hints: ToolHint[];
  _meta?: Record<string, unknown>;
}>;

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseNumberEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeEnvSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

export function scrubSecrets(value: unknown): unknown {
  const secretKeyPattern = /(pass(word)?|token|secret|authorization|cookie|key)/i;

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item));
  }

  if (value && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      record[k] = secretKeyPattern.test(k) ? '[REDACTED]' : scrubSecrets(v);
    }
    return record;
  }

  return value;
}

function loadAccountConfig(accountId: string): AccountConfig | null {
  const prefix = `MAIL_IMAP_${normalizeEnvSegment(accountId)}_`;

  const host = process.env[`${prefix}HOST`];
  const user = process.env[`${prefix}USER`];
  const pass = process.env[`${prefix}PASS`];

  if (!host || !user || !pass) {
    return null;
  }

  const port = parseNumberEnv(process.env[`${prefix}PORT`], 993);
  const secure = parseBooleanEnv(process.env[`${prefix}SECURE`], true);

  return { host, port, secure, user, pass };
}

async function withImapClient<T>(
  account: AccountConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.user,
      pass: account.pass,
    },
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function makeError(
  message: string,
  hints: ToolHint[] = [],
  meta?: Record<string, unknown>,
): { isError: true; content: [{ type: 'json'; json: ToolJsonResponse }] } {
  const response: ToolJsonResponse = meta
    ? {
        summary: message,
        error: { message },
        hints,
        _meta: meta,
      }
    : {
        summary: message,
        error: { message },
        hints,
      };
  return {
    isError: true,
    content: [
      {
        type: 'json',
        json: response,
      },
    ],
  };
}

function makeOk(
  summary: string,
  data: unknown,
  hints: ToolHint[] = [],
  meta?: Record<string, unknown>,
): { isError: false; content: [{ type: 'json'; json: ToolJsonResponse }] } {
  const response: ToolJsonResponse = meta
    ? {
        summary,
        data,
        hints,
        _meta: meta,
      }
    : {
        summary,
        data,
        hints,
      };
  return {
    isError: false,
    content: [
      {
        type: 'json',
        json: response,
      },
    ],
  };
}

const WRITE_ENABLED = parseBooleanEnv(process.env['MAIL_IMAP_WRITE_ENABLED'], false);
const SEARCH_CURSOR_STORE = new CursorStore({ ttl_ms: 10 * 60 * 1000, max_entries: 200 });

const TOOL_INPUT_SCHEMAS: Readonly<Record<ToolName, z.ZodTypeAny>> = {
  mail_imap_list_mailboxes: ListMailboxesInputSchema,
  mail_imap_search_messages: SearchMessagesInputSchema,
  mail_imap_get_message: GetMessageInputSchema,
  mail_imap_get_message_raw: GetMessageRawInputSchema,
  mail_imap_update_message_flags: UpdateMessageFlagsInputSchema,
  mail_imap_move_message: MoveMessageInputSchema,
  mail_imap_delete_message: DeleteMessageInputSchema,
};

const WRITE_TOOLS = new Set<ToolName>([
  'mail_imap_update_message_flags',
  'mail_imap_move_message',
  'mail_imap_delete_message',
]);

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

const parseMailSource = simpleParser as unknown as (
  source: NodeJS.ReadableStream | Buffer,
) => Promise<ParsedMail>;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trim()}…`;
}

function formatHeaderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value
      .map(formatHeaderValue)
      .filter((item) => item.length > 0)
      .join(', ');
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return '';
}

function formatAddress(address: MessageAddressObject): string {
  if (address.name && address.address) {
    return `${address.name} <${address.address}>`;
  }
  if (address.address) {
    return address.address;
  }
  return address.name ?? '';
}

function formatAddressList(addresses: MessageAddressObject[] | undefined): string | undefined {
  if (!addresses || addresses.length === 0) {
    return undefined;
  }
  const formatted = addresses.map(formatAddress).filter((value) => value.length > 0);
  return formatted.length > 0 ? formatted.join(', ') : undefined;
}

function toIsoString(value: Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.toISOString();
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function buildSearchQuery(args: z.infer<typeof SearchMessagesInputSchema>): SearchObject {
  const query: SearchObject = {};

  if (args.query) {
    query.text = args.query;
  }
  if (args.from) {
    query.from = args.from;
  }
  if (args.to) {
    query.to = args.to;
  }
  if (args.subject) {
    query.subject = args.subject;
  }
  if (args.unread_only === true) {
    query.seen = false;
  }
  if (args.start_date) {
    query.since = parseDateOnly(args.start_date);
  }
  if (args.end_date) {
    const end = parseDateOnly(args.end_date);
    end.setUTCDate(end.getUTCDate() + 1);
    query.before = end;
  }

  if (Object.keys(query).length === 0) {
    query.all = true;
  }

  return query;
}

function summarizeEnvelope(envelope: MessageEnvelopeObject | undefined): {
  date: string;
  from: string | undefined;
  to: string | undefined;
  cc: string | undefined;
  subject: string | undefined;
} {
  return {
    date: toIsoString(envelope?.date) ?? 'unknown date',
    from: formatAddressList(envelope?.from),
    to: formatAddressList(envelope?.to),
    cc: formatAddressList(envelope?.cc),
    subject: envelope?.subject ?? undefined,
  };
}

export function createServer(): Server {
  const server = new Server(
    { name: 'mail-imap-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAtNs = process.hrtime.bigint();

    const toolName = request.params.name as ToolName;
    const rawArgs = request.params.arguments;

    try {
      const tool = TOOL_DEFINITIONS.find((definition) => definition.name === toolName);
      if (!tool) {
        return makeError(`Unknown tool: '${toolName}'.`);
      }

      const schema = TOOL_INPUT_SCHEMAS[toolName];
      const parsedArgs = schema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        return makeError(`Invalid input:\n${formatZodError(parsedArgs.error)}`);
      }

      if (WRITE_TOOLS.has(toolName) && !WRITE_ENABLED) {
        return makeError(
          'Write operations are disabled. Set MAIL_IMAP_WRITE_ENABLED=true to enable updates.',
        );
      }

      if (toolName === 'mail_imap_list_mailboxes') {
        const args = ListMailboxesInputSchema.parse(rawArgs);
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

        const mailboxes = await withImapClient(account, (client) => client.list());
        const mailboxSummaries = mailboxes
          .map((mailbox) => ({
            name: mailbox.path,
            delimiter: mailbox.delimiter ?? null,
          }))
          .filter((mailbox) => typeof mailbox.name === 'string');
        const summaryText = `Mailboxes (${mailboxSummaries.length}) fetched.`;
        const hints: ToolHint[] = [];
        const firstMailbox = mailboxSummaries[0]?.name;
        if (firstMailbox) {
          hints.push({
            tool: 'mail_imap_search_messages',
            arguments: {
              account_id: args.account_id,
              mailbox: firstMailbox,
              limit: 10,
            },
            reason: 'Search the first mailbox to list recent messages.',
          });
        }

        return makeOk(
          summaryText,
          {
            account_id: args.account_id,
            mailboxes: mailboxSummaries,
          },
          hints,
        );
      }

      if (toolName === 'mail_imap_search_messages') {
        const args = SearchMessagesInputSchema.parse(rawArgs);
        if (
          args.page_token &&
          (args.query ||
            args.from ||
            args.to ||
            args.subject ||
            args.unread_only !== undefined ||
            args.start_date ||
            args.end_date)
        ) {
          return makeError('Do not combine page_token with additional search filters.');
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
          const lock = await client.getMailboxLock(args.mailbox, {
            readOnly: true,
            description: 'mail_imap_search_messages',
          });
          try {
            const mailboxInfo = client.mailbox;
            if (!mailboxInfo) {
              return makeError('Mailbox could not be opened.');
            }
            const mailboxUidvalidity = Number(mailboxInfo.uidValidity ?? 0n);

            const cursor = args.page_token
              ? SEARCH_CURSOR_STORE.getSearchCursor(args.page_token)
              : null;
            if (args.page_token && !cursor) {
              return makeError('page_token is invalid or expired. Run the search again.');
            }
            if (
              cursor &&
              (cursor.account_id !== args.account_id || cursor.mailbox !== args.mailbox)
            ) {
              return makeError('page_token does not match the requested mailbox or account.');
            }
            if (cursor && cursor.uidvalidity !== mailboxUidvalidity) {
              SEARCH_CURSOR_STORE.delete(cursor.id);
              return makeError('Mailbox snapshot has changed. Run the search again to refresh.');
            }

            let uids: number[] = [];
            let total = 0;
            let offset = 0;
            let uidvalidity = mailboxUidvalidity;

            if (cursor) {
              uids = cursor.uids;
              total = cursor.total;
              offset = cursor.offset;
              uidvalidity = cursor.uidvalidity;
            } else {
              const searchQuery = buildSearchQuery(args);
              const results = await client.search(searchQuery, { uid: true });
              if (results === false) {
                return makeError('Search failed for this mailbox.');
              }
              if (results.length === 0) {
                return makeOk(`Found 0 messages in ${args.mailbox}.`, {
                  account_id: args.account_id,
                  mailbox: args.mailbox,
                  total: 0,
                  messages: [],
                });
              }
              uids = results.slice().sort((a, b) => b - a);
              total = uids.length;
              offset = 0;
            }

            if (offset >= total) {
              if (args.page_token) {
                SEARCH_CURSOR_STORE.delete(args.page_token);
              }
              return makeOk('No more results. Run the search again to refresh.', {
                account_id: args.account_id,
                mailbox: args.mailbox,
                total,
                messages: [],
              });
            }

            const pageUids = uids.slice(offset, offset + args.limit);
            const fetchResults: FetchMessageObject[] = [];
            for await (const message of client.fetch(
              pageUids,
              { uid: true, envelope: true, flags: true, internalDate: true },
              { uid: true },
            )) {
              fetchResults.push(message);
            }

            const order = new Map<number, number>();
            pageUids.forEach((uid, index) => {
              order.set(uid, index);
            });
            fetchResults.sort((a, b) => {
              const aIndex = order.get(a.uid ?? 0) ?? 0;
              const bIndex = order.get(b.uid ?? 0) ?? 0;
              return aIndex - bIndex;
            });

            const summaries = fetchResults
              .map((message) => {
                if (message.uid === undefined) {
                  return null;
                }
                const envelopeSummary = summarizeEnvelope(message.envelope);
                const uid = message.uid;
                const messageId = encodeMessageId({
                  account_id: args.account_id,
                  mailbox: args.mailbox,
                  uidvalidity,
                  uid,
                });
                return {
                  message_id: messageId,
                  mailbox: args.mailbox,
                  uidvalidity,
                  uid,
                  date: envelopeSummary.date,
                  from: envelopeSummary.from,
                  subject: envelopeSummary.subject,
                  flags: message.flags ?? undefined,
                };
              })
              .filter((summary): summary is NonNullable<typeof summary> => summary !== null);

            const nextOffset = offset + pageUids.length;
            let nextToken: string | undefined;
            if (nextOffset < total) {
              if (args.page_token) {
                const updated = SEARCH_CURSOR_STORE.updateSearchCursor(args.page_token, nextOffset);
                nextToken = updated?.id ?? args.page_token;
              } else {
                const created = SEARCH_CURSOR_STORE.createSearchCursor({
                  tool: 'mail_imap_search_messages',
                  account_id: args.account_id,
                  mailbox: args.mailbox,
                  uidvalidity,
                  uids,
                  offset: nextOffset,
                  total,
                });
                nextToken = created.id;
              }
            } else if (args.page_token) {
              SEARCH_CURSOR_STORE.delete(args.page_token);
            }

            const header = `Found ${total} messages in ${args.mailbox}. Showing ${summaries.length} starting at ${offset + 1}.`;
            const hints: ToolHint[] = [];
            const firstMessage = summaries[0];
            if (firstMessage) {
              hints.push({
                tool: 'mail_imap_get_message',
                arguments: {
                  account_id: args.account_id,
                  message_id: firstMessage.message_id,
                },
                reason: 'Fetch full details for the first message in this page.',
              });
            }
            if (nextToken) {
              hints.push({
                tool: 'mail_imap_search_messages',
                arguments: {
                  account_id: args.account_id,
                  mailbox: args.mailbox,
                  page_token: nextToken,
                },
                reason: 'Retrieve the next page of results.',
              });
            }

            return makeOk(
              header,
              {
                account_id: args.account_id,
                mailbox: args.mailbox,
                total,
                messages: summaries,
                next_page_token: nextToken,
              },
              hints,
              nextToken ? { next_page_token: nextToken } : undefined,
            );
          } finally {
            lock.release();
          }
        });
      }

      if (toolName === 'mail_imap_get_message') {
        const args = GetMessageInputSchema.parse(rawArgs);
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
              { uid: true, envelope: true, flags: true, internalDate: true },
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
            const bodyHtml = parsedHtml ? sanitizeHtml(parsedHtml) : undefined;
            const textFromHtml = bodyHtml ? htmlToText(bodyHtml, { wordwrap: false }) : undefined;
            const rawText = parsed.text ?? textFromHtml ?? '';

            const bodyText = rawText ? truncateText(rawText, args.body_max_chars) : undefined;
            const limitedHtml =
              args.include_html && bodyHtml
                ? truncateText(bodyHtml, args.body_max_chars)
                : undefined;

            let headers: Record<string, string> | undefined;
            if (args.include_headers) {
              headers = {};
              for (const [key, value] of parsed.headers) {
                headers[key] = formatHeaderValue(value);
              }
            }

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
                  headers,
                  body_text: bodyText,
                  body_html: args.include_html ? limitedHtml : undefined,
                  attachments: [],
                },
              },
              hints,
            );
          } finally {
            lock.release();
          }
        });
      }

      return makeError(`Tool '${toolName}' is registered but not implemented yet.`);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
      console.error(
        JSON.stringify({
          level: 'info',
          event: 'tool_call',
          tool: toolName,
          duration_ms: Math.round(durationMs),
          arguments: scrubSecrets(rawArgs),
        }),
      );
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mail-imap-mcp running on stdio');
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === entry;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${message}`);
    process.exitCode = 1;
  });
}
