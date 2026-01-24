import type { z } from 'zod';

import type { SearchMessagesInputSchema } from '../contracts.js';
import { loadAccountConfig, normalizeEnvSegment } from '../config.js';
import { encodeMessageId } from '../message-id.js';
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

export async function handleSearchMessages(
  args: z.infer<typeof SearchMessagesInputSchema>,
): Promise<ToolResult> {
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

      const cursor = args.page_token ? SEARCH_CURSOR_STORE.getSearchCursor(args.page_token) : null;
      if (args.page_token && !cursor) {
        return makeError('page_token is invalid or expired. Run the search again.');
      }
      if (cursor && (cursor.account_id !== args.account_id || cursor.mailbox !== args.mailbox)) {
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
      let includeSnippet = args.include_snippet;
      let snippetMaxChars = args.snippet_max_chars;
      let paginationDisabled = false;
      let uidRanges: readonly UidRange[] = [];

      if (cursor) {
        uidRanges = cursor.uid_ranges;
        total = cursor.total;
        offset = cursor.offset;
        uidvalidity = cursor.uidvalidity;
        includeSnippet = cursor.include_snippet;
        snippetMaxChars = cursor.snippet_max_chars;
      } else {
        const searchQuery = buildSearchQuery(args);
        const results = await client.search(searchQuery, { uid: true });
        if (!results) {
          return makeError('Search failed for this mailbox.');
        }
        const searchResults: number[] = results.slice().sort((a, b) => b - a);
        if (searchResults.length === 0) {
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
        paginationDisabled = total > MAX_SEARCH_MATCHES_FOR_PAGINATION;
        if (!paginationDisabled) {
          uidRanges = uidsToDescendingRanges(uids);
        } else {
          uids = uids.slice(0, args.limit);
        }
      }

      if (offset >= total) {
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

      const nextOffset = offset + pageUids.length;
      let nextToken: string | undefined;
      if (nextOffset < total && !paginationDisabled) {
        if (args.page_token) {
          const updated = SEARCH_CURSOR_STORE.updateSearchCursor(args.page_token, nextOffset);
          nextToken = updated?.id ?? args.page_token;
        } else {
          const created = SEARCH_CURSOR_STORE.createSearchCursor({
            tool: 'mail_imap_search_messages',
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

      const meta: Record<string, unknown> = {
        now_utc: nowUtcIso(),
        security_note: UNTRUSTED_EMAIL_CONTENT_NOTE,
        read_side_effects: 'none',
      };
      if (nextToken) {
        meta['next_page_token'] = nextToken;
      }
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
      lock.release();
    }
  });
}
