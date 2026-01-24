import { z } from 'zod';
import { MessageIdSchema } from './message-id.js';

/**
 * All supported IMAP tool names.
 *
 * Each tool name corresponds to a specific email operation that can be
 * performed through the MCP server. These names are used for routing
 * tool calls to their respective handlers.
 */
export type ToolName =
  | 'mail_imap_list_mailboxes'
  | 'mail_imap_search_messages'
  | 'mail_imap_get_message'
  | 'mail_imap_get_message_raw'
  | 'mail_imap_update_message_flags'
  | 'mail_imap_move_message'
  | 'mail_imap_delete_message';

/**
 * Definition of an IMAP tool including name, description, and schemas.
 *
 * This type defines the metadata and validation schemas for each tool.
 * The input schema validates user arguments, while the output schema
 * defines the structure of successful responses.
 */
export type ToolDefinition = Readonly<{
  /** The unique identifier for this tool */
  name: ToolName;
  /** Human-readable description of what this tool does */
  description: string;
  /** Zod schema for validating tool input arguments */
  inputSchema: z.ZodTypeAny;
  /** Zod schema for validating tool output data */
  outputSchema: z.ZodTypeAny;
}>;

/**
 * Schema for validating IMAP account identifiers.
 *
 * Account IDs are configured via environment variables following the
 * pattern `MAIL_IMAP_{ACCOUNT_ID}_*`. The ID is normalized to uppercase
 * and alphanumeric characters for consistency.
 */
const AccountIdSchema = z.string().min(1).max(64).describe('Configured IMAP account identifier.');

/**
 * Schema for validating account identifiers with a default value.
 *
 * When omitted, this defaults to 'default', which is the standard
 * account ID for single-account configurations.
 */
const DefaultAccountIdSchema = AccountIdSchema.default('default').describe(
  "Configured IMAP account identifier. Defaults to 'default' if omitted.",
);

/**
 * Schema for validating IMAP mailbox names.
 *
 * Mailbox names are case-sensitive paths on the IMAP server. Common
 * examples include 'INBOX', 'Sent', 'Drafts', 'Archive', etc. Hierarchical
 * mailboxes use delimiters (typically '/') such as 'Work/Projects'.
 */
const MailboxSchema = z.string().min(1).max(256).describe('Mailbox name (e.g., INBOX).');

/**
 * Validate that a string represents a real calendar date.
 *
 * Checks that the string matches the YYYY-MM-DD format and represents
 * a valid date (e.g., not February 30). This is used to validate
 * date range inputs for email search operations.
 *
 * @param value - The date string to validate
 * @returns True if the string is a valid date, false otherwise
 */
function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Schema for validating date-only strings in YYYY-MM-DD format.
 *
 * This schema ensures that date inputs are both properly formatted and
 * represent valid calendar dates. It's used for date range filtering
 * in search operations.
 */
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isValidDateOnly(value), {
    message: 'Invalid date. Use a real YYYY-MM-DD calendar date.',
  })
  .describe('Date in YYYY-MM-DD format.');

/**
 * Schema for validating pagination limit parameters.
 *
 * Controls how many items are returned in a single page of results.
 * The limit is constrained to 1-50 to prevent excessive response sizes
 * and ensure reasonable performance.
 */
const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(10)
  .describe('Maximum number of items to return (1-50).');

/**
 * Schema for validating pagination tokens.
 *
 * Page tokens are opaque strings returned by search operations that allow
 * fetching subsequent pages of results. They encode search state including
 * matched UIDs, current offset, and expiration time.
 */
const PageTokenSchema = z
  .string()
  .min(1)
  .max(2048)
  .describe('Opaque pagination token from a previous response.');

/**
 * Schema for validating IMAP message flags.
 *
 * IMAP flags (also known as labels or tags) can be system flags like
 * \Seen, \Answered, \Flagged, \Deleted, \Draft, or user-defined flags.
 * System flags must include the backslash prefix.
 */
const FlagSchema = z.string().min(1).max(64).describe('IMAP system or user flag (e.g., \\Seen).');

/**
 * Input schema for the mail_imap_list_mailboxes tool.
 *
 * Lists all available mailboxes for a configured IMAP account.
 * This is a read-only operation that discovers mailbox names.
 */
export const ListMailboxesInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
  })
  .strict();

/**
 * Input schema for the mail_imap_search_messages tool.
 *
 * Searches for messages in an IMAP mailbox based on various criteria.
 * Supports date ranges, sender/recipient/subject filters, full-text search,
 * read status filtering, and pagination. Multiple filters can be combined.
 *
 * Validation rules:
 * - Cannot combine last_days with start_date/end_date
 * - start_date must be on or before end_date
 * - snippet_max_chars is only valid when include_snippet is true
 */
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
    include_snippet: z
      .boolean()
      .default(false)
      .describe(
        'If true, include a short body snippet in each message summary (may require extra IO).',
      ),
    snippet_max_chars: z
      .number()
      .int()
      .min(50)
      .max(500)
      .default(200)
      .describe('Maximum snippet length when include_snippet is true (50-500).'),
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
    if (value.start_date && value.end_date && value.start_date > value.end_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_date must be on or before end_date.',
        path: ['start_date'],
      });
    }
    if (value.include_snippet !== true && value.snippet_max_chars !== 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snippet_max_chars is only valid when include_snippet is true.',
        path: ['snippet_max_chars'],
      });
    }
  });

/**
 * Input schema for the mail_imap_get_message tool.
 *
 * Retrieves a single email message by its stable identifier and returns
 * parsed headers, body text (and optionally HTML), and attachment summaries.
 * Options control what data is included and how much is returned.
 *
 * Validation rules:
 * - attachment_text_max_chars is only valid when extract_attachment_text is true
 */
export const GetMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    body_max_chars: z.number().int().min(100).max(20000).default(2000),
    include_headers: z.boolean().default(true),
    include_all_headers: z
      .boolean()
      .default(false)
      .describe('If true, include all headers (may be large/noisy). Implies include_headers.'),
    include_html: z.boolean().default(false),
    extract_attachment_text: z
      .boolean()
      .default(false)
      .describe('If true, extract text from PDF attachments (may be slow).'),
    attachment_text_max_chars: z
      .number()
      .int()
      .min(100)
      .max(50000)
      .default(10000)
      .describe(
        'Maximum text length to extract from each PDF attachment when extract_attachment_text is true (100-50000).',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.extract_attachment_text !== true && value.attachment_text_max_chars !== 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attachment_text_max_chars is only valid when extract_attachment_text is true.',
        path: ['attachment_text_max_chars'],
      });
    }
  });

/**
 * Input schema for the mail_imap_get_message_raw tool.
 *
 * Retrieves the raw RFC822 source of an email message. This is the complete,
 * unparsed message as received from the mail server. The max_bytes parameter
 * limits memory usage for large messages.
 */
export const GetMessageRawInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    max_bytes: z.number().int().min(1024).max(1_000_000).default(200_000),
  })
  .strict();

/**
 * Input schema for the mail_imap_update_message_flags tool.
 *
 * Updates IMAP message flags (also known as labels or tags). Flags can be
 * added or removed. At least one of add_flags or remove_flags must be provided.
 *
 * Validation rules:
 * - Must provide add_flags, remove_flags, or both
 */
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

/**
 * Input schema for the mail_imap_move_message tool.
 *
 * Moves a message from one mailbox to another. This operation removes the
 * message from its original mailbox and places it in the destination mailbox.
 * The tool automatically chooses the best strategy based on server capabilities.
 */
export const MoveMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    destination_mailbox: MailboxSchema,
  })
  .strict();

/**
 * Input schema for the mail_imap_delete_message tool.
 *
 * Permanently deletes a specific message from an IMAP mailbox. This is a
 * destructive operation that requires explicit confirmation via the confirm=true
 * parameter to prevent accidental deletions.
 */
export const DeleteMessageInputSchema = z
  .object({
    account_id: DefaultAccountIdSchema,
    message_id: MessageIdSchema,
    confirm: z.literal(true).describe('Must be true to delete the message.'),
  })
  .strict();

/**
 * Output schema for a mailbox summary.
 *
 * Contains basic information about a mailbox, including its name,
 * hierarchy delimiter, and message counts. This is returned by the
 * list_mailboxes tool.
 */
export const MailboxSummarySchema = z
  .object({
    name: MailboxSchema,
    delimiter: z.string().min(1).max(8).nullable().optional(),
    message_count: z.number().int().nonnegative().optional(),
    unread_count: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Output schema for an attachment summary.
 *
 * Contains metadata about an email attachment, including filename,
 * content type, size, part identifier, and optionally extracted text
 * (for PDFs when text extraction is requested).
 */
export const AttachmentSummarySchema = z
  .object({
    filename: z.string().min(1).max(256).optional(),
    content_type: z.string().min(1).max(128),
    size_bytes: z.number().int().nonnegative(),
    part_id: z.string().min(1).max(128),
    extracted_text: z.string().min(1).max(50000).optional(),
  })
  .strict();

/**
 * Output schema for a message summary.
 *
 * Contains key metadata about a message without the full body. This is
 * returned by the search_messages tool and includes envelope information,
 * flags, and an optional body snippet.
 */
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

/**
 * Output schema for a message with full details.
 *
 * Contains complete information about a message including envelope data,
 * flags, headers, body text (and optionally HTML), and attachment summaries.
 * This is returned by the get_message tool.
 */
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
    flags: z.array(FlagSchema).max(20).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body_text: z.string().min(1).max(20000).optional(),
    body_html: z.string().min(1).max(20000).optional(),
    attachments: z.array(AttachmentSummarySchema).max(50).optional(),
  })
  .strict();

/**
 * Output schema for the list_mailboxes tool.
 *
 * Returns all available mailboxes for an account along with their metadata.
 * Limited to 200 mailboxes per account to prevent excessive output.
 */
export const ListMailboxesResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailboxes: z.array(MailboxSummarySchema).max(200),
  })
  .strict();

/**
 * Output schema for the search_messages tool.
 *
 * Returns a page of search results with pagination support. Includes
 * the total count of matching messages, the current page of message summaries,
 * and an optional token for fetching the next page.
 */
export const SearchMessagesResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailbox: MailboxSchema,
    total: z.number().int().nonnegative().optional(),
    messages: z.array(MessageSummarySchema).max(50),
    next_page_token: PageTokenSchema.optional(),
  })
  .strict();

/**
 * Output schema for the get_message tool.
 *
 * Returns the full details of a single message including envelope data,
 * headers, body content, and attachment summaries.
 */
export const GetMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message: MessageDetailSchema,
  })
  .strict();

/**
 * Output schema for the get_message_raw tool.
 *
 * Returns the raw RFC822 source of a message. The content is limited
 * to 1MB by the schema to prevent excessive response sizes.
 */
export const GetMessageRawResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message_id: MessageIdSchema,
    size_bytes: z.number().int().nonnegative(),
    raw_source: z.string().min(1).max(1_000_000),
  })
  .strict();

/**
 * Output schema for the update_message_flags tool.
 *
 * Returns the updated set of flags for the message after the operation
 * completes. This reflects the actual state after both add and remove
 * operations were applied.
 */
export const UpdateMessageFlagsResultSchema = z
  .object({
    account_id: AccountIdSchema,
    message_id: MessageIdSchema,
    flags: z.array(FlagSchema).max(20),
  })
  .strict();

/**
 * Output schema for the move_message tool.
 *
 * Returns confirmation that a message was moved, including source and
 * destination mailboxes. If the server supports UIDPLUS, the new message
 * ID for the moved message is also provided.
 */
export const MoveMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    source_mailbox: MailboxSchema,
    destination_mailbox: MailboxSchema,
    message_id: MessageIdSchema,
    new_message_id: MessageIdSchema.optional(),
  })
  .strict();

/**
 * Output schema for the delete_message tool.
 *
 * Returns confirmation that a message was deleted, including the account
 * ID, mailbox name, and the message ID of the deleted message.
 */
export const DeleteMessageResultSchema = z
  .object({
    account_id: AccountIdSchema,
    mailbox: MailboxSchema,
    message_id: MessageIdSchema,
  })
  .strict();

/**
 * Complete list of all available IMAP tool definitions.
 *
 * This readonly array contains the definitions for all tools supported by
 * the MCP server. Each definition includes the tool name, description,
 * input validation schema, and output validation schema.
 *
 * Tools are categorized as:
 * - Read operations (list, search, get): Always available
 * - Write operations (move, delete, flag updates): Only available when
 *   MAIL_IMAP_WRITE_ENABLED=true
 *
 * Tool purposes:
 * - mail_imap_list_mailboxes: Discover available mailboxes
 * - mail_imap_search_messages: Find messages matching criteria
 * - mail_imap_get_message: Retrieve parsed message content
 * - mail_imap_get_message_raw: Retrieve raw RFC822 source
 * - mail_imap_update_message_flags: Modify message flags/labels
 * - mail_imap_move_message: Move message to another mailbox
 * - mail_imap_delete_message: Permanently delete a message
 */
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
      "Fetch a single message by stable identifier and return headers + a bounded text snippet (optionally sanitized HTML). Can extract text from PDF attachments. If account_id is omitted, defaults to 'default'.",
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
