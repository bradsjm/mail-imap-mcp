import { randomUUID } from 'node:crypto';

export type SearchCursor = Readonly<{
  id: string;
  tool: 'mail_imap_search_messages';
  account_id: string;
  mailbox: string;
  uidvalidity: number;
  uids: number[];
  offset: number;
  total: number;
  created_at_ms: number;
  expires_at_ms: number;
}>;

export type CursorStoreOptions = Readonly<{
  ttl_ms: number;
  max_entries: number;
}>;

export class CursorStore {
  private readonly entries = new Map<string, SearchCursor>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: CursorStoreOptions) {
    this.ttlMs = options.ttl_ms;
    this.maxEntries = options.max_entries;
  }

  createSearchCursor(
    input: Omit<SearchCursor, 'id' | 'created_at_ms' | 'expires_at_ms'>,
  ): SearchCursor {
    const now = Date.now();
    const cursor: SearchCursor = {
      ...input,
      id: randomUUID(),
      created_at_ms: now,
      expires_at_ms: now + this.ttlMs,
    };
    this.entries.set(cursor.id, cursor);
    this.cleanup(now);
    this.enforceLimit();
    return cursor;
  }

  getSearchCursor(id: string): SearchCursor | null {
    const now = Date.now();
    this.cleanup(now);
    const cursor = this.entries.get(id);
    if (!cursor) {
      return null;
    }
    if (cursor.expires_at_ms <= now) {
      this.entries.delete(id);
      return null;
    }
    return cursor;
  }

  updateSearchCursor(id: string, offset: number): SearchCursor | null {
    const cursor = this.getSearchCursor(id);
    if (!cursor) {
      return null;
    }
    const updated: SearchCursor = { ...cursor, offset };
    this.entries.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  private cleanup(now: number): void {
    for (const [id, entry] of this.entries.entries()) {
      if (entry.expires_at_ms <= now) {
        this.entries.delete(id);
      }
    }
  }

  private enforceLimit(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    const sorted = [...this.entries.values()].sort((a, b) => a.created_at_ms - b.created_at_ms);
    const excess = sorted.length - this.maxEntries;
    for (let i = 0; i < excess; i += 1) {
      const entry = sorted[i];
      if (entry) {
        this.entries.delete(entry.id);
      }
    }
  }
}
