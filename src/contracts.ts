import { z } from 'zod';
import { MessageIdSchema } from './message-id.js';

export type ToolName =
  | 'mail_imap_list_mailboxes'
  | 'mail_imap_search_messages'
  | 'mail_imap_get_message'
  | 'mail_imap_get_message_raw'
  | 'mail_imap_update_message_flags'
  | 'mail_imap_move_message'
  | 'mail_imap_delete_message';

export type ToolDefinition = Readonly<{
  name: ToolName;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
}>;

const AccountIdSchema = z.string().min(1).max(64).describe('Configured IMAP account identifier.');

const DefaultAccountIdSchema = AccountIdSchema.default('default').describe(
  "Configured IMAP account identifier. Defaults to 'default' if omitted.",
);

const MailboxSchema = z.string().min(1).max(256).describe('Mailbox name (e.g., INBOX).');

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date in YYYY-MM-DD format.');

const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(10)
  .describe('Maximum number of items to return (1-50).');

const PageTokenSchema = z
  .string()
  .min(1)
  .max(2048)
  .describe('Opaque pagination token from a previous response.');

const FlagSchema = z.string().min(1).max(64).describe('IMAP system or user flag (e.g., \\Seen).');

export const ListMailboxesInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
  })
  .strict();

export const SearchMessagesInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    mailbox: MailboxSchema,
    last_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Search only messages from the last N days (UTC, inclusive).'),
    query: z.string().min(1).max(256).optional(),
    from: z.string().min(1).max(256).optional(),
    to: z.string().min(1).max(256).optional(),
    subject: z.string().min(1).max(256).optional(),
    unread_only: z.boolean().optional(),
    start_date: DateSchema.optional(),
    end_date: DateSchema.optional(),
    limit: LimitSchema,
    page_token: PageTokenSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.last_days !== undefined && (value.start_date || value.end_date)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either last_days or start_date/end_date, not both.',
        path: ['last_days'],
      });
    }
  });

export const GetMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    body_max_chars: z.number().int().min(100).max(20000).default(2000),
    include_headers: z.boolean().default(true),
    include_html: z.boolean().default(false),
  })
  .strict();

export const GetMessageRawInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    max_bytes: z.number().int().min(1024).max(1_000_000).default(200_000),
  })
  .strict();

export const UpdateMessageFlagsInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    add_flags: z.array(FlagSchema).min(1).max(20).optional(),
    remove_flags: z.array(FlagSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.add_flags && !value.remove_flags) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide add_flags, remove_flags, or both.',
        path: ['add_flags'],
      });
    }
  });

export const MoveMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    destination_mailbox: MailboxSchema,
  })
  .strict();

export const DeleteMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    confirm: z.literal(true).describe('Must be true to delete the message.'),
  })
  .strict();

export const MailboxSummarySchema = z
  .object({
    name: MailboxSchema,
    delimiter: z.string().min(1).max(8).nullable().optional(),
    message_count: z.number().int().nonnegative().optional(),
    unread_count: z.number().int().nonnegative().optional(),
  })
  .strict();

export const AttachmentSummarySchema = z
  .object({
    filename: z.string().min(1).max(256).optional(),
    content_type: z.string().min(1).max(128),
    size_bytes: z.number().int().nonnegative(),
    part_id: z.string().min(1).max(128),
  })
  .strict();

export const MessageSummarySchema = z
  .object({
    message_id: MessageIdSchema,
    mailbox: MailboxSchema,
    uidvalidity: z.number().int().nonnegative(),
    uid: z.number().int().nonnegative(),
    date: z.string().min(1).max(64),
    from: z.string().min(1).max(256).optional(),
    subject: z.string().min(1).max(256).optional(),
    flags: z.array(FlagSchema).max(20).optional(),
    snippet: z.string().min(1).max(500).optional(),
  })
  .strict();

export const MessageDetailSchema = z
  .object({
    message_id: MessageIdSchema,
    mailbox: MailboxSchema,
    uidvalidity: z.number().int().nonnegative(),
    uid: z.number().int().nonnegative(),
    date: z.string().min(1).max(64),
    from: z.string().min(1).max(256).optional(),
    to: z.string().min(1).max(256).optional(),
    cc: z.string().min(1).max(256).optional(),
    subject: z.string().min(1).max(256).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body_text: z.string().min(1).max(20000).optional(),
    body_html: z.string().min(1).max(20000).optional(),
    attachments: z.array(AttachmentSummarySchema).max(50).optional(),
  })
  .strict();

export const ListMailboxesResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailboxes: z.array(MailboxSummarySchema).max(200),
  })
  .strict();

export const SearchMessagesResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailbox: MailboxSchema,
    total: z.number().int().nonnegative().optional(),
    messages: z.array(MessageSummarySchema).max(50),
    next_page_token: PageTokenSchema.optional(),
  })
  .strict();

export const GetMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message: MessageDetailSchema,
  })
  .strict();

export const GetMessageRawResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message_id: MessageIdSchema,
    size_bytes: z.number().int().nonnegative(),
    raw_source: z.string().min(1).max(1_000_000),
  })
  .strict();

export const UpdateMessageFlagsResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message_id: MessageIdSchema,
    flags: z.array(FlagSchema).max(20),
  })
  .strict();

export const MoveMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    source_mailbox: MailboxSchema,
    destination_mailbox: MailboxSchema,
    message_id: MessageIdSchema,
    new_message_id: MessageIdSchema.optional(),
  })
  .strict();

export const DeleteMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailbox: MailboxSchema,
    message_id: MessageIdSchema,
  })
  .strict();

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'mail_imap_list_mailboxes',
    description:
      "List mailboxes for an IMAP account. Use this to discover valid mailbox names (e.g., INBOX). If account_id is omitted, defaults to 'default'. Returns a concise list.",
    inputSchema: ListMailboxesInputSchema,
    outputSchema: ListMailboxesResultSchema,
  },
  {
    name: 'mail_imap_search_messages',
    description:
      "List or search messages in a mailbox by sender/subject/date/unread. If account_id is omitted, defaults to 'default'. Returns paginated summaries (token-efficient).",
    inputSchema: SearchMessagesInputSchema,
    outputSchema: SearchMessagesResultSchema,
  },
  {
    name: 'mail_imap_get_message',
    description:
      "Fetch a single message by stable identifier and return headers + a bounded text snippet (optionally sanitized HTML). If account_id is omitted, defaults to 'default'.",
    inputSchema: GetMessageInputSchema,
    outputSchema: GetMessageResultSchema,
  },
  {
    name: 'mail_imap_get_message_raw',
    description:
      "Fetch raw message source (RFC822) for a single message. If account_id is omitted, defaults to 'default'. Gated and size-limited; not returned by default.",
    inputSchema: GetMessageRawInputSchema,
    outputSchema: GetMessageRawResultSchema,
  },
  {
    name: 'mail_imap_update_message_flags',
    description:
      "Update flags on a message (e.g., mark read/unread). If account_id is omitted, defaults to 'default'. Write operations are disabled by default.",
    inputSchema: UpdateMessageFlagsInputSchema,
    outputSchema: UpdateMessageFlagsResultSchema,
  },
  {
    name: 'mail_imap_move_message',
    description:
      "Move a message to another mailbox. If account_id is omitted, defaults to 'default'. Write operations are disabled by default.",
    inputSchema: MoveMessageInputSchema,
    outputSchema: MoveMessageResultSchema,
  },
  {
    name: 'mail_imap_delete_message',
    description:
      "Delete a message. If account_id is omitted, defaults to 'default'. Requires explicit confirmation; write operations are disabled by default.",
    inputSchema: DeleteMessageInputSchema,
    outputSchema: DeleteMessageResultSchema,
  },
] as const;
