import { describe, expect, it, vi } from 'vitest';
import { CursorStore } from './pagination.js';

describe('CursorStore', () => {
  it('creates and updates search cursors', () => {
    const store = new CursorStore({ ttl_ms: 60_000, max_entries: 5 });
    const cursor = store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids: [3, 2, 1],
      offset: 3,
      total: 3,
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
      uids: [1],
      offset: 1,
      total: 1,
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
      uids: [1],
      offset: 0,
      total: 1,
    });

    vi.setSystemTime(new Date('2024-01-01T00:00:01Z'));
    store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids: [2],
      offset: 0,
      total: 1,
    });

    vi.setSystemTime(new Date('2024-01-01T00:00:02Z'));
    store.createSearchCursor({
      tool: 'mail_imap_search_messages',
      account_id: 'default',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids: [3],
      offset: 0,
      total: 1,
    });

    expect(store.getSearchCursor(first.id)).toBeNull();
    vi.useRealTimers();
  });
});
