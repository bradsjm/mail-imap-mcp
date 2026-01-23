import { randomUUID } from 'node:crypto';

export type UidRange = Readonly<{
  min: number;
  max: number;
}>;

export type SearchCursor = Readonly<{
  id: string;
  tool: 'mail_imap_search_messages';
  account_id: string;
  mailbox: string;
  uidvalidity: number;
  uid_ranges: readonly UidRange[];
  offset: number;
  total: number;
  include_snippet: boolean;
  snippet_max_chars: number;
  created_at_ms: number;
  expires_at_ms: number;
}>;

export type CursorStoreOptions = Readonly<{
  ttl_ms: number;
  max_entries: number;
}>;

export function uidsToDescendingRanges(uidsDesc: readonly number[]): UidRange[] {
  if (uidsDesc.length === 0) {
    return [];
  }

  const ranges: UidRange[] = [];
  let currentMin = uidsDesc[0] ?? 0;
  let currentMax = currentMin;

  for (let index = 1; index < uidsDesc.length; index += 1) {
    const uid = uidsDesc[index];
    if (uid === undefined) {
      continue;
    }
    if (uid === currentMin - 1) {
      currentMin = uid;
      continue;
    }
    ranges.push({ min: currentMin, max: currentMax });
    currentMin = uid;
    currentMax = uid;
  }

  ranges.push({ min: currentMin, max: currentMax });
  return ranges;
}

export function totalFromRanges(ranges: readonly UidRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.max - range.min + 1), 0);
}

export function sliceUidsFromDescendingRanges(
  ranges: readonly UidRange[],
  offset: number,
  limit: number,
): number[] {
  if (limit <= 0) {
    return [];
  }
  if (offset < 0) {
    return [];
  }

  let remainingSkip = offset;
  const uids: number[] = [];

  for (const range of ranges) {
    const rangeCount = range.max - range.min + 1;
    if (remainingSkip >= rangeCount) {
      remainingSkip -= rangeCount;
      continue;
    }

    let uid = range.max - remainingSkip;
    remainingSkip = 0;
    while (uid >= range.min && uids.length < limit) {
      uids.push(uid);
      uid -= 1;
    }
    if (uids.length >= limit) {
      break;
    }
  }

  return uids;
}

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
