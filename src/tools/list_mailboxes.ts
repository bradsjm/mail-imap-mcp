import type { z } from 'zod';

import type { ListMailboxesInputSchema } from '../contracts.js';
import { makeError, makeOk, type ToolResult, type ToolHint } from './runtime.js';
import { withImapClient } from './runtime.js';
import { loadAccountOrError } from '../utils/account.js';

/**
 * Handle the mail_imap_list_mailboxes tool call.
 *
 * Lists all available mailboxes for a configured IMAP account. This tool is
 * useful for discovering valid mailbox names (e.g., INBOX, Sent, Drafts) that
 * can be used in other tool calls like search_messages or get_message.
 *
 * The tool performs the following steps:
 * 1. Validates that the specified account is configured
 * 2. Establishes an IMAP connection to the server
 * 3. Retrieves the list of all mailboxes using the LIST command
 * 4. Normalizes the mailbox information (removes redundant delimiters)
 * 5. Returns the list with a suggestion to search the first mailbox
 *
 * @example
 * ```ts
 * const result = await handleListMailboxes({
 *   account_id: 'default'
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   mailboxes: [
 * //     { name: 'INBOX', delimiter: undefined },
 * //     { name: 'Sent', delimiter: undefined },
 * //     { name: 'Drafts', delimiter: undefined }
 * //   ]
 * // }
 * ```
 *
 * @param args - The validated input arguments containing the account_id
 * @returns A ToolResult containing the list of mailboxes or an error message
 */
export async function handleListMailboxes(
  args: z.infer<typeof ListMailboxesInputSchema>,
): Promise<ToolResult> {
  // Validate that the account is configured before attempting to connect
  const accountResult = loadAccountOrError(args.account_id);
  if ('error' in accountResult) {
    return makeError(accountResult.error);
  }
  const account = accountResult.account;

  // Establish an IMAP connection and list all mailboxes on the server
  // The LIST command returns hierarchy information including delimiters
  const mailboxes = await withImapClient(account, (client) => client.list());

  // Transform the raw mailbox data into a simpler format
  // We normalize the delimiter to undefined for '/' (the most common case)
  // and filter out any entries with invalid or missing names
  const mailboxSummaries = mailboxes
    .map((mailbox) => ({
      name: mailbox.path,
      delimiter: mailbox.delimiter != '/' ? mailbox.delimiter : undefined,
    }))
    .filter((mailbox) => typeof mailbox.name === 'string');
  const limitedMailboxes = mailboxSummaries.slice(0, 200);
  // Provide a helpful summary message showing how many mailboxes were found
  const summaryText =
    mailboxSummaries.length > limitedMailboxes.length
      ? `Mailboxes (${mailboxSummaries.length}) fetched. Showing first ${limitedMailboxes.length}.`
      : `Mailboxes (${mailboxSummaries.length}) fetched.`;

  // Create actionable hints to guide the user's next steps
  const hints: ToolHint[] = [];
  const firstMailbox = limitedMailboxes[0]?.name;

  // Suggest searching the first mailbox if one exists
  // This helps users quickly see what's available without additional tool calls
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
      mailboxes: limitedMailboxes,
    },
    hints,
  );
}
