import type { z } from 'zod';

import type { SearchMessagesInputSchema } from '../contracts.js';
import { encodeMessageId } from '../message-id.js';

/**
 * Handle the imap_search_messages tool call.
 *
 * Searches for messages in an IMAP mailbox based on various criteria (date range,
 * sender, recipient, subject, text content, read status, etc.). This tool supports
 * pagination to handle large result sets efficiently.
 *
 * The tool performs the following steps:
 * 1. Validates that search filters are not combined with page_token (invalid operation)
 * 2. Validates that the account is properly configured
 * 3. Establishes an IMAP connection and obtains a read lock on the mailbox
 * 4. If page_token is provided:
 *    - Retrieves the cursor and validates it (not expired, matches account/mailbox)
 *    - Verifies the mailbox hasn't changed (UIDVALIDITY still matches)
 *    - Uses the cursor's UID ranges for pagination
 * 5. If no page_token:
 *    - Builds an IMAP SEARCH query from the provided filters
 *    - Executes the search to get matching UIDs
 *    - Sorts UIDs in descending order (newest first)
 *    - Compresses UIDs into ranges for efficient storage (if under MAX_SEARCH_MATCHES_FOR_PAGINATION)
 *    - Creates a cursor for pagination (or disables pagination if too many matches)
 * 6. Fetches message metadata for the requested page of messages
 * 7. Optionally extracts and includes body snippets for each message
 * 8. Returns the page of results with a next_page_token if more results exist
 * 9. If the cursor becomes outdated or expired, invalidates it
 *
 * Pagination details:
 * - Cursors are stored in memory with a 10-minute TTL
 * - Maximum 200 concurrent cursors are stored
 * - Pagination is disabled if search matches exceed MAX_SEARCH_MATCHES_FOR_PAGINATION
 * - Each page contains up to `limit` messages (default 10, max 50)
 *
 * Search filters:
 * - last_days: Messages from the last N days (UTC, inclusive)
 * - start_date/end_date: Date range in YYYY-MM-DD format
 * - from/to/subject: Filter by sender, recipient, or subject
 * - query: Full-text search across message body
 * - unread_only: Only show unread messages
 * - include_snippet: Include a short body snippet (may require extra IO)
 *
 * @example
 * ```ts
 * // Initial search
 * const result = await handleSearchMessages({
 *   account_id: 'default',
 *   mailbox: 'INBOX',
 *   from: 'sender@example.com',
 *   unread_only: true,
 *   limit: 10
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   mailbox: 'INBOX',
 * //   total: 25,
 * //   messages: [...10 messages...],
 * //   next_page_token: 'uuid-of-cursor'
 * // }
 *
 * // Next page
 * const nextResult = await handleSearchMessages({
 *   account_id: 'default',
 *   mailbox: 'INBOX',
 *   page_token: 'uuid-of-cursor',
 *   limit: 10
 * });
 * // Returns: {
 * //   account_id: 'default',
 * //   mailbox: 'INBOX',
 * //   total: 25,
 * //   messages: [...next 10 messages...],
 * //   next_page_token: 'another-uuid' // or undefined if end of results
 * // }
 * ```
 *
 * @param args - The validated input arguments containing search filters and pagination options
 * @returns A ToolResult containing the search results, pagination token, or an error message
 */
import {
  buildSearchQuery,
  getMessageSnippet,
  lastDaysSinceUtc,
  makeError,
  makeOk,
  MAX_SEARCH_MATCHES_FOR_PAGINATION,
  SEARCH_CURSOR_STORE,
  summarizeEnvelope,
  type ToolHint,
  type ToolResult,
  UNTRUSTED_EMAIL_CONTENT_NOTE,
  formatFlags,
  nowUtcIso,
  withImapClient,
  type FetchMessageObject,
} from './runtime.js';
import {
  sliceUidsFromDescendingRanges,
  type UidRange,
  uidsToDescendingRanges,
} from '../pagination.js';
import { loadAccountOrError } from '../utils/account.js';
import { openMailboxLock } from '../utils/mailbox.js';

export async function handleSearchMessages(
  args: z.infer<typeof SearchMessagesInputSchema>,
): Promise<ToolResult> {
  // Validate that page_token is not combined with search filters
  // This would be an invalid operation because page_token represents a specific
  // snapshot of search results, and additional filters would require a new search
  if (
    args.page_token &&
    (args.query ||
      args.from ||
      args.to ||
      args.subject ||
      args.last_days !== undefined ||
      args.unread_only !== undefined ||
      args.start_date ||
      args.end_date)
  ) {
    return makeError('Do not combine page_token with additional search filters.');
  }

  // Validate that the account is configured before attempting to connect
  const accountResult = loadAccountOrError(args.account_id);
  if ('error' in accountResult) {
    return makeError(accountResult.error);
  }
  const account = accountResult.account;

  return await withImapClient(account, async (client) => {
    // Obtain a read lock on the mailbox to search
    // We don't specify expectedUidvalidity here because page_token handles that check
    const lockResult = await openMailboxLock(client, args.mailbox, {
      readOnly: true,
      description: 'imap_search_messages',
    });
    if ('error' in lockResult) {
      return makeError(lockResult.error);
    }
    const { lock, uidvalidity: mailboxUidvalidity } = lockResult;
    try {
      // If page_token is provided, retrieve the cursor and validate it
      const cursor = args.page_token ? SEARCH_CURSOR_STORE.getSearchCursor(args.page_token) : null;
      if (args.page_token && !cursor) {
        return makeError('page_token is invalid or expired. Run the search again.');
      }
      // Validate that the cursor matches the requested account and mailbox
      // This prevents using a cursor from one account/mailbox on another
      if (cursor && (cursor.account_id !== args.account_id || cursor.mailbox !== args.mailbox)) {
        return makeError('page_token does not match the requested mailbox or account.');
      }
      // Validate that the mailbox hasn't changed since the cursor was created
      // UIDVALIDITY changes when a mailbox is deleted and recreated, making old UIDs invalid
      if (cursor && cursor.uidvalidity !== mailboxUidvalidity) {
        SEARCH_CURSOR_STORE.delete(cursor.id);
        return makeError('Mailbox snapshot has changed. Run the search again to refresh.');
      }

      let uids: number[] = [];
      let total = 0;
      let offset = 0;
      let uidvalidity = mailboxUidvalidity;
      let includeSnippet = args.include_snippet;
      let snippetMaxChars = args.snippet_max_chars;
      let paginationDisabled = false;
      let uidRanges: readonly UidRange[] = [];

      // If using a cursor, extract pre-computed values from it
      // This avoids re-running the search and ensures consistent pagination
      if (cursor) {
        uidRanges = cursor.uid_ranges;
        total = cursor.total;
        offset = cursor.offset;
        uidvalidity = cursor.uidvalidity;
        includeSnippet = cursor.include_snippet;
        snippetMaxChars = cursor.snippet_max_chars;
      } else {
        // Perform a new search: build query from filters and execute it
        const searchQuery = buildSearchQuery(args);
        const results = await client.search(searchQuery, { uid: true });
        if (!results) {
          return makeError('Search failed for this mailbox.');
        }
        // Sort UIDs in descending order (newest messages first)
        const searchResults: number[] = results.slice().sort((a, b) => b - a);
        if (searchResults.length === 0) {
          // No results: return early with metadata about the search
          const meta: Record<string, unknown> = {
            now_utc: nowUtcIso(),
            security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
            read_side_effects: 'none',
          };
          if (args.last_days !== undefined) {
            meta['last_days'] = args.last_days;
            meta['effective_since_utc'] = lastDaysSinceUtc(args.last_days).toISOString();
          }
          return makeOk(
            `Found 0 messages in ${args.mailbox}.`,
            {
              account_id: args.account_id,
              mailbox: args.mailbox,
              total: 0,
              messages: [],
            },
            [],
            meta,
          );
        }
        uids = searchResults;
        total = uids.length;
        offset = 0;
        // Disable pagination if there are too many matches to store in memory
        // This prevents excessive memory usage and simplifies handling of large result sets
        paginationDisabled = total > MAX_SEARCH_MATCHES_FOR_PAGINATION;
        if (!paginationDisabled) {
          uidRanges = uidsToDescendingRanges(uids);
        } else {
          uids = uids.slice(0, args.limit);
        }
      }

      // Check if we've reached the end of results
      if (offset >= total) {
        // Clean up the cursor if we're at the end of pagination
        if (args.page_token) {
          SEARCH_CURSOR_STORE.delete(args.page_token);
        }
        const meta: Record<string, unknown> = {
          now_utc: nowUtcIso(),
          security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
          read_side_effects: 'none',
        };
        if (args.last_days !== undefined) {
          meta['last_days'] = args.last_days;
          meta['effective_since_utc'] = lastDaysSinceUtc(args.last_days).toISOString();
        }
        return makeOk(
          'No more results. Run the search again to refresh.',
          {
            account_id: args.account_id,
            mailbox: args.mailbox,
            total,
            messages: [],
          },
          [],
          meta,
        );
      }

      // Extract the page of UIDs to fetch
      // Use compressed ranges if pagination is enabled, otherwise slice the array
      const pageUids: number[] = cursor
        ? sliceUidsFromDescendingRanges(uidRanges, offset, args.limit)
        : uids.slice(offset, offset + args.limit);
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
      // Sort messages to match the order they were requested
      // IMAP FETCH may return messages in any order, so we sort by UID
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
          // Create a stable message ID that can be used in subsequent tool calls
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
            flags: formatFlags(message.flags),
            snippet: undefined as string | undefined,
          };
        })
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null);

      if (includeSnippet) {
        for (const summary of summaries) {
          const snippet = await getMessageSnippet(client, summary.uid, {
            max_chars: snippetMaxChars,
          });
          if (snippet) {
            summary.snippet = snippet;
          }
        }
      }

      // Calculate the next offset and determine if we need a pagination token
      const nextOffset = offset + pageUids.length;
      let nextToken: string | undefined;
      if (nextOffset < total && !paginationDisabled) {
        // More results available: create or update the cursor
        if (args.page_token) {
          // Update existing cursor with new offset
          const updated = SEARCH_CURSOR_STORE.updateSearchCursor(args.page_token, nextOffset);
          nextToken = updated?.id ?? args.page_token;
        } else {
          // Create a new cursor for the first page
          const created = SEARCH_CURSOR_STORE.createSearchCursor({
            tool: 'imap_search_messages',
            account_id: args.account_id,
            mailbox: args.mailbox,
            uidvalidity,
            uid_ranges: uidRanges,
            offset: nextOffset,
            total,
            include_snippet: includeSnippet,
            snippet_max_chars: snippetMaxChars,
          });
          nextToken = created.id;
        }
      } else if (args.page_token) {
        // End of pagination: clean up the cursor
        SEARCH_CURSOR_STORE.delete(args.page_token);
      }

      // Create a helpful summary message
      const header = `Found ${total} messages in ${args.mailbox}. Showing ${summaries.length} starting at ${offset + 1}.`;
      const hints: ToolHint[] = [];
      // Suggest viewing the first message if any results were returned
      const firstMessage = summaries[0];
      if (firstMessage) {
        hints.push({
          tool: 'imap_get_message',
          arguments: {
            account_id: args.account_id,
            message_id: firstMessage.message_id,
          },
          reason: 'Fetch full details for the first message in this page.',
        });
      }
      // Suggest fetching the next page if pagination is available
      if (nextToken) {
        hints.push({
          tool: 'imap_search_messages',
          arguments: {
            account_id: args.account_id,
            mailbox: args.mailbox,
            page_token: nextToken,
          },
          reason: 'Retrieve the next page of results.',
        });
      }

      const meta: Record<string, unknown> = {
        now_utc: nowUtcIso(),
        security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
        read_side_effects: 'none',
      };
      if (nextToken) {
        meta['next_page_token'] = nextToken;
      }
      // Include metadata about pagination state and search parameters
      if (paginationDisabled) {
        meta['pagination_disabled'] = true;
        meta['pagination_disabled_reason'] = 'too_many_matches';
        meta['max_search_matches_for_pagination'] = MAX_SEARCH_MATCHES_FOR_PAGINATION;
      }
      if (args.last_days !== undefined) {
        meta['last_days'] = args.last_days;
        meta['effective_since_utc'] = lastDaysSinceUtc(args.last_days).toISOString();
      }
      if (includeSnippet) {
        meta['include_snippet'] = true;
        meta['snippet_max_chars'] = snippetMaxChars;
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
        meta,
      );
    } finally {
      // Always release the lock, even if an error occurred
      // This prevents deadlock and allows other operations to proceed
      lock.release();
    }
  });
}
