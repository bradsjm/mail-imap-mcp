import { describe, expect, it, vi } from 'vitest';
import {
  CursorStore,
  sliceUidsFromDescendingRanges,
  uidsToDescendingRanges,
} from '../src/pagination.js';

describe('CursorStore', () => {
  it('creates and updates search cursors', () => {
    const store = new CursorStore({ ttl_ms: 60_000, max_entries: 5 });
    const cursor = store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid_ranges: [{ min: 1, max: 3 }],
      offset: 3,
      total: 3,
      include_snippet: false,
      snippet_max_chars: 200,
    });

    expect(store.getSearchCursor(cursor.id)?.offset).toBe(3);
    const updated = store.updateSearchCursor(cursor.id, 6);
    expect(updated?.offset).toBe(6);
  });

  it('expires cursors after ttl', () => {
    vi.useFakeTimers();
    const store = new CursorStore({ ttl_ms: 1000, max_entries: 5 });
    const cursor = store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid_ranges: [{ min: 1, max: 1 }],
      offset: 1,
      total: 1,
      include_snippet: false,
      snippet_max_chars: 200,
    });

    vi.setSystemTime(Date.now() + 1500);
    expect(store.getSearchCursor(cursor.id)).toBeNull();
    vi.useRealTimers();
  });

  it('evicts oldest cursors when over limit', () => {
    vi.useFakeTimers();
    const store = new CursorStore({ ttl_ms: 60_000, max_entries: 2 });

    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    const first = store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid_ranges: [{ min: 1, max: 1 }],
      offset: 0,
      total: 1,
      include_snippet: false,
      snippet_max_chars: 200,
    });

    vi.setSystemTime(new Date('2024-01-01T00:00:01Z'));
    store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid_ranges: [{ min: 2, max: 2 }],
      offset: 0,
      total: 1,
      include_snippet: false,
      snippet_max_chars: 200,
    });

    vi.setSystemTime(new Date('2024-01-01T00:00:02Z'));
    store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid_ranges: [{ min: 3, max: 3 }],
      offset: 0,
      total: 1,
      include_snippet: false,
      snippet_max_chars: 200,
    });

    expect(store.getSearchCursor(first.id)).toBeNull();
    vi.useRealTimers();
  });

  it('converts UIDs to descending ranges and slices without expanding', () => {
    const uids = [12, 11, 10, 7, 6, 3];
    const ranges = uidsToDescendingRanges(uids);
    expect(ranges).toEqual([
      { min: 10, max: 12 },
      { min: 6, max: 7 },
      { min: 3, max: 3 },
    ]);

    expect(sliceUidsFromDescendingRanges(ranges, 0, 10)).toEqual(uids);
    expect(sliceUidsFromDescendingRanges(ranges, 2, 2)).toEqual([10, 7]);
    expect(sliceUidsFromDescendingRanges(ranges, 5, 5)).toEqual([3]);
  });
});
